import { useMemo, type ChangeEvent } from 'react';
import { addedSetsOf, hasPages, type PassSnapshot } from '@shared';
import type { TFunction } from 'i18next';
import { rolesOf } from './screen';

// Цель тумблера 180° (план M4.5, U7; R16; KTD4; handoff M4.5, S9): проход оборотов пачки текущей
// страницы — основного документа (`backs` сессии) или набора «ДN» (обороты пары). Текущая на пачке
// без оборотов (односторонний набор, основной документ без оборотов) — тумблер недоступен с
// причиной; скрыт, только если оборотов нет ни у одной пачки. Флаг — на проходе оборотов этой
// пачки; переключение — шаг undo, как у одного флага раньше.

/** Строка тумблера в подвале ленты: флаг цели, подпись, недоступность (handoff M4.5, S9). */
export interface RailRotate {
  readonly checked: boolean;
  readonly disabled: boolean;
  /** У пачки текущей страницы нет оборотов: строка приглушена, `target` — причина. */
  readonly unavailable: boolean;
  /** Подпись цели («обороты набора Д1») или причина недоступности. */
  readonly target: string;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

export type RotateTarget =
  | { readonly kind: 'main'; readonly pass: number }
  | { readonly kind: 'set'; readonly pass: number; readonly set: number }
  /** Пачка текущей без оборотов: `set` — номер «ДN» или `null` для основного документа. */
  | { readonly kind: 'none'; readonly set: number | null };

/**
 * Цель по проходам сессии и набору текущей страницы (`addedSet` страницы ленты; `undefined` —
 * ленты нет: цель — основной документ). `null` — тумблера нет: оборотов нет ни у одной пачки.
 */
export function rotateTargetOf(
  passes: readonly PassSnapshot[],
  addedSet: number | null | undefined,
): RotateTarget | null {
  const mainBacks = rolesOf(passes).backs;
  const sets = addedSetsOf(passes, hasPages);
  if (mainBacks === null && sets.every((set) => set.backs === null)) {
    return null;
  }
  if (addedSet === null || addedSet === undefined) {
    return mainBacks === null
      ? { kind: 'none', set: null }
      : { kind: 'main', pass: mainBacks.number };
  }
  const backs = sets.find((set) => set.set === addedSet)?.backs ?? null;
  return backs === null
    ? { kind: 'none', set: addedSet }
    : { kind: 'set', pass: backs, set: addedSet };
}

export const useRotateTarget = (
  passes: readonly PassSnapshot[],
  addedSet: number | null | undefined,
): RotateTarget | null => useMemo(() => rotateTargetOf(passes, addedSet), [passes, addedSet]);

/** Цель (или причина недоступности) — скрытое описание чекбокса и `title` строки (B-8). */
export function rotateTargetText(t: TFunction, target: RotateTarget): string {
  switch (target.kind) {
    case 'main':
      return t('editor.rotateTarget.main');
    case 'set':
      return t('editor.rotateTarget.set', { set: target.set });
    case 'none':
      return target.set === null
        ? t('editor.rotateTarget.noneMain')
        : t('editor.rotateTarget.noneSet', { set: target.set });
  }
}

/** Строка тумблера для подвала: состояние флага цели, подпись, недоступность. */
export function rotateRowOf(
  t: TFunction,
  target: RotateTarget | null,
  flags: ReadonlyMap<number, boolean>,
  locked: boolean,
  onChange: (event: ChangeEvent<HTMLInputElement>) => void,
): RailRotate | null {
  if (target === null) {
    return null;
  }
  const unavailable = target.kind === 'none';
  return {
    checked: unavailable ? false : (flags.get(target.pass) ?? false),
    disabled: locked || unavailable,
    unavailable,
    target: rotateTargetText(t, target),
    onChange,
  };
}
