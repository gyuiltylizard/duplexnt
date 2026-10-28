import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EMPTY_EDITS } from '../../src/shared';
import { JOURNAL_VERSION } from '../../src/core/storage/journal';
import { layoutOf, type DataLayout } from '../../src/core/storage/layout';
import { openSessionStore } from '../../src/core/storage/reconcile';
import { ORIGIN, SESSION } from './session-store';
import { makeTempDataRoot } from './temp-data-root';

// Общие хелперы тестов сверки при запуске (`src/core/storage/reconcile*.test.ts`): сборщики
// журнала текущей и прежних версий (каждая прежняя — вычитанием полей из следующей), посев
// каталога сессии, журнал с диска, сверка глазами интерфейса. Живут здесь, а не рядом с
// тестами: продуктовым файлам src/ импорт из test/ закрыт. Тесты поделены по смыслу (правило
// размера тестового файла):
// `reconcile.test.ts` — таблица плана, нечитаемый журнал, миниатюры и оценки сегмента;
// `reconcile.versions.test.ts` — чтение и переписывание журналов прежних версий;
// `reconcile.failures.test.ts` — сбой на каждом шаге записи хранилища.

export { ORIGIN, SESSION };
export const OTHER_SESSION = 'ffffffffffffffff';

export type SegmentState = 'running' | 'completed' | 'interrupted';
export const segment = (number: number, state: SegmentState, pageCount: number) => ({
  number,
  state,
  pageCount,
});
export const pass = (
  number: number,
  segments: ReturnType<typeof segment>[],
  extra: object = {},
) => ({
  number,
  accepted: false,
  origin: ORIGIN,
  nextSegment: Math.max(...segments.map((it) => it.number)) + 1,
  segments,
  kind: number === 1 ? 'fronts' : 'backs',
  after: null,
  pair: null,
  backsDecision: null,
  rotate180: false,
  ...extra,
});
export const journalOf = (passes: ReturnType<typeof pass>[], extra: object = {}) => ({
  version: JOURNAL_VERSION,
  sessionId: SESSION,
  nextPass: passes.length + 1,
  passes,
  deletions: [] as string[],
  backsDeclined: false,
  saved: false,
  edits: EMPTY_EDITS,
  assembled: null as readonly string[] | null,
  blankMode: 'keep' as const,
  straighten: 'off' as const,
  ...extra,
});
export function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const dropped: readonly string[] = keys as readonly string[];
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !dropped.includes(key)),
  ) as Omit<T, K>;
}

/** Журнал версии 7 (M4.5): тот же состав без режима выравнивания и откатов (M6). */
export const journalV7Of = (passes: ReturnType<typeof pass>[], extra: object = {}) => {
  const current = journalOf(passes, extra);
  return {
    ...omit(current, 'straighten'),
    version: 7,
    edits: omit(current.edits, 'keepOriginal'),
  };
};

/** Журнал версии 6 (M4): тот же состав без ролей пары — ссылки пары и решения по оборотам. */
export const journalV6Of = (passes: ReturnType<typeof pass>[], extra: object = {}) => ({
  ...journalV7Of(passes, extra),
  version: 6,
  passes: passes.map((one) => omit(one, 'pair', 'backsDecision')),
});

/** Журнал версии 4 (M3.5): тот же состав без записи сборки и границы наборов. */
export const journalV4Of = (passes: ReturnType<typeof pass>[], extra: object = {}) => ({
  ...omit(journalV6Of(passes, extra), 'assembled', 'blankMode'),
  version: 4,
  edits: omit(EMPTY_EDITS, 'divider', 'notBlank', 'keepOriginal'),
});

/** Журнал версии 3 (M3): тот же состав, роль прохода — по позиции, якоря нет. */
export const journalV3Of = (passes: ReturnType<typeof pass>[], extra: object = {}) => ({
  ...journalV4Of(passes, extra),
  version: 3,
  passes: passes.map((one) => omit(one, 'kind', 'after', 'pair', 'backsDecision')),
});

/** Журнал версии 2 (M2): тот же состав без правок редактора. */
export const journalV2Of = (passes: ReturnType<typeof pass>[], extra: object = {}) => ({
  ...omit(journalV3Of(passes, extra), 'edits'),
  version: 2,
});

/** Журнал версии 1 (M1): тот же состав без полей v2–v4. */
export const journalV1Of = (passes: ReturnType<typeof pass>[], extra: object = {}) => ({
  ...omit(journalV3Of(passes, extra), 'backsDeclined', 'saved', 'edits'),
  version: 1,
  passes: passes.map((one) => omit(one, 'rotate180', 'kind', 'after', 'pair', 'backsDecision')),
});

export const page = (number: number): Uint8Array => Uint8Array.of(0xff, 0xd8, number, 0xff, 0xd9);
export const pageName = (passNumber: number, segmentNumber: number, index: number): string =>
  `p0${passNumber}-s0${segmentNumber}-${String(index).padStart(4, '0')}.jpg`;

export async function seed(journal: unknown, pages: readonly string[] = []) {
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
export const pagesOfFirstSegment = (count: number): string[] =>
  Array.from({ length: count }, (_value, index) => pageName(1, 1, index + 1));

export async function journalOnDisk(layout: DataLayout): Promise<ReturnType<typeof journalOf>> {
  return JSON.parse(await readFile(layout.journalFile, 'utf8')) as ReturnType<typeof journalOf>;
}

/** Сверка и то, что после неё видит интерфейс. */
export async function reconciled(root: string) {
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
