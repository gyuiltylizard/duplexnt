import { relocate } from './shown';

// Выделение в ленте редактора (план M3, U6; UI_SPEC §6.5; handoff M3, Behaviour): текущая
// страница (её показывает превью), якорь диапазона и набор выделенных. Текущая выделена всегда;
// набор хранится в порядке ленты — групповые операции идут в нём же (R7). С M4 лента здесь —
// показанная (без скрытых пустых оборотов, handoff M4, R11): скрытые ключи из выделения
// выпадают, а текущая, ставшая скрытой, переезжает на ближайшую показанную.

export interface Selection {
  /** Страница превью и точка входа клавиатуры; `null` — лента пуста. */
  readonly current: string | null;
  /** Начало диапазона для Shift. */
  readonly anchor: string | null;
  /** Выделенные — в порядке ленты; текущая среди них. */
  readonly keys: readonly string[];
}

export const NO_SELECTION: Selection = { current: null, anchor: null, keys: [] };

/** Клик: одна страница, она же текущая и якорь. */
export const single = (key: string): Selection => ({ current: key, anchor: key, keys: [key] });

const inTapeOrder = (visible: readonly string[], keys: Iterable<string>): string[] => {
  const wanted = new Set(keys);
  return visible.filter((key) => wanted.has(key));
};

/** Shift+клик и Shift+стрелка: диапазон от якоря до `key`; якорь остаётся. */
export function ranged(selection: Selection, key: string, visible: readonly string[]): Selection {
  const anchor = selection.anchor ?? key;
  const from = visible.indexOf(anchor);
  const to = visible.indexOf(key);
  if (from < 0 || to < 0) {
    return single(key);
  }
  return {
    current: key,
    anchor,
    keys: visible.slice(Math.min(from, to), Math.max(from, to) + 1),
  };
}

/**
 * Ctrl+клик и Ctrl+Space: добавить или убрать страницу. Добавленная становится текущей и
 * якорем; у убранной текущей становится ближайшая из оставшихся. Последнюю убрать нельзя.
 */
export function toggled(selection: Selection, key: string, visible: readonly string[]): Selection {
  if (!selection.keys.includes(key)) {
    return { current: key, anchor: key, keys: inTapeOrder(visible, [...selection.keys, key]) };
  }
  const keys = selection.keys.filter((selected) => selected !== key);
  if (keys.length === 0) {
    return selection;
  }
  // Убрали не текущую — текущая остаётся; якорь, если убрали его, переходит на текущую.
  if (selection.current !== null && key !== selection.current) {
    const anchor =
      selection.anchor !== null && keys.includes(selection.anchor)
        ? selection.anchor
        : selection.current;
    return { current: selection.current, anchor, keys };
  }
  const position = visible.indexOf(key);
  const nearest = keys.reduce((best, candidate) =>
    Math.abs(visible.indexOf(candidate) - position) < Math.abs(visible.indexOf(best) - position)
      ? candidate
      : best,
  );
  return { current: nearest, anchor: nearest, keys };
}

/** «Снять» и Esc: выделение сжимается до текущей. */
export const collapsed = (selection: Selection): Selection =>
  selection.current === null ? NO_SELECTION : single(selection.current);

/** На что действует ↻ / удалить / перенос: выделение из нескольких или текущая. */
export const targetsOf = (selection: Selection): readonly string[] =>
  selection.keys.length > 1 || selection.current === null ? selection.keys : [selection.current];

/**
 * Выделение после нового снимка: исчезнувшие ключи выпадают, порядок — по новой ленте. Пропала
 * текущая — текущей становится первая уцелевшая выделенная, иначе первая страница ленты.
 * Текущая осталась в полной ленте `order`, но ушла из показанной `visible` (скрыта как пустой
 * оборот, M4 R11) — ближайшая показанная справа, в конце — слева.
 */
export function pruned(
  selection: Selection,
  visible: readonly string[],
  order: readonly string[] = visible,
): Selection {
  const keys = inTapeOrder(visible, selection.keys);
  let current: string | null;
  if (selection.current !== null && visible.includes(selection.current)) {
    current = selection.current;
  } else if (selection.current !== null && order.includes(selection.current)) {
    current = relocate(selection.current, visible, order) ?? keys[0] ?? visible[0] ?? null;
  } else {
    current = keys[0] ?? visible[0] ?? null;
  }
  if (current === null) {
    return NO_SELECTION;
  }
  // Пропавшая текущая сжимает выделение до новой; якорь живёт только внутри выделения.
  const kept = keys.includes(current) ? keys : [current];
  const anchor =
    selection.anchor !== null && kept.includes(selection.anchor) ? selection.anchor : current;
  return { current, anchor, keys: kept };
}

/**
 * После удаления: текущей становится страница, вставшая на место первой удалённой, или
 * последняя, если удалили хвост; выделена она одна.
 */
export function afterRemoval(
  before: readonly string[],
  removed: readonly string[],
  after: readonly string[],
): Selection {
  const gone = new Set(removed);
  const first = before.findIndex((key) => gone.has(key));
  const survivor =
    before.slice(Math.max(first, 0)).find((key) => !gone.has(key)) ?? after.at(-1) ?? null;
  return survivor === null ? NO_SELECTION : single(survivor);
}

/**
 * Выделение затронутых страниц после Ctrl+Z / Ctrl+Y: видимые из `keys` в порядке ленты,
 * текущая — первая из них. Видимых нет (шаг про имя или границу) — `null`: выделение не трогать.
 */
export function selectionOf(keys: readonly string[], visible: readonly string[]): Selection | null {
  const ordered = inTapeOrder(visible, keys);
  const first = ordered[0];
  return first === undefined ? null : { current: first, anchor: first, keys: ordered };
}
