import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import type { PassOrigin } from './journal';
import { layoutOf, type DataLayout } from './layout';
import { openSessionStore, reconcileSession } from './reconcile';
import { realStorageFs } from './storage-fs';

// Сверка при запуске — по таблице плана M1 («Сверка при запуске»). Каждая строка таблицы —
// тест с тем же названием. Последняя строка («незакрытое задание») — шаг службы прохода (U17):
// файл незакрытых заданий сверка не трогает.

const SESSION = 'a1b2c3d4e5f60718';
const OTHER_SESSION = 'ffffffffffffffff';

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

type SegmentState = 'running' | 'completed' | 'interrupted';
const segment = (number: number, state: SegmentState, pageCount: number) => ({
  number,
  state,
  pageCount,
});
const pass = (number: number, segments: ReturnType<typeof segment>[], extra: object = {}) => ({
  number,
  accepted: false,
  origin: ORIGIN,
  nextSegment: Math.max(...segments.map((it) => it.number)) + 1,
  segments,
  ...extra,
});
const journalOf = (passes: ReturnType<typeof pass>[], extra: object = {}) => ({
  version: 1,
  sessionId: SESSION,
  nextPass: passes.length + 1,
  passes,
  deletions: [] as string[],
  ...extra,
});

const page = (number: number): Uint8Array => Uint8Array.of(0xff, 0xd8, number, 0xff, 0xd9);
const pageName = (passNumber: number, segmentNumber: number, index: number): string =>
  `p0${passNumber}-s0${segmentNumber}-${String(index).padStart(4, '0')}.jpg`;

async function seed(journal: unknown, pages: readonly string[] = []) {
  const root = await makeTempDataRoot();
  const layout = layoutOf(root);
  await mkdir(layout.pagesDir, { recursive: true });
  if (journal !== null) {
    await writeFile(
      layout.journalFile,
      typeof journal === 'string' || journal instanceof Uint8Array
        ? journal
        : JSON.stringify(journal),
    );
  }
  for (const [index, name] of pages.entries()) {
    await writeFile(join(layout.pagesDir, name), page(index + 1));
  }
  return { root, layout };
}

/** Проход 1, сегмент 1: файлы страниц с 1 по `count`. */
const pagesOfFirstSegment = (count: number): string[] =>
  Array.from({ length: count }, (_value, index) => pageName(1, 1, index + 1));

/** Каталог побайтово: путь → содержимое в hex; каталоги — отдельной отметкой. */
async function dirSnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const path = join(root, name);
    snapshot[name.replaceAll('\\', '/')] = (await stat(path)).isDirectory()
      ? '<каталог>'
      : (await readFile(path)).toString('hex');
  }
  return snapshot;
}

async function journalOnDisk(layout: DataLayout): Promise<ReturnType<typeof journalOf>> {
  return JSON.parse(await readFile(layout.journalFile, 'utf8')) as ReturnType<typeof journalOf>;
}

/** Сверка и то, что после неё видит интерфейс. */
async function reconciled(root: string) {
  const { store, notices } = await openSessionStore(root);
  const passes = store.snapshot()?.passes ?? [];
  return {
    store,
    notices,
    session: store.snapshot(),
    passes,
    keys: passes.flatMap((it) => it.pages.filter((one) => !one.lost).map((one) => one.key)),
    lost: passes.flatMap((it) => it.pages.filter((one) => one.lost).map((one) => one.key)),
  };
}

describe('сверка при запуске: таблица плана', () => {
  it('каталога сессии нет → сессии нет', async () => {
    const root = await makeTempDataRoot();

    const { session, notices, store } = await reconciled(root);

    expect(session).toBeNull();
    expect(notices).toEqual([]);
    expect(store.incompatible).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it('маркер версии новее понятного → ничего не трогается; режим отказа (AE9)', async () => {
    const { root } = await seed(
      { ...journalOf([pass(1, [segment(1, 'running', 2)])]), version: 2 },
      [...pagesOfFirstSegment(3)],
    );
    const before = await dirSnapshot(root);

    const { store, session } = await reconciled(root);

    expect(store.incompatible).toBe(true);
    expect(session).toBeNull();
    expect(await dirSnapshot(root)).toEqual(before);
    expect(await store.beginPass(ORIGIN)).toMatchObject({
      ok: false,
      error: { code: 'storageIncompatible' },
    });
    expect(await store.closeSession()).toMatchObject({ ok: false });
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('маркер новее понятного вместе с временными файлами, пометкой и закрываемым каталогом — всё побайтово на месте', async () => {
    const { root, layout } = await seed(
      {
        ...journalOf([pass(1, [segment(1, 'running', 1)])], { deletions: ['p01-s02-'] }),
        version: 3,
      },
      [pageName(1, 1, 1), pageName(1, 2, 1)],
    );
    await writeFile(join(layout.pagesDir, 'p01-s01-0002.jpg.0123456789ab.tmp'), page(2));
    await writeFile(join(layout.sessionDir, 'session.json.0123456789ab.tmp'), '{');
    await mkdir(join(root, `session.closing-${OTHER_SESSION}`, 'pages'), { recursive: true });
    await writeFile(
      join(root, `session.closing-${OTHER_SESSION}`, 'pages', pageName(1, 1, 1)),
      page(1),
    );
    await mkdir(join(layout.derivedDir, OTHER_SESSION, 'thumbs'), { recursive: true });
    const before = await dirSnapshot(root);

    const { store } = await reconciled(root);

    expect(store.incompatible).toBe(true);
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('журнал текущей версии с неизвестным полем и ошибкой типа в другом поле — каталог побайтово на месте, режим отказа', async () => {
    const { root } = await seed(
      { ...journalOf([pass(1, [segment(1, 'completed', 2)])]), nextPass: 'два', rotation: {} },
      pagesOfFirstSegment(2),
    );
    const before = await dirSnapshot(root);

    const { store } = await reconciled(root);

    expect(store.incompatible).toBe(true);
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('`session.closing-*` → очистка доводится до конца; новая сессия не создаётся', async () => {
    const root = await makeTempDataRoot();
    const closing = join(root, `session.closing-${OTHER_SESSION}`);
    await mkdir(join(closing, 'pages'), { recursive: true });
    await writeFile(join(closing, 'session.json'), JSON.stringify(journalOf([])));
    await writeFile(join(closing, 'pages', pageName(1, 1, 1)), page(1));
    await writeFile(join(closing, 'pages', pageName(1, 1, 2)), page(2));

    const { session } = await reconciled(root);

    expect(session).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it('`session.closing-*` → не удалось — запуск продолжается; посторонний файл оставляет каталог на месте', async () => {
    const { root } = await seed(journalOf([pass(1, [segment(1, 'completed', 1)])]), [
      pageName(1, 1, 1),
    ]);
    const closing = join(root, `session.closing-${OTHER_SESSION}`);
    await mkdir(join(closing, 'pages'), { recursive: true });
    await writeFile(join(closing, 'pages', pageName(1, 1, 1)), page(1));
    await writeFile(join(closing, 'pages', 'чужой.txt'), 'не наше');

    const { keys } = await reconciled(root);

    expect(keys).toEqual(['p01-s01-0001']);
    expect(await readdir(join(closing, 'pages'))).toEqual(['чужой.txt']);
  });

  it.each([
    ['файла нет при наличии страниц', null],
    ['файл пуст', ''],
    ['не JSON', '{ "version": 1, "sessionId": "a1b2'],
    ['не проходит схему текущей версии', JSON.stringify({ ...journalOf([]), nextPass: 'два' })],
  ])(
    'журнал не читается (%s) → файл отодвигается, сессия пересобирается по ключам, проходы прерваны',
    async (_title, content) => {
      const { root, layout } = await seed(content, [
        pageName(1, 1, 1),
        pageName(1, 1, 2),
        pageName(1, 1, 4),
        pageName(1, 3, 1),
        pageName(2, 1, 1),
      ]);

      const { notices, passes, keys, lost, store } = await reconciled(root);

      expect(notices).toContain('journalRebuilt');
      expect(passes.map((it) => [it.number, it.state, it.paramsKnown])).toEqual([
        [1, 'interrupted', false],
        [2, 'interrupted', false],
      ]);
      // Пропуск в нумерации стал потерянной страницей на своём месте.
      expect(passes[0]?.pages.map((it) => [it.key, it.number, it.lost])).toEqual([
        ['p01-s01-0001', 1, false],
        ['p01-s01-0002', 2, false],
        ['p01-s01-0003', 3, true],
        ['p01-s01-0004', 4, false],
        ['p01-s03-0001', 5, false],
      ]);
      expect(keys).toHaveLength(5);
      expect(lost).toEqual(['p01-s01-0003']);
      // Досканирование пересобранного прохода недоступно.
      expect(store.resumeTarget()).toMatchObject({
        ok: false,
        error: { code: 'sessionConflict', details: { reason: 'paramsUnknown' } },
      });
      // Счётчики — наибольший номер в именах файлов плюс один.
      const journal = await journalOnDisk(layout);
      expect(journal.nextPass).toBe(3);
      expect(journal.passes[0]?.nextSegment).toBe(4);
      expect(journal.sessionId).not.toBe(SESSION);

      const asides = (await readdir(layout.sessionDir)).filter((name) =>
        name.includes('unreadable'),
      );
      if (content === null) {
        expect(asides).toEqual([]);
      } else {
        expect(asides).toHaveLength(1);
        expect(await readFile(join(layout.sessionDir, asides[0] ?? ''), 'utf8')).toBe(content);
      }

      // Повторная сверка: журнал уже читается, уведомления нет, ничего не меняется.
      const before = await dirSnapshot(root);
      const second = await reconciled(root);
      expect(second.notices).not.toContain('journalRebuilt');
      expect(second.keys).toEqual(keys);
      expect(await dirSnapshot(root)).toEqual(before);
    },
  );

  it('сбой между отодвиганием журнала и записью нового — повторная сверка доводит', async () => {
    const { root, layout } = await seed('не журнал', pagesOfFirstSegment(3));
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (call.op === 'open' && call.path.includes('session.json')) {
        throw fsError('EIO');
      }
    });

    const first = await reconcileSession(root, { fs, retry: { ceilingMs: 0 } });

    expect(first.state.unsaved).toBe(true);
    expect(first.state.journal?.passes[0]?.segments[0]?.pageCount).toBe(3);
    expect((await readdir(layout.sessionDir)).filter((name) => name === 'session.json')).toEqual(
      [],
    );

    const { keys, notices } = await reconciled(root);
    expect(keys).toHaveLength(3);
    expect(notices).toContain('journalRebuilt');
    expect((await journalOnDisk(layout)).passes[0]?.segments[0]?.pageCount).toBe(3);
  });

  it('журнала нет, страниц нет → каталог убирается; отодвинутая копия журнала, если есть, остаётся', async () => {
    const empty = await seed(null);
    expect((await reconciled(empty.root)).session).toBeNull();
    expect(await readdir(empty.root)).toEqual([]);

    const withCopy = await seed(null);
    const copy = join(withCopy.layout.sessionDir, 'session.json.unreadable-0123456789ab');
    await writeFile(copy, 'старый журнал');
    expect((await reconciled(withCopy.root)).session).toBeNull();
    expect(await readFile(copy, 'utf8')).toBe('старый журнал');
    expect(await readdir(withCopy.layout.sessionDir)).toEqual([
      'session.json.unreadable-0123456789ab',
    ]);
  });

  it('пометка об удалении сегмента → удаление доводится до конца, страницы не возвращаются', async () => {
    const { root, layout } = await seed(
      journalOf([pass(1, [segment(1, 'interrupted', 2)], { nextSegment: 3 })], {
        deletions: ['p01-s02-'],
      }),
      [pageName(1, 1, 1), pageName(1, 1, 2), pageName(1, 2, 2), pageName(1, 2, 3)],
    );

    const { keys } = await reconciled(root);

    expect(keys).toEqual(['p01-s01-0001', 'p01-s01-0002']);
    expect(await readdir(layout.pagesDir)).toEqual([pageName(1, 1, 1), pageName(1, 1, 2)]);
    const journal = await journalOnDisk(layout);
    expect(journal.deletions).toEqual([]);
    expect(journal.passes[0]?.nextSegment).toBe(3);
  });

  it('пометка об удалении сегмента → неудаляемый файл оставляет пометку и не мешает запуску', async () => {
    const { root, layout } = await seed(
      journalOf([pass(1, [segment(1, 'interrupted', 1)], { nextSegment: 3 })], {
        deletions: ['p01-s02-'],
      }),
      [pageName(1, 1, 1), pageName(1, 2, 1), pageName(1, 2, 2)],
    );
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (call.op === 'unlink' && call.path.endsWith(pageName(1, 2, 2))) {
        throw fsError('EPERM');
      }
    });

    const { state } = await reconcileSession(root, { fs });

    expect(state.journal?.deletions).toEqual(['p01-s02-']);
    expect(state.journal?.passes[0]?.segments).toEqual([segment(1, 'interrupted', 1)]);
    expect(await readdir(layout.pagesDir)).toEqual([pageName(1, 1, 1), pageName(1, 2, 2)]);
    // Вторая сверка, уже без помехи, доводит удаление.
    expect((await reconciled(root)).keys).toEqual(['p01-s01-0001']);
    expect((await journalOnDisk(layout)).deletions).toEqual([]);
  });

  it('временный файл страницы или журнала → удаляется: страницей не считается', async () => {
    const { root, layout } = await seed(journalOf([pass(1, [segment(1, 'completed', 1)])]), [
      pageName(1, 1, 1),
    ]);
    await writeFile(join(layout.pagesDir, 'p01-s01-0002.jpg.0123456789ab.tmp'), page(2));
    await writeFile(join(layout.sessionDir, 'session.json.ba9876543210.tmp'), '{ "version": 1');

    const { keys, passes } = await reconciled(root);

    expect(keys).toEqual(['p01-s01-0001']);
    expect(passes[0]?.state).toBe('completed');
    expect(await readdir(layout.pagesDir)).toEqual([pageName(1, 1, 1)]);
    expect(await readdir(layout.sessionDir)).toEqual(['pages', 'session.json']);
  });

  it('страница без записи → возвращается в проход и сегмент по ключу (AE2: 17 файлов, 16 записей)', async () => {
    const { root, layout } = await seed(
      journalOf([pass(1, [segment(1, 'running', 16)])]),
      pagesOfFirstSegment(17),
    );

    const { keys, passes, lost } = await reconciled(root);

    expect(keys).toHaveLength(17);
    expect(lost).toEqual([]);
    expect(passes).toHaveLength(1);
    expect(passes[0]?.state).toBe('interrupted');
    expect(passes[0]?.paramsKnown).toBe(true);
    expect(passes[0]?.pages.at(-1)).toEqual({ key: 'p01-s01-0017', number: 17, lost: false });
    expect((await journalOnDisk(layout)).passes[0]?.segments).toEqual([
      segment(1, 'interrupted', 17),
    ]);
  });

  it('повторная сверка того же каталога не меняет ни журнал, ни файлы (AE2)', async () => {
    const { root } = await seed(
      journalOf([pass(1, [segment(1, 'running', 16)])]),
      pagesOfFirstSegment(17),
    );
    await reconciled(root);
    const before = await dirSnapshot(root);
    const { fs, calls } = interceptFs(realStorageFs);

    const { state } = await reconcileSession(root, { fs });

    expect(await dirSnapshot(root)).toEqual(before);
    expect(calls.filter((call) => !['readdir', 'readFile', 'size'].includes(call.op))).toEqual([]);
    expect(state.journal?.passes[0]?.segments).toEqual([segment(1, 'interrupted', 17)]);
    expect(state.unsaved).toBe(false);
  });

  it('страница, у прохода или сегмента которой нет записи → проход и сегмент создаются прерванными', async () => {
    const { root, layout } = await seed(journalOf([pass(1, [segment(1, 'completed', 2)])]), [
      pageName(1, 1, 1),
      pageName(1, 1, 2),
      pageName(1, 2, 1),
      pageName(2, 1, 1),
      pageName(2, 1, 2),
    ]);

    const { passes, store } = await reconciled(root);

    expect(passes.map((it) => [it.number, it.state, it.paramsKnown, it.pages.length])).toEqual([
      [1, 'interrupted', true, 3],
      [2, 'interrupted', false, 2],
    ]);
    const journal = await journalOnDisk(layout);
    expect(journal.nextPass).toBe(3);
    expect(journal.passes[0]?.segments).toEqual([
      segment(1, 'completed', 2),
      segment(2, 'interrupted', 1),
    ]);
    expect(journal.passes[0]?.nextSegment).toBe(3);
    expect(journal.passes[1]).toMatchObject({ origin: null, nextSegment: 2 });
    // Последний проход создан без параметров: досканировать его нельзя.
    expect(store.resumeTarget()).toMatchObject({ ok: false });
  });

  it('запись без файла → страница помечается потерянной, место сохраняется (AE8)', async () => {
    const { root, layout } = await seed(journalOf([pass(1, [segment(1, 'completed', 3)])]), [
      pageName(1, 1, 1),
      pageName(1, 1, 3),
    ]);
    const before = await dirSnapshot(root);

    const { passes, notices, store } = await reconciled(root);

    expect(passes[0]?.pages).toEqual([
      { key: 'p01-s01-0001', number: 1, lost: false },
      { key: 'p01-s01-0002', number: 2, lost: true },
      { key: 'p01-s01-0003', number: 3, lost: false },
    ]);
    expect(passes[0]?.state).toBe('completed');
    expect(notices).toEqual(['pagesLost']);
    expect(await store.readPage('p01-s01-0002')).toMatchObject({
      ok: false,
      error: { code: 'pageUnavailable', details: { reason: 'lost' } },
    });
    // Потеря видна по диску: журнал из-за неё не переписывается.
    expect(await dirSnapshot(root)).toEqual(before);
    expect((await journalOnDisk(layout)).passes[0]?.segments[0]?.pageCount).toBe(3);
  });

  it('файл нулевой длины → страница помечается потерянной, место сохраняется', async () => {
    const { root, layout } = await seed(
      journalOf([pass(1, [segment(1, 'running', 2)])]),
      pagesOfFirstSegment(2),
    );
    await writeFile(join(layout.pagesDir, pageName(1, 1, 2)), new Uint8Array(0));
    // Пустой файл без записи страницей не становится.
    await writeFile(join(layout.pagesDir, pageName(1, 1, 3)), new Uint8Array(0));

    const { keys, lost, passes } = await reconciled(root);

    expect(keys).toEqual(['p01-s01-0001']);
    expect(lost).toEqual(['p01-s01-0002']);
    expect(passes[0]?.pages).toHaveLength(2);
    // Пустой файл не удаляется: сверка его не трогает.
    expect(await readdir(layout.pagesDir)).toHaveLength(3);
  });

  it('сегмент или проход «идёт» → помечается прерванным; сегмент досканирования без страниц остаётся', async () => {
    const { root, layout } = await seed(
      journalOf([pass(1, [segment(1, 'interrupted', 2), segment(2, 'running', 0)])]),
      pagesOfFirstSegment(2),
    );

    const { passes, store } = await reconciled(root);

    expect(passes[0]?.state).toBe('interrupted');
    expect(passes[0]?.pages).toHaveLength(2);
    expect((await journalOnDisk(layout)).passes[0]?.segments).toEqual([
      segment(1, 'interrupted', 2),
      segment(2, 'interrupted', 0),
    ]);
    // Досканирование после перезапуска получает следующий номер сегмента.
    expect(await store.resumePass()).toMatchObject({ ok: true, value: { segment: 3 } });
  });

  it('все страницы потеряны → сессия остаётся: записи есть', async () => {
    const { root, layout } = await seed(journalOf([pass(1, [segment(1, 'completed', 2)])]));

    const { session, lost, keys } = await reconciled(root);

    expect(session?.id).toBe(SESSION);
    expect(lost).toEqual(['p01-s01-0001', 'p01-s01-0002']);
    expect(keys).toEqual([]);
    expect(await readdir(layout.sessionDir)).toEqual(['pages', 'session.json']);
  });

  it('ни файлов страниц, ни записей о страницах → каталог убирается: пустая сессия равна отсутствию', async () => {
    // Падение между записью начала сегмента и первой страницей.
    const { root } = await seed(journalOf([pass(1, [segment(1, 'running', 0)])]));

    const { session } = await reconciled(root);

    expect(session).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it('производный кэш чужой сессии → удаляется; кэш текущей остаётся', async () => {
    const { root, layout } = await seed(journalOf([pass(1, [segment(1, 'completed', 1)])]), [
      pageName(1, 1, 1),
    ]);
    for (const id of [SESSION, OTHER_SESSION]) {
      await mkdir(join(layout.derivedDir, id, 'thumbs'), { recursive: true });
      await writeFile(join(layout.derivedDir, id, 'thumbs', pageName(1, 1, 1)), page(1));
    }

    await reconciled(root);

    expect(await readdir(layout.derivedDir)).toEqual([SESSION]);
    expect(await readdir(join(layout.derivedDir, SESSION, 'thumbs'))).toEqual([pageName(1, 1, 1)]);
  });

  it('производный кэш без сессии → удаляется целиком', async () => {
    const root = await makeTempDataRoot();
    const layout = layoutOf(root);
    await mkdir(join(layout.derivedDir, OTHER_SESSION, 'thumbs'), { recursive: true });

    await reconciled(root);

    expect(await readdir(layout.derivedDir)).toEqual([]);
  });
});

describe('сверка при запуске: сбой на каждом шаге записи хранилища', () => {
  const READS = new Set(['readdir', 'readFile', 'size', 'freeBytes']);

  // «Процесс убит» на шаге N: этот и все следующие изменения диска не выполняются.
  function dyingFs(dieAt: number) {
    let step = 0;
    let dead = false;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (dead) {
        throw fsError('ECRASH');
      }
      if (!READS.has(call.op)) {
        step += 1;
        if (step === dieAt) {
          dead = true;
          throw fsError('ECRASH');
        }
      }
    });
    return { fs, steps: () => step, dead: () => dead };
  }

  async function* body(number: number): AsyncGenerator<Uint8Array> {
    await Promise.resolve();
    yield page(number);
  }

  interface Outcome {
    /** Страницы, приём которых подтверждён и которые никто не удалял. */
    readonly kept: Set<string>;
    /** Страницы сегмента, удаление которого подтверждено. */
    readonly discarded: Set<string>;
    /** Страницы сегмента, удаление которого началось, но не подтверждено: все или ни одной. */
    readonly limbo: Set<string>;
    closing: boolean;
  }

  // Сценарий: проход, обрыв, досканирование, «Остановить», новое досканирование, «Новая пачка».
  async function scenario(root: string, fs: typeof realStorageFs): Promise<Outcome> {
    const outcome: Outcome = {
      kept: new Set(),
      discarded: new Set(),
      limbo: new Set(),
      closing: false,
    };
    const { store } = await openSessionStore(root, { fs, retry: { ceilingMs: 0 } });
    const must = <T>(result: { ok: true; value: T } | { ok: false }): T => {
      if (!result.ok) {
        throw new Error('операция отклонена');
      }
      return result.value;
    };
    let content = 0;
    const accept = async (count: number, into: Set<string> = outcome.kept): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        content += 1;
        into.add((await store.acceptPage(body(content))).key);
      }
    };

    try {
      must(await store.beginPass(ORIGIN));
      await accept(3);
      must(await store.endSegment('interrupted'));

      must(await store.resumePass());
      const stopped = new Set<string>();
      await accept(2, stopped);
      stopped.forEach((key) => outcome.limbo.add(key));
      must(await store.discardSegment());
      outcome.limbo.clear();
      stopped.forEach((key) => outcome.discarded.add(key));

      must(await store.resumePass());
      await accept(2);
      must(await store.endSegment('completed'));

      outcome.closing = true;
      must(await store.closeSession());
    } catch {
      // Процесс «убит»: дальше — только сверка.
    }
    return outcome;
  }

  it('после каждого сбоя сверка проводится дважды: полученное не потеряно, удалённое не вернулось, второй прогон ничего не меняет', async () => {
    const dryRoot = await makeTempDataRoot();
    const dry = dyingFs(Number.POSITIVE_INFINITY);
    await scenario(dryRoot, dry.fs);
    const total = dry.steps();
    expect(total).toBeGreaterThan(60);

    for (let dieAt = 1; dieAt <= total; dieAt += 1) {
      const root = await makeTempDataRoot();
      const dying = dyingFs(dieAt);
      const outcome = await scenario(root, dying.fs);
      expect(dying.dead(), `шаг ${dieAt}`).toBe(true);

      const first = await reconciled(root);
      const afterFirst = await dirSnapshot(root);
      const second = await reconciled(root);

      expect(await dirSnapshot(root), `шаг ${dieAt}: второй прогон`).toEqual(afterFirst);
      expect(second.keys, `шаг ${dieAt}: второй прогон`).toEqual(first.keys);
      expect(second.lost, `шаг ${dieAt}`).toEqual([]);

      const present = new Set(first.keys);
      if (outcome.closing) {
        // «Новая пачка» оборвана: сессия либо цела, либо её нет — половины не бывает.
        if (present.size > 0) {
          expect(
            [...outcome.kept].every((key) => present.has(key)),
            `шаг ${dieAt}`,
          ).toBe(true);
        }
      } else {
        for (const key of outcome.kept) {
          expect(present.has(key), `шаг ${dieAt}: страница ${key} потеряна`).toBe(true);
        }
      }
      for (const key of outcome.discarded) {
        expect(present.has(key), `шаг ${dieAt}: страница ${key} вернулась`).toBe(false);
      }
      const limbo = [...outcome.limbo].filter((key) => present.has(key));
      expect([0, outcome.limbo.size], `шаг ${dieAt}: удаление наполовину`).toContain(limbo.length);
    }
  }, 120_000);
});
