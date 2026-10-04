import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fsError, interceptFs, type FsCall } from '../../../test/support/intercept-fs';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { parseJournal, type Journal, type PassOrigin } from './journal';
import { layoutOf } from './layout';
import { createSessionStore, NO_SESSION, type SessionStoreOptions } from './session-store';
import { realStorageFs, StorageError } from './storage-fs';

const SESSION = 'a1b2c3d4e5f60718';

const ORIGIN: PassOrigin = {
  scanner: {
    scheme: 'https',
    host: 'scanner.test',
    port: 443,
    basePath: '/eSCL',
    fingerprint: 'ab'.repeat(32),
    uuid: '00000000-0000-4000-8000-000000000001',
    name: 'Test Scanner',
  },
  params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
  pixelLimit: 5100 * 8400,
};

// Содержимое страницы хранилищу безразлично: маркеры JPEG проверяет задание (U10).
const page = (number: number): Uint8Array => Uint8Array.of(0xff, 0xd8, number, number, 0xff, 0xd9);

async function* body(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

const ok = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) {
    throw new Error(`ожидался успех: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

async function setup(before?: (call: FsCall) => void, options: SessionStoreOptions = {}) {
  const root = await makeTempDataRoot();
  const layout = layoutOf(root);
  const { fs, calls } = interceptFs(realStorageFs, before);
  const store = createSessionStore(root, undefined, {
    fs,
    newSessionId: () => SESSION,
    retry: { ceilingMs: 0 },
    ...options,
  });

  const pageFiles = async (): Promise<string[]> =>
    (await readdir(layout.pagesDir).catch(() => [])).sort();
  const journalOnDisk = async (): Promise<Journal> => {
    const parsed = parseJournal(await readFile(layout.journalFile));
    if (parsed.kind !== 'ok') {
      throw new Error(`журнал на диске не читается: ${parsed.kind}`);
    }
    return parsed.value;
  };
  /** Принимает страницы с номерами содержимого `from…to` в идущий сегмент. */
  const accept = async (from: number, to: number): Promise<void> => {
    for (let number = from; number <= to; number += 1) {
      await store.acceptPage(body(page(number)));
    }
  };
  return { root, layout, store, calls, pageFiles, journalOnDisk, accept };
}

const isJournalRename = (call: FsCall): boolean =>
  call.op === 'rename' && call.to?.endsWith('session.json') === true;

describe('хранилище сессии: проход', () => {
  it('проход на N страниц даёт N файлов с ключами по порядку и журнал «завершён»', async () => {
    const { store, layout, pageFiles, journalOnDisk, accept } = await setup();

    const start = ok(await store.beginPass(ORIGIN));
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
        rotate180: false,
      },
    ]);
    expect(store.snapshot()).toEqual({
      id: SESSION,
      backsDeclined: false,
      saved: false,
      passes: [
        {
          number: 1,
          state: 'completed',
          paramsKnown: true,
          scanner: { name: 'Test Scanner', scheme: 'https', host: 'scanner.test', port: 443 },
          rotate180: false,
          pages: [
            { key: 'p01-s01-0001', number: 1, lost: false },
            { key: 'p01-s01-0002', number: 2, lost: false },
            { key: 'p01-s01-0003', number: 3, lost: false },
          ],
        },
      ],
    });
  });

  it('начало сегмента записано в журнал до первой страницы: сегмент «идёт»', async () => {
    const { store, journalOnDisk, pageFiles } = await setup();

    ok(await store.beginPass(ORIGIN));

    expect((await journalOnDisk()).passes[0]?.segments).toEqual([
      { number: 1, state: 'running', pageCount: 0 },
    ]);
    expect(await pageFiles()).toEqual([]);
    expect(store.snapshot()?.passes[0]?.state).toBe('running');
  });

  it('порядок записи страницы: файл переименован раньше, чем переписан журнал', async () => {
    const { store, calls } = await setup();
    ok(await store.beginPass(ORIGIN));
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
    ok(await store.beginPass(ORIGIN));
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
    ok(await store.beginPass(ORIGIN));
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
    ok(await store.beginPass(ORIGIN));
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
    ok(await store.beginPass(ORIGIN));
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
    ok(await store.beginPass(ORIGIN));
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
    ok(await store.beginPass(ORIGIN));
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
      ok(await store.beginPass(ORIGIN));
      await accept(1, pages);

      expect(ok(await store.discardSegment())).toEqual({ sessionClosed: true });

      expect(store.snapshot()).toBeNull();
      expect(await readdir(root)).toEqual([]);
    }
  });

  it('пометка об удалении записана до удаления файлов и снята после', async () => {
    const { store, calls, accept } = await setup();
    ok(await store.beginPass(ORIGIN));
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
    ok(await store.beginPass(ORIGIN));
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
    ok(await store.beginPass(ORIGIN));
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
    ok(await store.beginPass(ORIGIN));
    await accept(1, 1);
    ok(await store.endSegment('interrupted'));
    await writeFile(join(layout.pagesDir, 'p01-s02-0005.jpg'), page(9));

    expect(ok(await store.resumePass())).toMatchObject({ segment: 3 });
  });

  it('«оставить как есть»: прерванный проход принят и больше не досканируется', async () => {
    const { store, journalOnDisk, accept } = await setup();
    ok(await store.beginPass(ORIGIN));
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
    ok(await store.beginPass(ORIGIN));
    await accept(1, 1);

    for (const result of [
      await store.closeSession(),
      await store.acceptPass(),
      await store.beginPass(ORIGIN),
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
    ok(await store.beginPass(ORIGIN));
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
      await store.beginPass(ORIGIN),
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

    expect(await store.beginPass(ORIGIN)).toMatchObject({
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

    expect(await store.beginPass(ORIGIN)).toMatchObject({
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
    ok(await store.beginPass(ORIGIN));
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
    ok(await store.beginPass(ORIGIN));
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
    ok(await store.beginPass(ORIGIN));

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
    ok(await store.beginPass(ORIGIN));
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
    ok(await store.beginPass(ORIGIN));
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

describe('хранилище сессии: закрытие', () => {
  it('закрытие сессии переименовывает каталог и очищает его; посторонний файл не удаляется', async () => {
    const { store, root, layout, calls, accept } = await setup();
    ok(await store.beginPass(ORIGIN));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    await writeFile(join(layout.sessionDir, 'заметки.txt'), 'не наше');
    await mkdir(join(layout.derivedDir, SESSION, 'thumbs'), { recursive: true });
    await writeFile(join(layout.derivedDir, SESSION, 'thumbs', 'p01-s01-0001.jpg'), page(1));
    calls.length = 0;

    ok(await store.closeSession());

    // Первое изменение на диске — переименование каталога целиком.
    const firstChange = calls.find((call) => !['readdir', 'readFile', 'size'].includes(call.op));
    expect(firstChange).toMatchObject({ op: 'rename', path: layout.sessionDir });
    expect(store.snapshot()).toBeNull();
    expect(await readdir(root)).toEqual(['derived', `session.closing-${SESSION}`]);
    expect(await readdir(join(root, `session.closing-${SESSION}`))).toEqual(['заметки.txt']);
    expect(await readdir(layout.derivedDir)).toEqual([]);
    expect(await store.readPage('p01-s01-0001')).toMatchObject({ ok: false });
  });

  it('после закрытия новая сессия получает новый идентификатор и начинает с первого прохода', async () => {
    const ids = ['1111111111111111', '2222222222222222'];
    const { store, root, accept } = await setup(undefined, {
      newSessionId: () => ids.shift() ?? 'ffffffffffffffff',
    });
    ok(await store.beginPass(ORIGIN));
    await accept(1, 1);
    ok(await store.endSegment('completed'));
    ok(await store.closeSession());

    expect(ok(await store.beginPass(ORIGIN))).toMatchObject({ pass: 1, segment: 1 });

    expect(store.snapshot()?.id).toBe('2222222222222222');
    expect(await readdir(root)).toEqual(['session']);
  });

  it('закрытие с неудавшимся переименованием каталога оставляет сессию рабочей', async () => {
    const { store, layout, pageFiles, accept } = await setup((call) => {
      if (call.op === 'rename' && call.to?.includes('session.closing-') === true) {
        throw fsError('EBUSY');
      }
    });
    ok(await store.beginPass(ORIGIN));
    await accept(1, 2);
    ok(await store.endSegment('completed'));

    expect(await store.closeSession()).toMatchObject({
      ok: false,
      error: { code: 'sessionCloseFailed', details: { reason: 'EBUSY' } },
    });

    expect(await pageFiles()).toHaveLength(2);
    expect(store.snapshot()?.passes[0]?.pages).toHaveLength(2);
    expect(ok(await store.readPage('p01-s01-0001'))).toEqual(page(1));
    expect(await readdir(layout.root)).toEqual(['session']);
  });

  it('«Остановить» в первом сегменте при неудавшемся закрытии каталога — проход прерван, страницы целы', async () => {
    const { store, pageFiles, journalOnDisk, accept } = await setup((call) => {
      if (call.op === 'rename' && call.to?.includes('session.closing-') === true) {
        throw fsError('EPERM');
      }
    });
    ok(await store.beginPass(ORIGIN));
    await accept(1, 2);

    expect(await store.discardSegment()).toMatchObject({
      ok: false,
      error: { code: 'sessionCloseFailed' },
    });

    expect(await pageFiles()).toHaveLength(2);
    expect((await journalOnDisk()).passes[0]?.segments).toEqual([
      { number: 1, state: 'interrupted', pageCount: 2 },
    ]);
  });

  it('закрытие дожидается идущего чтения страницы', async () => {
    let releaseRead = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const order: string[] = [];
    const fs = {
      ...realStorageFs,
      readFile: async (path: string) => {
        if (path.endsWith('.jpg')) {
          await gate;
          order.push('read');
        }
        return realStorageFs.readFile(path);
      },
      rename: (from: string, to: string) => {
        if (to.includes('session.closing-')) {
          order.push('rename');
        }
        return realStorageFs.rename(from, to);
      },
    };
    const { store, accept } = await setup(undefined, { fs });
    ok(await store.beginPass(ORIGIN));
    await accept(1, 1);
    ok(await store.endSegment('completed'));

    const reading = store.readPage('p01-s01-0001');
    const closing = store.closeSession();
    await new Promise((resolve) => setImmediate(resolve));
    // Пока идёт закрытие, новые чтения не начинаются.
    await expect(store.readPage('p01-s01-0001')).resolves.toMatchObject({ ok: false });
    releaseRead();

    expect(ok(await reading)).toEqual(page(1));
    ok(await closing);
    expect(order).toEqual(['read', 'rename']);
  });
});

describe('хранилище сессии: пустая сессия равна отсутствию сессии', () => {
  const noSession = {
    ok: false,
    error: { code: 'sessionConflict', details: { reason: 'noSession' } },
  };

  it('«Остановить» без страниц при отказе закрытия каталога не оставляет прохода-призрака', async () => {
    const { store, journalOnDisk } = await setup((call) => {
      if (call.op === 'rename' && call.to?.includes('session.closing-') === true) {
        throw fsError('EPERM');
      }
    });
    ok(await store.beginPass(ORIGIN));

    // Страниц нет — защищать нечего: для вызывающего сессии больше нет.
    expect(await store.discardSegment()).toEqual({ ok: true, value: { sessionClosed: true } });

    expect(store.snapshot()).toBeNull();
    expect(store.resumeTarget()).toMatchObject(noSession);
    expect(await store.resumePass()).toMatchObject(noSession);
    expect(await store.acceptPass()).toMatchObject(noSession);
    // Следующий проход — первый, а не второй после пустого.
    expect(ok(await store.beginPass(ORIGIN))).toMatchObject({ pass: 1, segment: 1 });
    expect(store.snapshot()?.passes.map((pass) => pass.number)).toEqual([1]);
    expect((await journalOnDisk()).passes).toHaveLength(1);
  });

  it('исход сегмента без единой страницы не оставляет прохода-призрака', async () => {
    const { store, journalOnDisk, accept } = await setup();
    ok(await store.beginPass(ORIGIN));
    ok(await store.endSegment('interrupted'));

    expect(store.snapshot()).toBeNull();
    expect(store.resumeTarget()).toMatchObject(noSession);

    expect(ok(await store.beginPass(ORIGIN))).toMatchObject({ pass: 1, segment: 1 });
    await accept(1, 1);
    expect(store.snapshot()?.passes.map((pass) => [pass.number, pass.pages.length])).toEqual([
      [1, 1],
    ]);
    expect((await journalOnDisk()).passes).toHaveLength(1);
  });

  it('пустой журнал с пометкой об удалении пометку и счётчики сохраняет', async () => {
    const root = await makeTempDataRoot();
    const layout = layoutOf(root);
    await mkdir(layout.pagesDir, { recursive: true });
    await writeFile(join(layout.pagesDir, 'p01-s02-0001.jpg'), page(9));
    const journal: Journal = {
      version: 2,
      sessionId: SESSION,
      nextPass: 2,
      passes: [
        {
          number: 1,
          accepted: false,
          origin: ORIGIN,
          nextSegment: 3,
          segments: [{ number: 1, state: 'interrupted', pageCount: 0 }],
          rotate180: false,
        },
      ],
      deletions: ['p01-s02-'],
      backsDeclined: false,
      saved: false,
    };
    const store = createSessionStore(root, { ...NO_SESSION, journal }, { retry: { ceilingMs: 0 } });

    expect(store.snapshot()).toBeNull();
    expect(ok(await store.beginPass(ORIGIN))).toMatchObject({ pass: 2, segment: 1 });

    const parsed = parseJournal(await readFile(layout.journalFile));
    if (parsed.kind !== 'ok') {
      throw new Error('журнал не читается');
    }
    expect(parsed.value.sessionId).toBe(SESSION);
    expect(parsed.value.deletions).toEqual(['p01-s02-']);
    expect(parsed.value.passes.map((pass) => pass.number)).toEqual([2]);
  });
});

describe('хранилище сессии: досканирование без каталога страниц', () => {
  it('досканирование создаёт каталог страниц, если его нет', async () => {
    const { store, layout, pageFiles, accept } = await setup();
    ok(await store.beginPass(ORIGIN));
    await accept(1, 2);
    ok(await store.endSegment('interrupted'));
    await realStorageFs.removeTree(layout.pagesDir);

    ok(await store.resumePass());
    const accepted = await store.acceptPage(body(page(3)));

    expect(accepted).toMatchObject({ key: 'p01-s02-0001', number: 3 });
    expect(await pageFiles()).toEqual(['p01-s02-0001.jpg']);
  });
});

describe('хранилище сессии: запись проверяется схемой журнала', () => {
  it('данные, которые не прошли бы чтение, не записываются: старт отклонён', async () => {
    const { store, root } = await setup();
    const withExtra = {
      ...ORIGIN,
      params: { ...ORIGIN.params, duplex: true },
    } as unknown as PassOrigin;

    expect(await store.beginPass(withExtra)).toMatchObject({
      ok: false,
      error: { code: 'storageFailed', details: { reason: 'schema' } },
    });

    expect(store.snapshot()).toBeNull();
    expect(await readdir(join(root, 'session'))).toEqual(['pages']);
  });
});

describe('хранилище сессии: потолки счётчиков', () => {
  const journalWith = (overrides: Partial<Journal>, pageCount = 0, nextSegment = 2): Journal => ({
    version: 2,
    sessionId: SESSION,
    nextPass: 2,
    passes: [
      {
        number: 1,
        accepted: false,
        origin: ORIGIN,
        nextSegment,
        segments: [{ number: nextSegment - 1, state: 'running', pageCount }],
        rotate180: false,
      },
    ],
    deletions: [],
    backsDeclined: false,
    saved: false,
    ...overrides,
  });

  async function storeWith(journal: Journal) {
    const root = await makeTempDataRoot();
    const layout = layoutOf(root);
    await mkdir(layout.pagesDir, { recursive: true });
    const store = createSessionStore(root, { ...NO_SESSION, journal }, { retry: { ceilingMs: 0 } });
    return { store, layout };
  }

  it('страница 9999 принимается, 10000-я — отказ без файла', async () => {
    const { store, layout } = await storeWith(journalWith({}, 9998));

    expect(await store.acceptPage(body(page(1)))).toMatchObject({ key: 'p01-s01-9999' });
    await expect(store.acceptPage(body(page(2)))).rejects.toMatchObject({
      failure: { code: 'storageFailed', details: { reason: 'pageLimit' } },
    });

    expect(await readdir(layout.pagesDir)).toEqual(['p01-s01-9999.jpg']);
  });

  it('проход 99 начинается, сотый — отказ', async () => {
    const base = journalWith({ nextPass: 99 });
    const { store } = await storeWith({
      ...base,
      passes: base.passes.map((pass) => ({
        ...pass,
        number: 98,
        segments: [{ number: 1, state: 'completed' as const, pageCount: 1 }],
      })),
    });

    expect(ok(await store.beginPass(ORIGIN))).toMatchObject({ pass: 99 });
    ok(await store.acceptPage(body(page(1))).then((value) => ({ ok: true as const, value })));
    ok(await store.endSegment('completed'));
    expect(await store.beginPass(ORIGIN)).toMatchObject({
      ok: false,
      error: { code: 'storageFailed', details: { reason: 'passLimit' } },
    });
  });

  it('сегмент 99 начинается, сотый — отказ', async () => {
    const base = journalWith({}, 1, 99);
    const { store } = await storeWith({
      ...base,
      passes: base.passes.map((pass) => ({
        ...pass,
        segments: [{ number: 98, state: 'interrupted' as const, pageCount: 1 }],
      })),
    });

    expect(ok(await store.resumePass())).toMatchObject({ segment: 99 });
    ok(await store.endSegment('interrupted'));
    expect(await store.resumePass()).toMatchObject({
      ok: false,
      error: { code: 'storageFailed', details: { reason: 'segmentLimit' } },
    });
  });
});

describe('хранилище сессии: миниатюры отброшенного сегмента', () => {
  it('удаление сегмента чистит его миниатюры и не трогает остальные', async () => {
    const { store, layout, accept } = await setup();
    ok(await store.beginPass(ORIGIN));
    await accept(1, 1);
    ok(await store.endSegment('interrupted'));
    ok(await store.resumePass());
    await accept(2, 3);
    const thumbs = join(layout.derivedDir, SESSION, 'thumbs');
    await mkdir(thumbs, { recursive: true });
    for (const name of ['p01-s01-0001.jpg', 'p01-s02-0001.jpg', 'p01-s02-0002.jpg']) {
      await writeFile(join(thumbs, name), page(7));
    }

    ok(await store.discardSegment());

    expect(await readdir(thumbs)).toEqual(['p01-s01-0001.jpg']);
  });
});

describe('хранилище сессии: нечитаемый журнал, который сверка не сохранила в стороне', () => {
  const JOURNAL: Journal = {
    version: 2,
    sessionId: SESSION,
    nextPass: 2,
    passes: [
      {
        number: 1,
        accepted: false,
        origin: null,
        nextSegment: 2,
        segments: [{ number: 1, state: 'interrupted', pageCount: 1 }],
        rotate180: false,
      },
    ],
    deletions: [],
    backsDeclined: false,
    saved: false,
  };

  async function seeded(before?: (call: FsCall) => void) {
    const root = await makeTempDataRoot();
    const layout = layoutOf(root);
    await mkdir(layout.pagesDir, { recursive: true });
    await writeFile(layout.journalFile, 'не журнал');
    await writeFile(join(layout.pagesDir, 'p01-s01-0001.jpg'), page(1));
    const { fs } = interceptFs(realStorageFs, before);
    const store = createSessionStore(
      root,
      { ...NO_SESSION, journal: JOURNAL, unsaved: true, unpreserved: true },
      { fs, retry: { ceilingMs: 0 } },
    );
    return { store, layout };
  }

  it('первая запись сначала отодвигает прежний файл', async () => {
    const { store, layout } = await seeded();

    ok(await store.flush());

    const names = await readdir(layout.sessionDir);
    const aside = names.find((name) => name.includes('.unreadable-')) ?? '';
    expect(await readFile(join(layout.sessionDir, aside), 'utf8')).toBe('не журнал');
    expect(parseJournal(await readFile(layout.journalFile))).toMatchObject({ kind: 'ok' });
    expect(store.unsaved()).toBe(false);
  });

  it('не отодвинулся — запись не делается, прежний файл цел', async () => {
    const { store, layout } = await seeded((call) => {
      if (call.op === 'rename' && call.to?.includes('.unreadable-') === true) {
        throw fsError('EBUSY');
      }
    });

    expect(await store.flush()).toMatchObject({ ok: false, error: { code: 'storageFailed' } });
    expect(await store.acceptPass()).toMatchObject({ ok: false });

    expect(await readFile(layout.journalFile, 'utf8')).toBe('не журнал');
    expect(store.unsaved()).toBe(true);
    expect(store.snapshot()?.passes[0]?.state).toBe('interrupted');
  });
});

describe('хранилище сессии: флаги журнала v2 (M2, U1)', () => {
  /** Две полных прохода: лицевые (2 стр.) и обороты (2 стр.). */
  async function twoPasses() {
    const context = await setup();
    const { store, accept } = context;
    ok(await store.beginPass(ORIGIN));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    ok(await store.beginPass(ORIGIN));
    await accept(3, 4);
    ok(await store.endSegment('completed'));
    return context;
  }

  it('setRotateBacks ставит флаг на проход оборотов, идемпотентен, переживает запись', async () => {
    const { store, journalOnDisk } = await twoPasses();

    ok(await store.setRotateBacks(true));
    ok(await store.setRotateBacks(true));

    expect(store.snapshot()?.passes.map((pass) => pass.rotate180)).toEqual([false, true]);
    expect((await journalOnDisk()).passes.map((pass) => pass.rotate180)).toEqual([false, true]);

    ok(await store.setRotateBacks(false));
    expect(store.snapshot()?.passes.map((pass) => pass.rotate180)).toEqual([false, false]);
  });

  it('setRotateBacks без прохода оборотов — noBacksPass; без сессии — noSession', async () => {
    const { store, accept } = await setup();

    expect(await store.setRotateBacks(true)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noSession' } },
    });

    ok(await store.beginPass(ORIGIN));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    expect(await store.setRotateBacks(true)).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noBacksPass' } },
    });
  });

  it('роль оборотов — позиция среди уцелевших: после остановки флаг ложится на проход №3', async () => {
    const { store, accept } = await setup();
    ok(await store.beginPass(ORIGIN));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    // Проход оборотов №2 остановлен на первом сегменте: исчезает целиком, номер не переиспользуется.
    ok(await store.beginPass(ORIGIN));
    await accept(3, 3);
    expect(ok(await store.discardSegment())).toEqual({ sessionClosed: false });
    expect(ok(await store.beginPass(ORIGIN))).toMatchObject({ pass: 3 });
    await accept(4, 5);
    ok(await store.endSegment('completed'));

    ok(await store.setRotateBacks(true));

    const passes = store.snapshot()?.passes ?? [];
    expect(passes.map((pass) => [pass.number, pass.rotate180])).toEqual([
      [1, false],
      [3, true],
    ]);
  });

  it('declineBacks durable и идемпотентен; с отсканированными оборотами — backsPresent', async () => {
    const { store, accept, journalOnDisk } = await setup();
    ok(await store.beginPass(ORIGIN));
    await accept(1, 2);
    ok(await store.endSegment('completed'));

    ok(await store.declineBacks());
    ok(await store.declineBacks());

    expect(store.snapshot()?.backsDeclined).toBe(true);
    expect((await journalOnDisk()).backsDeclined).toBe(true);

    const second = await twoPasses();
    expect(await second.store.declineBacks()).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'backsPresent' } },
    });
  });

  it('markSaved ставит отметку; новая страница и смена поворота её снимают (KTD-7)', async () => {
    const { store, accept, journalOnDisk } = await twoPasses();

    ok(await store.markSaved());
    expect(store.snapshot()?.saved).toBe(true);
    expect((await journalOnDisk()).saved).toBe(true);

    // «Сохранил → включил тумблер» — индикация несохранённого возвращается (AE12).
    ok(await store.setRotateBacks(true));
    expect(store.snapshot()?.saved).toBe(false);

    ok(await store.markSaved());
    ok(await store.beginPass(ORIGIN));
    await accept(5, 5);
    expect(store.snapshot()?.saved).toBe(false);
  });

  it('удаление идущего сегмента со страницами снимает отметку о сохранении', async () => {
    const { store, accept } = await twoPasses();
    ok(await store.beginPass(ORIGIN));
    await accept(5, 5);
    ok(await store.markSaved());

    ok(await store.discardSegment());

    expect(store.snapshot()?.saved).toBe(false);
  });

  it('новая сессия не наследует флаги закрытой', async () => {
    const { store, accept } = await twoPasses();
    ok(await store.setRotateBacks(true));
    ok(await store.markSaved());
    ok(await store.closeSession());

    ok(await store.beginPass(ORIGIN));
    await accept(1, 1);

    expect(store.snapshot()).toMatchObject({ backsDeclined: false, saved: false });
    expect(store.snapshot()?.passes.map((pass) => pass.rotate180)).toEqual([false]);
  });
});
