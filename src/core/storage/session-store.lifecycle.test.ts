import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS } from '@shared';
import { fsError, interceptFs, type FsCall } from '../../../test/support/intercept-fs';
import { body, ok, ORIGIN, page, SESSION, setup } from '../../../test/support/session-store';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { JOURNAL_VERSION, parseJournal, type Journal, type PassOrigin } from './journal';
import { layoutOf } from './layout';
import { createSessionStore, NO_SESSION } from './session-store';
import { realStorageFs } from './storage-fs';

describe('хранилище сессии: закрытие', () => {
  it('закрытие сессии переименовывает каталог и очищает его; посторонний файл не удаляется', async () => {
    const { store, root, layout, calls, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
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
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);
    ok(await store.endSegment('completed'));
    ok(await store.closeSession());

    expect(ok(await store.beginPass(ORIGIN, null))).toMatchObject({ pass: 1, segment: 1 });

    expect(store.snapshot()?.id).toBe('2222222222222222');
    expect(await readdir(root)).toEqual(['session']);
  });

  it('закрытие с неудавшимся переименованием каталога оставляет сессию рабочей', async () => {
    const { store, layout, pageFiles, accept } = await setup((call) => {
      if (call.op === 'rename' && call.to?.includes('session.closing-') === true) {
        throw fsError('EBUSY');
      }
    });
    ok(await store.beginPass(ORIGIN, null));
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
    ok(await store.beginPass(ORIGIN, null));
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
    ok(await store.beginPass(ORIGIN, null));
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
    ok(await store.beginPass(ORIGIN, null));

    // Страниц нет — защищать нечего: для вызывающего сессии больше нет.
    expect(await store.discardSegment()).toEqual({ ok: true, value: { sessionClosed: true } });

    expect(store.snapshot()).toBeNull();
    expect(store.resumeTarget()).toMatchObject(noSession);
    expect(await store.resumePass()).toMatchObject(noSession);
    expect(await store.acceptPass()).toMatchObject(noSession);
    // Следующий проход — первый, а не второй после пустого.
    expect(ok(await store.beginPass(ORIGIN, null))).toMatchObject({ pass: 1, segment: 1 });
    expect(store.snapshot()?.passes.map((pass) => pass.number)).toEqual([1]);
    expect((await journalOnDisk()).passes).toHaveLength(1);
  });

  it('исход сегмента без единой страницы не оставляет прохода-призрака', async () => {
    const { store, journalOnDisk, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    ok(await store.endSegment('interrupted'));

    expect(store.snapshot()).toBeNull();
    expect(store.resumeTarget()).toMatchObject(noSession);

    expect(ok(await store.beginPass(ORIGIN, null))).toMatchObject({ pass: 1, segment: 1 });
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
      version: JOURNAL_VERSION,
      edits: EMPTY_EDITS,
      assembled: null,
      blankMode: 'keep',
      straighten: 'off',
      sessionId: SESSION,
      nextPass: 2,
      passes: [
        {
          number: 1,
          accepted: false,
          origin: ORIGIN,
          nextSegment: 3,
          segments: [{ number: 1, state: 'interrupted', pageCount: 0 }],
          kind: 'fronts',
          after: null,
          pair: null,
          backsDecision: null,
          rotate180: false,
        },
      ],
      deletions: ['p01-s02-'],
      backsDeclined: false,
      saved: false,
    };
    const store = createSessionStore(root, { ...NO_SESSION, journal }, { retry: { ceilingMs: 0 } });

    expect(store.snapshot()).toBeNull();
    expect(ok(await store.beginPass(ORIGIN, null))).toMatchObject({ pass: 2, segment: 1 });

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
    ok(await store.beginPass(ORIGIN, null));
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

    expect(await store.beginPass(withExtra, null)).toMatchObject({
      ok: false,
      error: { code: 'storageFailed', details: { reason: 'schema' } },
    });

    expect(store.snapshot()).toBeNull();
    expect(await readdir(join(root, 'session'))).toEqual(['pages']);
  });
});

describe('хранилище сессии: потолки счётчиков', () => {
  const journalWith = (overrides: Partial<Journal>, pageCount = 0, nextSegment = 2): Journal => ({
    version: JOURNAL_VERSION,
    edits: EMPTY_EDITS,
    assembled: null,
    blankMode: 'keep',
    straighten: 'off',
    sessionId: SESSION,
    nextPass: 2,
    passes: [
      {
        number: 1,
        accepted: false,
        origin: ORIGIN,
        nextSegment,
        segments: [{ number: nextSegment - 1, state: 'running', pageCount }],
        kind: 'fronts',
        after: null,
        pair: null,
        backsDecision: null,
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

    expect(ok(await store.beginPass(ORIGIN, null))).toMatchObject({ pass: 99 });
    ok(await store.acceptPage(body(page(1))).then((value) => ({ ok: true as const, value })));
    ok(await store.endSegment('completed'));
    expect(await store.beginPass(ORIGIN, null)).toMatchObject({
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
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);
    ok(await store.endSegment('interrupted'));
    ok(await store.resumePass());
    await accept(2, 3);
    const thumbs = join(layout.derivedDir, SESSION, 'thumbs');
    await mkdir(thumbs, { recursive: true });
    for (const name of ['p01-s01-0001.jpg', 'p01-s02-0001.jpg', 'p01-s02-0002.jpg']) {
      await writeFile(join(thumbs, name), page(7));
    }
    // Производное выравнивания (M6, R26) чистится по тому же префиксу.
    const derived = {
      skew: ['p01-s01-0001.json', 'p01-s02-0001.json'],
      straight: [
        'p01-s01-0001.v1.jpg',
        'p01-s01-0001.v1.json',
        'p01-s02-0002.v1.jpg',
        'p01-s02-0002.v1.json',
      ],
      'straight-thumbs': ['p01-s01-0001.v1.jpg', 'p01-s02-0001.v1.jpg'],
    };
    for (const [dir, names] of Object.entries(derived)) {
      await mkdir(join(layout.derivedDir, SESSION, dir), { recursive: true });
      for (const name of names) {
        await writeFile(join(layout.derivedDir, SESSION, dir, name), page(7));
      }
    }

    ok(await store.discardSegment());

    expect(await readdir(thumbs)).toEqual(['p01-s01-0001.jpg']);
    expect(await readdir(join(layout.derivedDir, SESSION, 'skew'))).toEqual(['p01-s01-0001.json']);
    expect((await readdir(join(layout.derivedDir, SESSION, 'straight'))).sort()).toEqual([
      'p01-s01-0001.v1.jpg',
      'p01-s01-0001.v1.json',
    ]);
    expect(await readdir(join(layout.derivedDir, SESSION, 'straight-thumbs'))).toEqual([
      'p01-s01-0001.v1.jpg',
    ]);
  });
});

describe('хранилище сессии: нечитаемый журнал, который сверка не сохранила в стороне', () => {
  const JOURNAL: Journal = {
    blankMode: 'keep',
    straighten: 'off',
    version: JOURNAL_VERSION,
    edits: EMPTY_EDITS,
    assembled: null,
    sessionId: SESSION,
    nextPass: 2,
    passes: [
      {
        number: 1,
        accepted: false,
        origin: null,
        nextSegment: 2,
        segments: [{ number: 1, state: 'interrupted', pageCount: 1 }],
        kind: 'fronts',
        after: null,
        pair: null,
        backsDecision: null,
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

describe('хранилище сессии: оценки пустых страниц отброшенного сегмента (M4, R7)', () => {
  it('удаление сегмента чистит его оценки и не трогает остальные', async () => {
    const { store, layout, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 1);
    ok(await store.endSegment('interrupted'));
    ok(await store.resumePass());
    await accept(2, 3);
    const blank = join(layout.derivedDir, SESSION, 'blank');
    await mkdir(blank, { recursive: true });
    for (const name of ['p01-s01-0001.json', 'p01-s02-0001.json', 'p01-s02-0002.json']) {
      await writeFile(join(blank, name), '{"v":1,"ratio":0}');
    }

    ok(await store.discardSegment());

    expect(await readdir(blank)).toEqual(['p01-s01-0001.json']);
  });
});
