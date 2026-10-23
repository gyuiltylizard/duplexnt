import type { PassKind, PassSnapshot } from '@shared';

// Происхождение страницы ленты — проход по ключу (M3.6, R11, R23; M4.5, KTD4): тег «об» и факт
// «Откуда» по роли, цель тумблера 180° — по номеру прохода пачки текущей страницы.

export interface PageOrigin {
  readonly pass: number;
  readonly kind: PassKind;
}

export function originsOf(passes: readonly PassSnapshot[]): ReadonlyMap<string, PageOrigin> {
  return new Map(
    passes.flatMap((pass) =>
      pass.pages.map((page) => [page.key, { pass: pass.number, kind: pass.kind }] as const),
    ),
  );
}

/** Роль прохода страницы по ключу; `null` — ключа нет или ленты нет. */
export const originKindOf = (
  origins: ReadonlyMap<string, PageOrigin>,
  key: string | undefined,
): PassKind | null => (key === undefined ? null : (origins.get(key)?.kind ?? null));
