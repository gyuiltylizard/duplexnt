import { sameEdits, type SessionEdits, type SessionSnapshot } from '@shared';
import { rolesOf } from './screen';

// Undo/redo редактора (план M3, U6; KTD-3, KTD-3a): эфемерный стек в памяти запуска, без
// предела глубины. Настоящее в стеке не хранится — это всегда правки последнего снимка
// (источник правды, KTD-23 M1): так «вершина перебазируется на снимок» сама, и в прошлое и
// будущее попадают только состояния, уже нормализованные ядром. Ctrl+Z шлёт `setEdits` с
// состоянием из прошлого; каждая правка — один шаг, групповая тоже (R7).

/** Состояние правок целиком — то, что уходит одним `setEdits` (KTD-3). */
export interface EditState {
  readonly edits: SessionEdits;
  readonly rotate180: boolean;
}

/**
 * Шаг истории: состояние и страницы, которые затронул переход между ним и соседним. По ключам
 * редактор выделяет затронутое после Ctrl+Z / Ctrl+Y; пустой список — выделение не трогать.
 */
export interface HistoryStep {
  readonly state: EditState;
  readonly keys: readonly string[];
}

export interface EditHistory {
  /** Подпись ленты, на которой записаны шаги (`tapeOf`): сменилась — история очищается. */
  readonly tape: string;
  readonly past: readonly HistoryStep[];
  readonly future: readonly HistoryStep[];
}

/** Переход по истории: что отправить в `setEdits` и какую историю поставить после успеха. */
export interface HistoryMove {
  readonly history: EditHistory;
  readonly target: EditState;
  readonly keys: readonly string[];
}

export const sameState = (left: EditState, right: EditState): boolean =>
  left.rotate180 === right.rotate180 && sameEdits(left.edits, right.edits);

/** Правки снимка как состояние стека: тумблер — у прохода оборотов (роль по `kind`, KTD-4). */
export function editStateOf(session: SessionSnapshot): EditState {
  return { edits: session.edits, rotate180: rolesOf(session.passes).backs?.rotate180 ?? false };
}

/**
 * Подпись ленты: сессия, состав проходов — ключи страниц и состояние — и запись сборки (M3.6,
 * KTD5). Правки её не меняют (удаление — пометка, тумблер — не состав); досканирование,
 * «Остановить», приёмка прерванного прохода, «Собрать документ» и новая сессия — меняют: шаги
 * стека позиционные, и после сборки старый шаг положил бы границу не на ту страницу (R14).
 */
export function tapeOf(session: SessionSnapshot): string {
  const passes = session.passes.map(
    (pass) => `${pass.state}:${pass.pages.map((page) => page.key).join(',')}`,
  );
  const assembled = session.assembled === null ? '' : `|assembled:${session.assembled.join(',')}`;
  return `${session.id}|${passes.join('|')}${assembled}`;
}

export const emptyHistory = (tape: string): EditHistory => ({ tape, past: [], future: [] });

/**
 * Пришёл снимок. Та же лента — история как есть: настоящее и так берётся из снимка. Лента
 * изменилась не через правку — история очищается (решение автора, журнал M3): разрезы в шагах
 * позиционные, и старый шаг положил бы границу не на ту страницу.
 */
export function syncHistory(history: EditHistory | null, tape: string): EditHistory {
  return history !== null && history.tape === tape ? history : emptyHistory(tape);
}

/** Новая правка: текущее уходит в прошлое, будущее очищается; без изменений шага нет (`null`). */
export function recordEdit(
  history: EditHistory,
  current: EditState,
  next: EditState,
  keys: readonly string[],
): EditHistory | null {
  if (sameState(current, next)) {
    return null;
  }
  return { tape: history.tape, past: [...history.past, { state: current, keys }], future: [] };
}

/** Ctrl+Z: последнее из прошлого становится целью, текущее уходит в будущее. */
export function undoEdit(history: EditHistory, current: EditState): HistoryMove | null {
  const step = history.past.at(-1);
  if (step === undefined) {
    return null;
  }
  return {
    history: {
      tape: history.tape,
      past: history.past.slice(0, -1),
      future: [{ state: current, keys: step.keys }, ...history.future],
    },
    target: step.state,
    keys: step.keys,
  };
}

/** Ctrl+Y / Ctrl+Shift+Z: первое из будущего становится целью, текущее уходит в прошлое. */
export function redoEdit(history: EditHistory, current: EditState): HistoryMove | null {
  const step = history.future[0];
  if (step === undefined) {
    return null;
  }
  return {
    history: {
      tape: history.tape,
      past: [...history.past, { state: current, keys: step.keys }],
      future: history.future.slice(1),
    },
    target: step.state,
    keys: step.keys,
  };
}
