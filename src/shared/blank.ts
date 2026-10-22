// Режим пустых оборотов (M4; ADR 0004, амендмент 2026-10-22): решение приложения о ленте, не
// параметр устройства — в `ScanParams` не входит, по capabilities не сверяется. Выбирается в
// `setup`, помнится в настройках и замораживается в журнале сессии при старте первого прохода.

export const BLANK_MODES = ['hide', 'mark', 'keep'] as const;

/** «Скрывать» · «Помечать» · «Оставлять» (UI_SPEC §2). */
export type BlankMode = (typeof BLANK_MODES)[number];

/** По умолчанию — скрывать (UI_SPEC §2); «Сбросить параметры» возвращает его. */
export const DEFAULT_BLANK_MODE: BlankMode = 'hide';
