import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS } from '@shared';
import { dirSnapshot } from '../../../test/support/dir-snapshot';
import { journalOnDisk, rolesOf } from '../../../test/support/session-store';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { pendingPairOf, type JournalPass } from './journal';
import { layoutOf } from './layout';
import { openSessionStore } from './reconcile';

// Сверка при запуске и пары добавленных наборов (M4.5, R21, R22): пара восстанавливается из
// фактов журнала, усыновление пар не создаёт, журнал v6 переписывается v7. Таблица сверки M1 —
// в `reconcile.test.ts` (правило размера тестового файла).

const SESSION = 'a1b2c3d4e5f60718';

const passAt = (
  number: number,
  pageCount: number,
  extra: Partial<JournalPass> = {},
): JournalPass => ({
  number,
  accepted: false,
  origin: null,
  nextSegment: 2,
  segments: [{ number: 1, state: 'completed', pageCount }],
  kind: number === 1 ? 'fronts' : 'backs',
  after: null,
  pair: null,
  backsDecision: null,
  rotate180: false,
  ...extra,
});

const journalOf = (passes: readonly JournalPass[], extra: object = {}) => ({
  version: 7,
  sessionId: SESSION,
  nextPass: Math.max(0, ...passes.map((pass) => pass.number)) + 1,
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

const page = (number: number): Uint8Array => Uint8Array.of(0xff, 0xd8, number, 0xff, 0xd9);
const pageName = (pass: number, index: number): string =>
  `p0${pass}-s01-${String(index).padStart(4, '0')}.jpg`;
/** Файлы страниц всех проходов журнала: сегмент 1, номера с 1 по `pageCount`. */
const filesOf = (passes: readonly JournalPass[]): string[] =>
  passes.flatMap((pass) =>
    Array.from({ length: pass.segments[0]?.pageCount ?? 0 }, (_value, index) =>
      pageName(pass.number, index + 1),
    ),
  );

async function seed(journal: unknown, pages: readonly string[]) {
  const root = await makeTempDataRoot();
  const layout = layoutOf(root);
  await mkdir(layout.pagesDir, { recursive: true });
  await writeFile(layout.journalFile, JSON.stringify(journal));
  for (const [index, name] of pages.entries()) {
    await writeFile(join(layout.pagesDir, name), page(index + 1));
  }
  return { root, layout };
}

const MAIN: readonly JournalPass[] = [passAt(1, 2), passAt(2, 2)];
/** Лица набора «Д1» после страницы 2 лицевых: ждут обороты. */
const SET_FRONTS = passAt(3, 2, {
  kind: 'addedFronts',
  after: 'p01-s01-0002',
  backsDecision: 'none',
});

describe('сверка при запуске: пары добавленных наборов (M4.5, R21, R22)', () => {
  it('журнал версии 6 переписывается текущей версией: добавленный набор остаётся односторонним, ссылки пары и решения нет; повтор ничего не меняет', async () => {
    const passes = [...MAIN, passAt(3, 1, { kind: 'added', after: 'p01-s01-0001' })];
    const v6 = {
      ...journalOf(passes),
      version: 6,
      passes: passes.map((pass) => omit(pass, 'pair', 'backsDecision')),
    };
    const { root, layout } = await seed(v6, filesOf(passes));

    const { store, notices } = await openSessionStore(root);

    expect(notices).toEqual([]);
    const raw = JSON.parse(await readFile(layout.journalFile, 'utf8')) as {
      version: number;
      passes: { kind: string; pair: unknown; backsDecision: unknown }[];
    };
    expect(raw.version).toBe(7);
    expect(raw.passes.map((pass) => [pass.kind, pass.pair, pass.backsDecision])).toEqual([
      ['fronts', null, null],
      ['backs', null, null],
      ['added', null, null],
    ]);
    expect(store.snapshot()?.passes[2]).toMatchObject({
      kind: 'added',
      after: 'p01-s01-0001',
      pair: null,
      backsDecision: null,
    });

    const before = await dirSnapshot(root);
    await openSessionStore(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('пара переживает перезапуск-сверку дословно; набор, ждущий обороты, читается из фактов журнала', async () => {
    const passes = [...MAIN, SET_FRONTS];
    const { root } = await seed(journalOf(passes), filesOf(passes));
    const before = await dirSnapshot(root);

    const { store, notices } = await openSessionStore(root);

    expect(notices).toEqual([]);
    expect(store.snapshot()?.passes[2]).toMatchObject({
      kind: 'addedFronts',
      after: 'p01-s01-0002',
      pair: null,
      backsDecision: 'none',
      state: 'completed',
    });
    expect(pendingPairOf(await journalOnDisk(root))).toEqual({ set: 1, fronts: 3, expected: 2 });
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('пара с оборотами переживает сверку дословно: ссылка пары и флаг поворота целы', async () => {
    const passes = [
      ...MAIN,
      SET_FRONTS,
      passAt(4, 2, { kind: 'addedBacks', pair: 3, rotate180: true }),
    ];
    const { root } = await seed(journalOf(passes), filesOf(passes));
    const before = await dirSnapshot(root);

    const { store } = await openSessionStore(root);

    expect(store.snapshot()?.passes[3]).toMatchObject({
      kind: 'addedBacks',
      pair: 3,
      rotate180: true,
      backsDecision: null,
    });
    expect(pendingPairOf(await journalOnDisk(root))).toBeNull();
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('усыновлённый проход при ожидающей паре — односторонний набор без якоря; пара остаётся ожидающей (R22)', async () => {
    const passes = [...MAIN, SET_FRONTS];
    const { root } = await seed(journalOf(passes), [...filesOf(passes), pageName(4, 1)]);

    const { store, notices } = await openSessionStore(root);

    expect(notices).toEqual([]);
    expect(rolesOf(store.snapshot()?.passes ?? [])).toEqual([
      [1, 'fronts', null],
      [2, 'backs', null],
      [3, 'addedFronts', 'p01-s01-0002'],
      [4, 'added', null],
    ]);
    expect(store.snapshot()?.passes[3]).toMatchObject({ pair: null, backsDecision: null });
    const journal = await journalOnDisk(root);
    expect(rolesOf(journal.passes)).toEqual(rolesOf(store.snapshot()?.passes ?? []));
    expect(pendingPairOf(journal)).toEqual({ set: 1, fronts: 3, expected: 2 });
  });

  it('обороты набора с пропавшим проходом лиц читаются как осиротевшие: сверка их не трогает', async () => {
    const passes = [...MAIN, passAt(4, 2, { kind: 'addedBacks', pair: 3 })];
    const { root } = await seed(journalOf(passes), filesOf(passes));
    const before = await dirSnapshot(root);

    const { store, notices } = await openSessionStore(root);

    expect(notices).toEqual([]);
    expect(store.snapshot()?.passes[2]).toMatchObject({ kind: 'addedBacks', pair: 3 });
    expect(await dirSnapshot(root)).toEqual(before);
  });
});
