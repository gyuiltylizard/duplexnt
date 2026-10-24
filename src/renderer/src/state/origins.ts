import type { PassKind, PassSnapshot } from '@shared';

// Происхождение страницы ленты — роль прохода по ключу (M3.6, R11, R23; M4.5): тег «об», факт
// «Откуда» и слова страницы пары.

export function originsOf(passes: readonly PassSnapshot[]): ReadonlyMap<string, PassKind> {
  return new Map(
    passes.flatMap((pass) => pass.pages.map((page) => [page.key, pass.kind] as const)),
  );
}

/** Роль прохода страницы по ключу; `null` — ключа нет или ленты нет. */
export const originKindOf = (
  origins: ReadonlyMap<string, PassKind>,
  key: string | undefined,
): PassKind | null => (key === undefined ? null : (origins.get(key) ?? null));
