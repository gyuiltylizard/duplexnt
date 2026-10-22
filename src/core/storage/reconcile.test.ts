import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS, type SessionEdits } from '@shared';
import { dirSnapshot } from '../../../test/support/dir-snapshot';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import type { PassOrigin } from './journal';
import { layoutOf, type DataLayout } from './layout';
import { rolesOf } from '../../../test/support/session-store';
import { openSessionStore, reconcileSession } from './reconcile';
import { createSessionStore } from './session-store';
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
  kind: number === 1 ? 'fronts' : 'backs',
  after: null,
  rotate180: false,
  ...extra,
});
const journalOf = (passes: ReturnType<typeof pass>[], extra: object = {}) => ({
  version: 6,
  sessionId: SESSION,
  nextPass: passes.length + 1,
  passes,
  deletions: [] as string[],
  backsDeclined: false,
  saved: false,
  edits: EMPTY_EDITS,
  assembled: null as readonly string[] | null,
  blankMode: 'keep' as const,
  ...extra,
});
function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const dropped: readonly string[] = keys as readonly string[];
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !dropped.includes(key)),
  ) as Omit<T, K>;
}

/** Журнал версии 4 (M3.5): тот же состав без записи сборки и границы наборов. */
const journalV4Of = (passes: ReturnType<typeof pass>[], extra: object = {}) => ({
  ...omit(journalOf(passes, extra), 'assembled', 'blankMode'),
  version: 4,
  edits: omit(EMPTY_EDITS, 'divider', 'notBlank'),
});

/** Журнал версии 3 (M3): тот же состав, роль прохода — по позиции, якоря нет. */
const journalV3Of = (passes: ReturnType<typeof pass>[], extra: object = {}) => ({
  ...journalV4Of(passes, extra),
  version: 3,
  passes: passes.map((one) => omit(one, 'kind', 'after')),
});

/** Журнал версии 2 (M2): тот же состав без правок редактора. */
const journalV2Of = (passes: ReturnType<typeof pass>[], extra: object = {}) => ({
  ...omit(journalV3Of(passes, extra), 'edits'),
  version: 2,
});

/** Журнал версии 1 (M1): тот же состав без полей v2–v4. */
const journalV1Of = (passes: ReturnType<typeof pass>[], extra: object = {}) => ({
  ...omit(journalV3Of(passes, extra), 'backsDeclined', 'saved', 'edits'),
  version: 1,
  passes: passes.map((one) => omit(one, 'rotate180', 'kind', 'after')),
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
      { ...journalOf([pass(1, [segment(1, 'running', 2)])]), version: 7 },
      [...pagesOfFirstSegment(3)],
    );
    const before = await dirSnapshot(root);

    const { store, session } = await reconciled(root);

    expect(store.incompatible).toBe(true);
    expect(session).toBeNull();
    expect(await dirSnapshot(root)).toEqual(before);
    expect(await store.beginPass(ORIGIN, null)).toMatchObject({
      ok: false,
      error: { code: 'storageIncompatible' },
    });
    expect(await store.closeSession()).toMatchObject({ ok: false });
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('журнал версии 1 читается и переписывается текущей версией; флаги — дефолты (M2, R13)', async () => {
    const { root, layout } = await seed(
      journalV1Of([pass(1, [segment(1, 'completed', 2)])]),
      pagesOfFirstSegment(2),
    );

    const { session, notices } = await reconciled(root);

    expect(notices).toEqual([]);
    expect(session).toMatchObject({ backsDeclined: false, saved: false });
    expect(session?.passes[0]).toMatchObject({ rotate180: false, kind: 'fronts', after: null });
    const journal = await journalOnDisk(layout);
    expect(journal.version).toBe(6);
    expect(journal).toMatchObject({
      backsDeclined: false,
      saved: false,
      edits: EMPTY_EDITS,
      assembled: null,
    });
    expect(journal.passes[0]).toMatchObject({ rotate180: false, kind: 'fronts', after: null });

    // Повторный прогон уже ничего не меняет: сверка идемпотентна.
    const before = await dirSnapshot(root);
    await reconciled(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('журнал версии 2 переписывается текущей версией: правок нет, флаги целы (M3, R2)', async () => {
    const { root, layout } = await seed(
      journalV2Of([pass(1, [segment(1, 'completed', 2)])], { saved: true }),
      pagesOfFirstSegment(2),
    );

    const { session } = await reconciled(root);

    expect(session).toMatchObject({ saved: true, edits: EMPTY_EDITS });
    const journal = await journalOnDisk(layout);
    expect(journal).toMatchObject({ version: 6, saved: true, edits: EMPTY_EDITS });

    const before = await dirSnapshot(root);
    await reconciled(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('журнал версии 4 переписывается текущей версией: сборки нет, граница авто (M3.6, R1)', async () => {
    const { root, layout } = await seed(
      journalV4Of([pass(1, [segment(1, 'completed', 2)])], { saved: true }),
      pagesOfFirstSegment(2),
    );

    const { session } = await reconciled(root);

    expect(session).toMatchObject({ saved: true, edits: EMPTY_EDITS, assembled: null });
    const journal = await journalOnDisk(layout);
    expect(journal).toMatchObject({ version: 6, saved: true, edits: EMPTY_EDITS, assembled: null });

    const before = await dirSnapshot(root);
    await reconciled(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('журнал версии 3 переписывается текущей версией: роль — по позиции, якоря `null`, флаг поворота цел (M3.5, R1)', async () => {
    const { root, layout } = await seed(
      journalV3Of([
        pass(1, [segment(1, 'completed', 2)]),
        pass(2, [segment(1, 'completed', 2)], { rotate180: true }),
        pass(3, [segment(1, 'completed', 1)]),
      ]),
      [...pagesOfFirstSegment(2), pageName(2, 1, 1), pageName(2, 1, 2), pageName(3, 1, 1)],
    );

    const { session, notices } = await reconciled(root);

    expect(notices).toEqual([]);
    expect(rolesOf(session?.passes ?? [])).toEqual([
      [1, 'fronts', null],
      [2, 'backs', null],
      [3, 'added', null],
    ]);
    const journal = await journalOnDisk(layout);
    expect(journal.version).toBe(6);
    expect(rolesOf(journal.passes)).toEqual(rolesOf(session?.passes ?? []));
    expect(journal.passes[1]).toMatchObject({ rotate180: true });

    const before = await dirSnapshot(root);
    await reconciled(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('добавленный набор с якорем переживает перезапуск-сверку дословно (M3.5, R1)', async () => {
    const { root } = await seed(
      journalOf([
        pass(1, [segment(1, 'completed', 2)]),
        pass(2, [segment(1, 'completed', 2)]),
        pass(3, [segment(1, 'completed', 1)], { kind: 'added', after: 'p01-s01-0001' }),
      ]),
      [...pagesOfFirstSegment(2), pageName(2, 1, 1), pageName(2, 1, 2), pageName(3, 1, 1)],
    );
    const before = await dirSnapshot(root);

    const { session } = await reconciled(root);

    expect(session?.passes[2]).toMatchObject({ kind: 'added', after: 'p01-s01-0001' });
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('усыновление страниц снимает отметку о сохранении: PDF больше не соответствует набору', async () => {
    // Сбой после записи файла страницы, но до записи журнала: на диске saved:true и файл
    // сверх pageCount.
    const { root, layout } = await seed(
      journalOf([pass(1, [segment(1, 'completed', 2)])], { saved: true }),
      [...pagesOfFirstSegment(2), pageName(1, 1, 3)],
    );

    const { session } = await reconciled(root);

    expect(session?.saved).toBe(false);
    expect(session?.passes[0]?.pages).toHaveLength(3);
    expect((await journalOnDisk(layout)).saved).toBe(false);

    // Повторный прогон ничего не меняет: сверка идемпотентна.
    const before = await dirSnapshot(root);
    await reconciled(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('флаги и правки переживают перезапуск-сверку, журнал не переписывается (M2, R13; M3, AE1)', async () => {
    const edits: SessionEdits = {
      order: ['p02-s01-0001', 'p01-s01-0001'],
      rotations: { 'p01-s01-0001': 90 },
      deleted: [],
      cuts: [1],
      names: ['', 'Оборот'],
      divider: null,
      notBlank: [],
    };
    const { root } = await seed(
      journalOf([pass(1, [segment(1, 'completed', 1)]), pass(2, [segment(1, 'completed', 1)])], {
        nextPass: 3,
        saved: true,
        edits,
        passes: [
          pass(1, [segment(1, 'completed', 1)]),
          pass(2, [segment(1, 'completed', 1)], { rotate180: true }),
        ],
      }),
      [pageName(1, 1, 1), pageName(2, 1, 1)],
    );
    const before = await dirSnapshot(root);

    const { session } = await reconciled(root);

    expect(session).toMatchObject({ saved: true, backsDeclined: false, edits });
    expect(session?.passes.map((it) => it.rotate180)).toEqual([false, true]);
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('правки с ключами без страниц вычищаются и журнал переписывается; повтор ничего не меняет (M3, R5)', async () => {
    const { root, layout } = await seed(
      journalOf([pass(1, [segment(1, 'completed', 2)])], {
        edits: {
          order: ['p01-s01-0002', 'p07-s01-0001'],
          rotations: { 'p07-s01-0001': 90, 'p01-s01-0001': 270 },
          deleted: ['p07-s01-0002'],
          cuts: [],
          names: ['Договор'],
          divider: null,
          notBlank: [],
        },
      }),
      pagesOfFirstSegment(2),
    );

    const { session } = await reconciled(root);

    const expected: SessionEdits = {
      order: ['p01-s01-0002'],
      rotations: { 'p01-s01-0001': 270 },
      deleted: [],
      cuts: [],
      names: ['Договор'],
      divider: null,
      notBlank: [],
    };
    expect(session?.edits).toEqual(expected);
    expect((await journalOnDisk(layout)).edits).toEqual(expected);

    const before = await dirSnapshot(root);
    await reconciled(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('усыновлённый оборот лёг в ленту — граница наборов переехала вслед за страницами (KTD-10; M3.6, R9)', async () => {
    // Лицевые 3, обороты: в журнале 1 (оборот листа 3), на диске 2 — сбой до записи журнала.
    // Проходы не сошлись — режим раздельных наборов: лента f1 f2 f3 | b1, граница вручную
    // сдвинута в конец (b1 перенесён к лицам).
    const { root } = await seed(
      journalOf([pass(1, [segment(1, 'completed', 3)]), pass(2, [segment(1, 'interrupted', 1)])], {
        nextPass: 3,
        edits: { ...EMPTY_EDITS, divider: 4 },
      }),
      [...pagesOfFirstSegment(3), pageName(2, 1, 1), pageName(2, 1, 2)],
    );

    const { session } = await reconciled(root);

    // Лента f1 f2 f3 b2 b1: граница в конце ленты остаётся в конце.
    expect(session?.edits).toMatchObject({ divider: 5, cuts: [], names: [''] });
  });

  it('маркер новее понятного вместе с временными файлами, пометкой и закрываемым каталогом — всё побайтово на месте', async () => {
    const { root, layout } = await seed(
      {
        ...journalOf([pass(1, [segment(1, 'running', 1)])], { deletions: ['p01-s02-'] }),
        version: 7,
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
      // Пересобранный журнал — режим «оставлять»: параметры сессии неизвестны (M4, R8).
      expect(store.snapshot()?.blankMode).toBe('keep');
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

  it('усыновлённый проход без записи получает роль по очереди: обороты, при отказе от оборотов — добавленный (M3.5, R6)', async () => {
    const files = [pageName(1, 1, 1), pageName(1, 1, 2), pageName(2, 1, 1)];
    const roles = async (journal: unknown) => {
      const { root, layout } = await seed(journal, files);
      const { session } = await reconciled(root);
      const onDisk = await journalOnDisk(layout);
      expect(rolesOf(onDisk.passes)).toEqual(rolesOf(session?.passes ?? []));
      return rolesOf(session?.passes ?? []);
    };

    expect(await roles(journalOf([pass(1, [segment(1, 'completed', 2)])]))).toEqual([
      [1, 'fronts', null],
      [2, 'backs', null],
    ]);
    expect(
      await roles(journalOf([pass(1, [segment(1, 'completed', 2)])], { backsDeclined: true })),
    ).toEqual([
      [1, 'fronts', null],
      [2, 'added', null],
    ]);
  });

  it('усыновлённый третий проход при лицевых и оборотах — добавленный без якоря (M3.5, R6)', async () => {
    const { root } = await seed(
      journalOf([pass(1, [segment(1, 'completed', 1)]), pass(2, [segment(1, 'completed', 1)])]),
      [pageName(1, 1, 1), pageName(2, 1, 1), pageName(3, 1, 1), pageName(3, 1, 2)],
    );

    const { session, store } = await reconciled(root);

    expect(session?.passes.map((it) => [it.number, it.kind, it.after, it.pages.length])).toEqual([
      [1, 'fronts', null, 1],
      [2, 'backs', null, 1],
      [3, 'added', null, 2],
    ]);
    // Добавленный проход без параметров — досканировать его нельзя.
    expect(store.resumeTarget()).toMatchObject({ ok: false });
  });

  it('пересобранный журнал: роли по возрастанию номера, не по порядку обхода каталога; якоря `null`; идемпотентно (M3.5, R6)', async () => {
    const files = [pageName(1, 1, 1), pageName(1, 1, 2), pageName(2, 1, 1), pageName(3, 1, 1)];
    // Файловая система отдаёт имена в своём порядке; обратный обход — подменой `readdir`.
    const reversed = {
      ...realStorageFs,
      readdir: async (path: string) => [...(await realStorageFs.readdir(path))].reverse(),
    };
    const run = async (fs: typeof realStorageFs) => {
      const { root, layout } = await seed(null, files);
      const first = await openSessionStore(root, { fs });
      expect(first.notices).toContain('journalRebuilt');
      const before = await dirSnapshot(root);
      const second = await openSessionStore(root, { fs });
      expect(await dirSnapshot(root)).toEqual(before);
      const journal = await journalOnDisk(layout);
      const storeRoles = (store: typeof first.store) => rolesOf(store.snapshot()?.passes ?? []);
      expect(rolesOf(journal.passes)).toEqual(storeRoles(second.store));
      return storeRoles(first.store);
    };
    const expected = [
      [1, 'fronts', null],
      [2, 'backs', null],
      [3, 'added', null],
    ];

    expect(await run(realStorageFs)).toEqual(expected);
    expect(await run(reversed)).toEqual(expected);
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

describe('сверка при запуске: нечитаемый журнал не теряется', () => {
  const asides = async (layout: DataLayout): Promise<string[]> =>
    (await readdir(layout.sessionDir)).filter((name) => name.includes('.unreadable-'));

  it('журнал не отодвинулся переименованием — копируется, новый журнал записан', async () => {
    const { root, layout } = await seed('не журнал', pagesOfFirstSegment(3));
    const { fs } = interceptFs(realStorageFs, (call) => {
      // Отказывает именно переименование самого журнала; запись копии рядом проходит.
      if (call.op === 'rename' && call.path.endsWith('session.json')) {
        throw fsError('EPERM');
      }
    });

    const { state } = await reconcileSession(root, { fs, retry: { ceilingMs: 0 } });

    expect(state.unsaved).toBe(false);
    expect(state.unpreserved).toBe(false);
    const [copy = ''] = await asides(layout);
    expect(await readFile(join(layout.sessionDir, copy), 'utf8')).toBe('не журнал');
    expect((await journalOnDisk(layout)).passes[0]?.segments[0]?.pageCount).toBe(3);
  });

  it('журнал не удалось ни отодвинуть, ни скопировать — он цел, а хранилище отодвигает его перед первой записью', async () => {
    const { root, layout } = await seed('не журнал', pagesOfFirstSegment(3));
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (`${call.path}|${call.to ?? ''}`.includes('.unreadable-') && call.op !== 'readdir') {
        throw fsError('EPERM');
      }
    });

    const { state, notices } = await reconcileSession(root, { fs, retry: { ceilingMs: 0 } });

    expect(state.unsaved).toBe(true);
    expect(state.unpreserved).toBe(true);
    expect(notices).toContain('journalRebuilt');
    expect(state.journal?.passes[0]?.segments[0]?.pageCount).toBe(3);
    expect(await readFile(layout.journalFile, 'utf8')).toBe('не журнал');
    expect(await asides(layout)).toEqual([]);

    // Помеха ушла: первая же запись хранилища сначала сохраняет прежний файл в стороне.
    const store = createSessionStore(root, state);
    expect(await store.flush()).toEqual({ ok: true, value: undefined });
    const [copy = ''] = await asides(layout);
    expect(await readFile(join(layout.sessionDir, copy), 'utf8')).toBe('не журнал');
    expect((await journalOnDisk(layout)).passes[0]?.segments[0]?.pageCount).toBe(3);
  });

  it('нечитаемый журнал без страниц, который не удалось сохранить в стороне, новая сессия не затирает', async () => {
    const { root, layout } = await seed('не журнал');
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (`${call.path}|${call.to ?? ''}`.includes('.unreadable-') && call.op !== 'readdir') {
        throw fsError('EPERM');
      }
    });

    const { state } = await reconcileSession(root, { fs, retry: { ceilingMs: 0 } });

    expect(state.journal).toBeNull();
    expect(state.unpreserved).toBe(true);
    expect(await readFile(layout.journalFile, 'utf8')).toBe('не журнал');

    const store = createSessionStore(root, state);
    expect(await store.beginPass(ORIGIN, null)).toMatchObject({ ok: true });
    const [copy = ''] = await asides(layout);
    expect(await readFile(join(layout.sessionDir, copy), 'utf8')).toBe('не журнал');
  });
});

describe('сверка при запуске: миниатюры отброшенного сегмента', () => {
  it('доведённое удаление сегмента чистит и его миниатюры', async () => {
    const { root, layout } = await seed(
      journalOf([pass(1, [segment(1, 'interrupted', 1)], { nextSegment: 3 })], {
        deletions: ['p01-s02-'],
      }),
      [pageName(1, 1, 1), pageName(1, 2, 1)],
    );
    const thumbs = join(layout.derivedDir, SESSION, 'thumbs');
    await mkdir(thumbs, { recursive: true });
    for (const name of [pageName(1, 1, 1), pageName(1, 2, 1), pageName(1, 2, 2)]) {
      await writeFile(join(thumbs, name), page(7));
    }

    await reconciled(root);

    expect(await readdir(thumbs)).toEqual([pageName(1, 1, 1)]);
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
    /** Страницы, приём которых подтверждён и которые никто не удалял: ключ → принятые байты. */
    readonly kept: Map<string, Uint8Array>;
    /** Страницы сегмента, удаление которого подтверждено. */
    readonly discarded: Set<string>;
    /** Страницы сегмента, удаление которого началось, но не подтверждено: все или ни одной. */
    readonly limbo: Set<string>;
    closing: boolean;
  }

  // Сценарий: проход, обрыв, досканирование, «Остановить», новое досканирование, второй проход,
  // «оставить как есть», «Новая пачка».
  async function scenario(root: string, fs: typeof realStorageFs): Promise<Outcome> {
    const outcome: Outcome = {
      kept: new Map(),
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
    const accept = async (count: number, into?: Set<string>): Promise<void> => {
      for (let index = 0; index < count; index += 1) {
        content += 1;
        const { key } = await store.acceptPage(body(content));
        if (into === undefined) {
          outcome.kept.set(key, page(content));
        } else {
          into.add(key);
        }
      }
    };

    try {
      must(await store.beginPass(ORIGIN, null));
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

      must(await store.beginPass(ORIGIN, null));
      await accept(1);
      must(await store.endSegment('interrupted'));
      must(await store.acceptPass());

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
      // «Новая пачка» оборвана: сессия либо цела, либо её нет — половины не бывает.
      if (!outcome.closing || present.size > 0) {
        for (const [key, bytes] of outcome.kept) {
          expect(present.has(key), `шаг ${dieAt}: страница ${key} потеряна`).toBe(true);
          // Не только имя: байты на диске — те, что были приняты.
          expect(await second.store.readPage(key), `шаг ${dieAt}: страница ${key}`).toEqual({
            ok: true,
            value: bytes,
          });
        }
      }
      for (const key of outcome.discarded) {
        expect(present.has(key), `шаг ${dieAt}: страница ${key} вернулась`).toBe(false);
      }
      const limbo = [...outcome.limbo].filter((key) => present.has(key));
      expect([0, outcome.limbo.size], `шаг ${dieAt}: удаление наполовину`).toContain(limbo.length);
    }
  }, 120_000);
  // Сама сверка тоже может быть убита посередине: следующий запуск обязан довести её до того же.
  it.each([
    [
      'журнал с идущим сегментом, пометкой об удалении, временными файлами и закрываемым каталогом',
      journalOf([pass(1, [segment(1, 'running', 2)], { nextSegment: 3 })], {
        deletions: ['p01-s02-'],
      }),
    ],
    ['нечитаемый журнал', 'не журнал'],
  ])(
    'сверка, убитая на каждом своём шаге, доводится следующими запусками: %s',
    async (_title, journal) => {
      const prepare = async () => {
        const seeded = await seed(journal, [
          ...pagesOfFirstSegment(3),
          ...(typeof journal === 'string' ? [] : [pageName(1, 2, 1), pageName(1, 2, 2)]),
        ]);
        const { root, layout } = seeded;
        await writeFile(join(layout.pagesDir, 'p01-s01-0004.jpg.0123456789ab.tmp'), page(4));
        await writeFile(join(layout.sessionDir, 'session.json.ba9876543210.tmp'), '{');
        await mkdir(join(root, `session.closing-${OTHER_SESSION}`, 'pages'), { recursive: true });
        await writeFile(
          join(root, `session.closing-${OTHER_SESSION}`, 'pages', pageName(1, 1, 1)),
          page(1),
        );
        await mkdir(join(layout.derivedDir, OTHER_SESSION, 'thumbs'), { recursive: true });
        return seeded;
      };
      const expectedKeys = ['p01-s01-0001', 'p01-s01-0002', 'p01-s01-0003'];

      const dry = dyingFs(Number.POSITIVE_INFINITY);
      await reconcileSession((await prepare()).root, { fs: dry.fs, retry: { ceilingMs: 0 } });
      const total = dry.steps();
      expect(total).toBeGreaterThan(5);

      for (let dieAt = 1; dieAt <= total; dieAt += 1) {
        const { root, layout } = await prepare();
        const dying = dyingFs(dieAt);
        await reconcileSession(root, { fs: dying.fs, retry: { ceilingMs: 0 } }).catch(
          () => undefined,
        );
        expect(dying.dead(), `шаг ${dieAt}`).toBe(true);

        const first = await reconciled(root);
        const afterFirst = await dirSnapshot(root);
        const second = await reconciled(root);

        expect(first.keys, `шаг ${dieAt}`).toEqual(expectedKeys);
        expect(first.lost, `шаг ${dieAt}`).toEqual([]);
        expect(first.passes[0]?.state, `шаг ${dieAt}`).toBe('interrupted');
        expect(second.keys, `шаг ${dieAt}: второй прогон`).toEqual(expectedKeys);
        expect(await dirSnapshot(root), `шаг ${dieAt}: второй прогон`).toEqual(afterFirst);
        // Страницы отброшенного сегмента не вернулись, временные файлы не стали страницами.
        expect(await readdir(layout.pagesDir), `шаг ${dieAt}`).toEqual(pagesOfFirstSegment(3));
        if (typeof journal === 'string') {
          // Нечитаемый журнал не потерян, сколько бы раз сверка ни начиналась заново.
          const copies = (await readdir(layout.sessionDir)).filter((name) =>
            name.includes('.unreadable-'),
          );
          expect(copies, `шаг ${dieAt}`).toHaveLength(1);
          expect(await readFile(join(layout.sessionDir, copies[0] ?? ''), 'utf8')).toBe(journal);
        }
      }
    },
    120_000,
  );
});

describe('сверка при запуске: режим пустых оборотов (M4, R8)', () => {
  it('журнал версии 5 переписывается текущей версией: режим «оставлять», пометок нет', async () => {
    const { root, layout } = await seed(
      {
        ...omit(journalOf([pass(1, [segment(1, 'completed', 2)])], { saved: true }), 'blankMode'),
        version: 5,
        edits: omit(EMPTY_EDITS, 'notBlank'),
      },
      pagesOfFirstSegment(2),
    );

    const { session, notices } = await reconciled(root);

    expect(notices).toEqual([]);
    expect(session).toMatchObject({ saved: true, blankMode: 'keep', edits: EMPTY_EDITS });
    const journal = await journalOnDisk(layout);
    expect(journal).toMatchObject({ version: 6, blankMode: 'keep', edits: EMPTY_EDITS });

    const before = await dirSnapshot(root);
    await reconciled(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });
});
