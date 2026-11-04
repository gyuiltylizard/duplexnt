import type { AssembledPage, StraightenMark, StraightenReason } from '@shared';
import type { TFunction } from 'i18next';

// Тексты и счёт по статусам выравнивания (план M6, U8; handoff M6 «States», «Copy»): причина
// «не выровнено» — одной строкой на карточку, превью и инспектор; сводка выделения для секции
// ВЫРАВНИВАНИЕ и подходящие страницы для действий (AE17: «Оставить оригинал» — только
// `straightened`, «Выровнять» — только `kept`). Статусы считает ядро (KTD-9), здесь — только слова.

/** Причина пометки «не выровнено»; у прочих статусов причины нет. */
export const reasonText = (t: TFunction, reason: StraightenReason): string =>
  t(`straight.reason.${reason}`);

/** Подсказка пометки на карточке и пилюли превью; `null` — пометки нет. */
export function straightTitle(t: TFunction, mark: StraightenMark): string | null {
  switch (mark.status) {
    case 'straightened':
      return t('straight.title.straightened');
    case 'pending':
      return t('straight.title.pending');
    case 'unmeasurable':
    case 'deferred':
      return mark.reason === null ? null : t(`straight.title.${mark.reason}`);
    default:
      return null;
  }
}

/** Подпись карточки для скринридера с суффиксом статуса; `kept`, `level` и `null` — без суффикса. */
export function thumbStraightLabel(t: TFunction, label: string, mark: StraightenMark): string {
  switch (mark.status) {
    case 'straightened':
      return t('thumb.straightLabel', { label });
    case 'pending':
      return t('thumb.straightPendingLabel', { label });
    case 'unmeasurable':
    case 'deferred':
      return mark.reason === null
        ? label
        : t('thumb.straightUndoneLabel', { label, reason: reasonText(t, mark.reason) });
    default:
      return label;
  }
}

/** Факт «Выравнивание» в ДЕТАЛЯХ; `null` — статуса нет, факта нет. */
export function straightFactText(t: TFunction, mark: StraightenMark): string | null {
  switch (mark.status) {
    case null:
      return null;
    case 'unmeasurable':
    case 'deferred':
      return mark.reason === null ? null : t(`inspector.fact.straightValue.${mark.reason}`);
    default:
      return t(`inspector.fact.straightValue.${mark.status}`);
  }
}

/** Действие секции: «Оригинал» (`straightened`) или «Выровнять» (`kept`). */
export type StraightAction = 'keep' | 'restore';

/** Сводка выделения для секции ВЫРАВНИВАНИЕ и действий на несколько страниц. */
export interface StraightSelection {
  /** Выделенных страниц. */
  readonly count: number;
  readonly straightened: number;
  readonly kept: number;
  /** `unmeasurable` и `deferred` вместе — одна пометка «не выровнено». */
  readonly undone: number;
  readonly pending: number;
  readonly level: number;
  /** Ключи, которым подходит «Оригинал» (`straightened`). */
  readonly keep: readonly string[];
  /** Ключи, которым подходит «Выровнять» (`kept`). */
  readonly restore: readonly string[];
}

const EMPTY_SELECTION: StraightSelection = {
  count: 0,
  straightened: 0,
  kept: 0,
  undone: 0,
  pending: 0,
  level: 0,
  keep: [],
  restore: [],
};

/** Счёт статусов выделенных страниц в порядке ленты; `null` не считается. */
export function straightSelectionOf(
  pages: readonly AssembledPage[],
  keys: readonly string[],
): StraightSelection {
  const selected = new Set(keys);
  const counts = { straightened: 0, kept: 0, undone: 0, pending: 0, level: 0 };
  const keep: string[] = [];
  const restore: string[] = [];
  let count = 0;
  for (const page of pages) {
    if (!selected.has(page.key)) {
      continue;
    }
    count += 1;
    const { status } = page.straighten;
    switch (status) {
      case 'straightened':
        counts.straightened += 1;
        keep.push(page.key);
        break;
      case 'kept':
        counts.kept += 1;
        restore.push(page.key);
        break;
      case 'unmeasurable':
      case 'deferred':
        counts.undone += 1;
        break;
      case 'pending':
      case 'level':
        counts[status] += 1;
        break;
      case null:
        break;
    }
  }
  return count === 0 ? EMPTY_SELECTION : { count, ...counts, keep, restore };
}

/** Подпись кнопки действия на выделение: «— 3 из 5 выделенных» или «— 5 стр.», если подходят все. */
export function straightActionLabel(
  t: TFunction,
  action: StraightAction,
  eligible: number,
  count: number,
): string {
  if (eligible === count) {
    return t(`inspector.straight.${action}All`, { count });
  }
  return t(`inspector.straight.${action}Some`, { k: eligible, n: count });
}
