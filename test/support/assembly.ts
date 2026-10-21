import { EMPTY_EDITS, type PageSnapshot, type PassSnapshot, type SessionSnapshot } from '@shared';

// Общие фикстуры снимка сессии для тестов сборки (`src/core/scan/assembly*.test.ts`): страницы
// с настоящими ключами, проход с ролью по номеру (1 — лицевые, иначе обороты), добавленный набор
// с якорем, снимок без правок. Живут здесь, а не рядом с тестами: файлов сборки несколько
// (правило размера), а фикстура одна.

/** Страницы прохода `pass`, сегмент 1, номера с 1 по `count`; `lost` — потерянные номера. */
export const pagesOf = (
  pass: number,
  count: number,
  lost: readonly number[] = [],
): PageSnapshot[] =>
  Array.from({ length: count }, (_value, index) => ({
    key: `p${String(pass).padStart(2, '0')}-s01-${String(index + 1).padStart(4, '0')}`,
    number: index + 1,
    lost: lost.includes(index + 1),
  }));

/** Ключ страницы `index` (с 1) прохода `pass`, сегмент 1. */
export const keyOf = (pass: number, index: number): string =>
  `p${String(pass).padStart(2, '0')}-s01-${String(index).padStart(4, '0')}`;

export const passOf = (
  number: number,
  count: number,
  extra: Partial<PassSnapshot> = {},
): PassSnapshot => ({
  number,
  state: 'completed',
  paramsKnown: true,
  scanner: null,
  kind: number === 1 ? 'fronts' : 'backs',
  after: null,
  rotate180: false,
  pages: pagesOf(number, count),
  ...extra,
});

/** Добавленный набор: проход `number` из `count` страниц с якорем `after`. */
export const addedOf = (
  number: number,
  count: number,
  after: string | null,
  extra: Partial<PassSnapshot> = {},
): PassSnapshot => passOf(number, count, { kind: 'added', after, ...extra });

export const sessionOf = (
  passes: PassSnapshot[],
  extra: Partial<SessionSnapshot> = {},
): SessionSnapshot => ({
  id: 'a1b2c3d4e5f60718',
  backsDeclined: false,
  saved: false,
  edits: EMPTY_EDITS,
  assembled: null,
  passes,
  ...extra,
});
