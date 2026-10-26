// Подсказки, которые интерфейс показывает с привлечением внимания один раз на установку (B-4):
// какие уже показаны — помнится в настройках (`seenHints`, версия 4).

/** `docsSplit` — подсказка про границы документов (Ctrl/Shift) в инспекторе `editor`. */
export const HINTS = ['docsSplit'] as const;

export type HintId = (typeof HINTS)[number];
