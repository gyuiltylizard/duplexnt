import type { AssembledPage } from '@shared';
import type { TFunction } from 'i18next';

// Словарь страницы ленты — общий для инспектора, экрана и модалки `add` (ревью сессий 3–4):
// тон документа и «что это за страница» теми же словами в ДЕТАЛЯХ и в сводке якоря.

/** Тон документа по номеру с нуля: четыре цвета по кругу (handoff M3, Anatomy). */
export const toneOf = (document: number): string => `doc-tone--${String((document % 4) + 1)}`;

/** Лишний оборот: оборот без листа. */
export const isExtraBack = (entry: AssembledPage): boolean =>
  entry.side === 'back' && entry.sheet === null;

/**
 * Что это за страница: «лицо листа 4», «оборот листа 4», «лишний оборот», «добавленный набор 1»
 * — заголовок ДЕТАЛЕЙ без «Стр. N —»; теми же словами сводка модалки `add` называет якорь.
 */
export function whatOf(t: TFunction, entry: AssembledPage): string {
  const sheet = entry.sheet ?? 0;
  if (entry.addedSet !== null) {
    return t('inspector.what.added', { set: entry.addedSet });
  }
  if (isExtraBack(entry)) {
    return t('inspector.what.extraBack');
  }
  return t(entry.side === 'back' ? 'inspector.what.back' : 'inspector.what.front', { sheet });
}
