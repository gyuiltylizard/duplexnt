import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS } from '@shared';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import {
  body,
  isJournalRename,
  ok,
  ORIGIN,
  page,
  SESSION,
  setup,
} from '../../../test/support/session-store';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { createSessionStore, NO_SESSION } from './session-store';
import { realStorageFs, StorageError } from './storage-fs';

describe('хранилище сессии: проход', () => {
  it('проход на N страниц даёт N файлов с ключами по порядку и журнал «завершён»', async () => {
    const { store, layout, pageFiles, journalOnDisk, accept } = await setup();

    const start = ok(await store.beginPass(ORIGIN, null));
    expect(start).toMatchObject({ pass: 1, segment: 1, firstPageNumber: 1 });
    await accept(1, 3);
    ok(await store.endSegment('completed'));

    expect(await pageFiles()).toEqual(['p01-s01-0001.jpg', 'p01-s01-0002.jpg', 'p01-s01-0003.jpg']);
    for (let number = 1; number <= 3; number += 1) {
      const bytes = await readFile(join(layout.pagesDir, `p01-s01-000${number}.jpg`));
      expect(new Uint8Array(bytes)).toEqual(page(number));
    }
    const journal = await journalOnDisk();
    expect(journal.sessionId).toBe(SESSION);
    expect(journal.passes).toEqual([
      {
        number: 1,
        accepted: false,
        origin: ORIGIN,
        nextSegment: 2,
        segments: [{ number: 1, state: 'completed', pageCount: 3 }],
        kind: 'fronts',
        after: null,
        pair: null,
        backsDecision: null,
        rotate180: false,
      },
    ]);
    expect(store.snapshot()).toEqual({
      id: SESSION,
      backsDeclined: false,
      blankMode: 'keep',
      straighten: 'off',
      saved: false,
      passes: [
        {
          number: 1,
          state: 'completed',
          paramsKnown: true,
          scanner: { name: 'Test Scanner', scheme: 'https', host: 'scanner.test', port: 443 },
          kind: 'fronts',
          after: null,
          pair: null,
          backsDecision: null,
          rotate180: false,
          pages: [
            { key: 'p01-s01-0001', number: 1, lost: false },
            { key: 'p01-s01-0002', number: 2, lost: false },
            { key: 'p01-s01-0003', number: 3, lost: false },
          ],
        },
      ],
      edits: EMPTY_EDITS,
      assembled: null,
    });
  });

  it('начало сегмента записано в журнал до первой страницы: сегмент «идёт»', async () => {
    const { store, journalOnDisk, pageFiles } = await setup();

    ok(await store.beginPass(ORIGIN, null));

    expect((await journalOnDisk()).passes[0]?.segments).toEqual([
      { number: 1, state: 'running', pageCount: 0 },
    ]);
    expect(await pageFiles()).toEqual([]);
    expect(store.snapshot()?.passes[0]?.state).toBe('running');
  });

  it('порядок записи страницы: файл переименован раньше, чем переписан журнал', async () => {
    const { store, calls } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    calls.length = 0;

    await store.acceptPage(body(page(1)));

    const renames = calls.filter((call) => call.op === 'rename').map((call) => call.to);
    expect(renames).toHaveLength(2);
    expect(renames[0]).toMatch(/p01-s01-0001\.jpg$/);
    expect(renames[1]).toMatch(/session\.json$/);
    // Страница сброшена на диск до переименования.
    const pageSync = calls.findIndex((call) => call.op === 'sync');
    const pageRename = calls.findIndex((call) => call.op === 'rename');
    expect(pageSync).toBeGreaterThan(-1);
    expect(pageSync).toBeLessThan(pageRename);
  });

  it('файл страницы после записи не меняется: дальнейшие операции его не трогают', async () => {
    const { store, calls, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);
    calls.length = 0;

    await accept(2, 3);
    ok(await store.endSegment('interrupted'));
    ok(await store.resumePass());
    await accept(4, 4);
    ok(await store.endSegment('completed'));

    const touched = calls.filter(
      (call) => call.op !== 'readdir' && `${call.path}|${call.to ?? ''}`.includes('p01-s01-0001'),
    );
    expect(touched).toEqual([]);
  });

  it('страница отдаётся в буфер по ключу; чужой ключ и мусор — отказ', async () => {
    const { store, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);

    expect(ok(await store.readPage('p01-s01-0002'))).toEqual(page(2));
    expect(store.pageInfo('p01-s01-0002')).toEqual({
      sessionId: SESSION,
      pixelLimit: 5100 * 8400,
      dpi: 300,
    });
    for (const key of ['p01-s01-0003', 'p02-s01-0001', '../session.json', 'p01-s01-0001.jpg', '']) {
      expect(await store.readPage(key)).toMatchObject({
        ok: false,
        error: { code: 'pageUnavailable', details: { reason: 'unknown' } },
      });
      expect(store.pageInfo(key)).toBeNull();
    }
  });

  it('страница, файл которой исчез, становится потерянной и сохраняет место', async () => {
    const { store, layout, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 3);
    ok(await store.endSegment('completed'));
    await realStorageFs.unlink(join(layout.pagesDir, 'p01-s01-0002.jpg'));

    expect(await store.readPage('p01-s01-0002')).toMatchObject({
      ok: false,
      error: { code: 'pageUnavailable', details: { reason: 'lost' } },
    });
    expect(store.snapshot()?.passes[0]?.pages.map((it) => [it.number, it.lost])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
    expect(store.pageInfo('p01-s01-0002')).toBeNull();
  });
});

describe('хранилище сессии: досканирование и «Остановить»', () => {
  it('досканирование начинает второй сегмент с номером в проходе N+1', async () => {
    const { store, pageFiles, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('interrupted'));

    expect(ok(store.resumeTarget())).toEqual(ORIGIN);
    const start = ok(await store.resumePass());
    expect(start).toMatchObject({ pass: 1, segment: 2, firstPageNumber: 3, origin: ORIGIN });
    const accepted = await store.acceptPage(body(page(3)));
    ok(await store.endSegment('completed'));

    expect(accepted).toMatchObject({ key: 'p01-s02-0001', number: 3 });
    expect(await pageFiles()).toEqual(['p01-s01-0001.jpg', 'p01-s01-0002.jpg', 'p01-s02-0001.jpg']);
    expect(store.snapshot()?.passes[0]).toMatchObject({ state: 'completed' });
    expect(store.snapshot()?.passes[0]?.pages.map((it) => it.number)).toEqual([1, 2, 3]);
  });

  it('удаление идущего сегмента при досканировании оставляет страницы первого', async () => {
    const { store, pageFiles, journalOnDisk, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('interrupted'));
    ok(await store.resumePass());
    await accept(3, 4);

    expect(ok(await store.discardSegment())).toEqual({ sessionClosed: false });

    expect(await pageFiles()).toEqual(['p01-s01-0001.jpg', 'p01-s01-0002.jpg']);
    const journal = await journalOnDisk();
    expect(journal.deletions).toEqual([]);
    expect(journal.passes[0]?.segments).toEqual([
      { number: 1, state: 'interrupted', pageCount: 2 },
    ]);
    expect(store.snapshot()?.passes[0]?.state).toBe('interrupted');
  });

  it('досканирование после «Остановить» получает третий номер сегмента, а не второй', async () => {
    const { store, pageFiles, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);
    ok(await store.endSegment('interrupted'));
    ok(await store.resumePass());
    await accept(2, 2);
    ok(await store.discardSegment());

    const start = ok(await store.resumePass());
    await accept(3, 3);

    expect(start).toMatchObject({ segment: 3, firstPageNumber: 2 });
    expect(await pageFiles()).toEqual(['p01-s01-0001.jpg', 'p01-s03-0001.jpg']);
  });

  it('удаление единственного сегмента убирает сессию целиком — и без страниц, и со страницами', async () => {
    for (const pages of [0, 2]) {
      const { store, root, accept } = await setup();
      ok(await store.beginPass(ORIGIN, null));
      await accept(1, pages);

      expect(ok(await store.discardSegment())).toEqual({ sessionClosed: true });

      expect(store.snapshot()).toBeNull();
      expect(await readdir(root)).toEqual([]);
    }
  });

  it('пометка об удалении записана до удаления файлов и снята после', async () => {
    const { store, calls, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);
    ok(await store.endSegment('interrupted'));
    ok(await store.resumePass());
    await accept(2, 2);
    calls.length = 0;

    ok(await store.discardSegment());

    const steps = calls
      .filter((call) => call.op === 'unlink' || isJournalRename(call))
      .map((call) => (call.op === 'unlink' ? 'unlink' : 'journal'));
    expect(steps).toEqual(['journal', 'unlink', 'journal']);
  });

  it('пометка об удалении не записалась — ни один файл не удалён, сегмент прерван', async () => {
    let failing = false;
    const { store, pageFiles, accept } = await setup((call) => {
      if (failing && isJournalRename(call)) {
        throw fsError('EIO');
      }
    });
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);
    ok(await store.endSegment('interrupted'));
    ok(await store.resumePass());
    await accept(2, 3);
    failing = true;

    expect(await store.discardSegment()).toMatchObject({
      ok: false,
      error: { code: 'storageFailed', details: { reason: 'EIO' } },
    });

    expect(await pageFiles()).toHaveLength(3);
    expect(store.snapshot()?.passes[0]?.state).toBe('interrupted');
    expect(store.snapshot()?.passes[0]?.pages).toHaveLength(3);
  });

  it('неудаляемый файл оставляет пометку, страницы сегмента обратно не принимаются', async () => {
    const { store, journalOnDisk, pageFiles, accept } = await setup((call) => {
      if (call.op === 'unlink' && call.path.endsWith('p01-s02-0001.jpg')) {
        throw fsError('EPERM');
      }
    });
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);
    ok(await store.endSegment('interrupted'));
    ok(await store.resumePass());
    await accept(2, 3);

    ok(await store.discardSegment());

    expect((await journalOnDisk()).deletions).toEqual(['p01-s02-']);
    expect(await pageFiles()).toEqual(['p01-s01-0001.jpg', 'p01-s02-0001.jpg']);
    expect(store.snapshot()?.passes[0]?.pages.map((it) => it.key)).toEqual(['p01-s01-0001']);
    // Следующий сегмент не начинается на префиксе с пометкой.
    expect(ok(await store.resumePass())).toMatchObject({ segment: 3 });
  });

  it('сегмент не начинается на префиксе, под которым уже лежат файлы', async () => {
    const { store, layout, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);
    ok(await store.endSegment('interrupted'));
    await writeFile(join(layout.pagesDir, 'p01-s02-0005.jpg'), page(9));

    expect(ok(await store.resumePass())).toMatchObject({ segment: 3 });
  });

  it('«оставить как есть»: прерванный проход принят и больше не досканируется', async () => {
    const { store, journalOnDisk, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('interrupted'));

    ok(await store.acceptPass());

    expect(store.snapshot()?.passes[0]?.state).toBe('accepted');
    expect((await journalOnDisk()).passes[0]?.accepted).toBe(true);
    for (const result of [
      store.resumeTarget(),
      await store.resumePass(),
      await store.acceptPass(),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'sessionConflict', details: { reason: 'notInterrupted' } },
      });
    }
  });
});

describe('хранилище сессии: недопустимое в текущем состоянии', () => {
  it('закрытие сессии, «оставить как есть» и второй старт при идущем сегменте отклоняются', async () => {
    const { store, pageFiles, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);

    for (const result of [
      await store.closeSession(),
      await store.acceptPass(),
      await store.beginPass(ORIGIN, null),
      await store.resumePass(),
    ]) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'sessionConflict', details: { reason: 'passRunning' } },
      });
    }
    expect(await pageFiles()).toEqual(['p01-s01-0001.jpg']);
    expect(store.snapshot()?.passes[0]?.state).toBe('running');
  });

  it('страница, завершение и «Остановить» без идущего сегмента отклоняются и ничего не удаляют', async () => {
    const { store, pageFiles, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('interrupted'));

    const conflict = { code: 'sessionConflict', details: { reason: 'noRunningPass' } };
    expect(await store.discardSegment()).toMatchObject({ ok: false, error: conflict });
    expect(await store.endSegment('completed')).toMatchObject({ ok: false, error: conflict });
    await expect(store.acceptPage(body(page(3)))).rejects.toMatchObject({ failure: conflict });
    expect(await pageFiles()).toHaveLength(2);
  });

  it('хранилище в режиме отказа отклоняет каждую изменяющую операцию', async () => {
    const root = await makeTempDataRoot();
    const { fs, calls } = interceptFs(realStorageFs);
    const store = createSessionStore(root, { ...NO_SESSION, incompatible: true }, { fs });

    const refusal = { code: 'storageIncompatible' };
    for (const result of [
      await store.beginPass(ORIGIN, null),
      await store.resumePass(),
      await store.endSegment('completed'),
      await store.discardSegment(),
      await store.acceptPass(),
      await store.closeSession(),
      await store.flush(),
    ]) {
      expect(result).toMatchObject({ ok: false, error: refusal });
    }
    await expect(store.acceptPage(body(page(1)))).rejects.toMatchObject({ failure: refusal });
    expect(store.incompatible).toBe(true);
    expect(store.snapshot()).toBeNull();
    // Ни одного обращения к диску: каталог данных не тронут.
    expect(calls).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it('нехватка места перед проходом — отказ без записи', async () => {
    const { store, root } = await setup(undefined, {
      fs: { ...realStorageFs, freeBytes: () => Promise.resolve(10 * 1024 * 1024) },
    });

    expect(await store.beginPass(ORIGIN, null)).toMatchObject({
      ok: false,
      error: { code: 'storageFull' },
    });
    expect(store.snapshot()).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });
});

describe('хранилище сессии: сбои записи', () => {
  it('начало сегмента не записалось — сегмента нет, старт отклонён', async () => {
    const { store } = await setup((call) => {
      if (isJournalRename(call)) {
        throw fsError('ENOSPC');
      }
    });

    expect(await store.beginPass(ORIGIN, null)).toMatchObject({
      ok: false,
      error: { code: 'storageFull' },
    });
    expect(store.snapshot()).toBeNull();
    await expect(store.acceptPage(body(page(1)))).rejects.toBeInstanceOf(StorageError);
  });

  it('ошибка записи страницы оставляет сегмент прерванным, прежние страницы целы', async () => {
    let failing = false;
    const { store, pageFiles, journalOnDisk, accept } = await setup((call) => {
      if (failing && call.op === 'write') {
        throw fsError('ENOSPC');
      }
    });
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    failing = true;

    await expect(store.acceptPage(body(page(3)))).rejects.toMatchObject({
      failure: { code: 'storageFull' },
    });
    failing = false;
    ok(await store.endSegment('interrupted'));

    expect(await pageFiles()).toEqual(['p01-s01-0001.jpg', 'p01-s01-0002.jpg']);
    expect((await journalOnDisk()).passes[0]?.segments).toEqual([
      { number: 1, state: 'interrupted', pageCount: 2 },
    ]);
  });

  it('ошибка источника страницы пробрасывается как есть, файла с конечным именем нет', async () => {
    const { store, pageFiles } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    const cause = new Error('соединение оборвано');
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield page(1);
      await Promise.resolve();
      throw cause;
    }

    await expect(store.acceptPage(broken())).rejects.toBe(cause);

    expect(await pageFiles()).toEqual([]);
    expect(store.snapshot()?.passes[0]?.pages).toEqual([]);
  });

  it('пустое тело страницей не становится', async () => {
    const { store, pageFiles } = await setup();
    ok(await store.beginPass(ORIGIN, null));

    await expect(store.acceptPage(body())).rejects.toBeInstanceOf(StorageError);
    await expect(store.acceptPage(body(new Uint8Array(0)))).rejects.toBeInstanceOf(StorageError);

    expect(await pageFiles()).toEqual([]);
  });

  it('журнал не записался после переименования страницы — состояние несохранённое, следующая перезапись его доводит', async () => {
    let failing = false;
    const { store, pageFiles, journalOnDisk } = await setup((call) => {
      if (failing && isJournalRename(call)) {
        throw fsError('EIO');
      }
    });
    ok(await store.beginPass(ORIGIN, null));
    failing = true;

    const accepted = await store.acceptPage(body(page(1)));

    expect(accepted).toMatchObject({ key: 'p01-s01-0001', number: 1 });
    expect(store.unsaved()).toBe(true);
    expect(await pageFiles()).toEqual(['p01-s01-0001.jpg']);
    expect((await journalOnDisk()).passes[0]?.segments[0]?.pageCount).toBe(0);
    expect(store.snapshot()?.passes[0]?.pages).toHaveLength(1);

    failing = false;
    await store.acceptPage(body(page(2)));

    expect(store.unsaved()).toBe(false);
    expect((await journalOnDisk()).passes[0]?.segments[0]?.pageCount).toBe(2);
  });

  it('несохранённое состояние доводит и явная перезапись', async () => {
    let failing = false;
    const { store, journalOnDisk, accept } = await setup((call) => {
      if (failing && isJournalRename(call)) {
        throw fsError('EIO');
      }
    });
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);
    failing = true;
    ok(await store.endSegment('completed'));
    expect(store.unsaved()).toBe(true);
    expect(await store.flush()).toMatchObject({ ok: false, error: { code: 'storageFailed' } });

    failing = false;
    ok(await store.flush());

    expect(store.unsaved()).toBe(false);
    expect((await journalOnDisk()).passes[0]?.segments[0]?.state).toBe('completed');
  });
});
