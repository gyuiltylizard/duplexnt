import { EMPTY_EDITS, sameList, type EditAngle, type SessionEdits } from '@shared';
import type { EditState } from './history';

// Жесты редактора (план M3, U6; KTD-3a): каждый строит следующее состояние правок от правок
// снимка и видимой ленты из снимка. Нормализует только ядро — мёртвые ключи, совпавшие разрезы
// и пустые документы с их именами оно вычистит само. Здесь — одно правило, которого ядро знать
// не может: разрез — позиция между соседями, и жест, сдвигающий страницы, сдвигает разрезы так,
// чтобы неподвижные соседи остались по своим сторонам (AE5; журнал M3, требование к U6). Граница
// наборов (M3.6, KTD8) — тоже позиция, но её жест задаёт явно: группа перенесённых — группа
// страницы-цели, а не «та же, что была».

/** «Вернуть»: правок нет, поворот оборотов выключен у всех пачек — пустая карта (R9; M4.5, KTD4). */
export const REVERTED: EditState = { edits: EMPTY_EDITS, rotate180: new Map() };

/** Тумблер 180° (M4.5, KTD4): флаг прохода оборотов `pass` — одной пачки; остальные как были. */
export function rotatedBacks(state: EditState, pass: number, on: boolean): EditState {
  return { edits: state.edits, rotate180: new Map(state.rotate180).set(pass, on) };
}

/** Куда бросили: перед страницей под курсором или после неё (половина миниатюры, KTD-8). */
export type DropSide = 'before' | 'after';

/** Группа ленты в режиме раздельных наборов (M3.6, R17): лица — до границы, обороты — после. */
export type SetSide = 'fronts' | 'backs';

/** Разрезы после изъятия страниц с позиций `removed`: каждый сдвигается на изъятые левее него. */
function cutsWithout(cuts: readonly number[], removed: readonly number[]): number[] {
  return cuts.map((cut) => cut - removed.filter((index) => index < cut).length);
}

/** Позиции ленты, занятые страницами из `keys`, по возрастанию. */
const positionsOf = (visible: readonly string[], keys: ReadonlySet<string>): number[] =>
  visible.flatMap((key, index) => (keys.has(key) ? [index] : []));

/** Направление поворота: «↻» — по часовой (+90°), «↺» — против (−90°, M3.5, KTD-11). */
export type RotateDirection = 'cw' | 'ccw';

/** Поворот на 90° каждой из страниц в заданную сторону; полный оборот снимает запись. */
export function rotated(
  edits: SessionEdits,
  keys: readonly string[],
  direction: RotateDirection = 'cw',
): SessionEdits {
  const rotations = new Map(Object.entries(edits.rotations));
  const step = direction === 'cw' ? 90 : 270;
  for (const key of new Set(keys)) {
    const angle = ((rotations.get(key) ?? 0) + step) % 360;
    if (angle === 0) {
      rotations.delete(key); // 0 в журнале не хранится
    } else {
      rotations.set(key, angle as EditAngle);
    }
  }
  return { ...edits, rotations: Object.fromEntries(rotations) };
}

/**
 * Удаление — пометка (R3): файлы не трогаются. Разрезы правее удалённых сдвигаются влево —
 * документы соседей не меняются; опустевший документ схлопнет ядро (AE6).
 */
export function deleted(
  edits: SessionEdits,
  visible: readonly string[],
  keys: readonly string[],
): SessionEdits {
  const removing = new Set(keys);
  const removed = positionsOf(visible, removing);
  if (removed.length === 0) {
    return edits;
  }
  const marked = new Set(edits.deleted);
  const added = visible.filter((key) => removing.has(key) && !marked.has(key));
  return {
    ...edits,
    deleted: [...edits.deleted, ...added],
    cuts: cutsWithout(edits.cuts, removed),
    // Явная граница наборов — тоже позиция: сдвигается на удалённые левее, как разрез; авто (null)
    // ядро пересчитает само (M3.6; ревью #3).
    divider: edits.divider === null ? null : (cutsWithout([edits.divider], removed)[0] ?? null),
  };
}

/**
 * Перенос страниц (группа — с внутренним порядком ленты) к странице `target`. Разрез на месте
 * вставки решает сторона: «после последней страницы документа» — страницы остаются в нём,
 * «перед первой следующего» — уходят в следующий. Бросок на перетаскиваемую страницу или
 * перенос без изменений — `null` (шага нет). Первый перенос фиксирует порядок явным (R7).
 */
export function moved(
  edits: SessionEdits,
  visible: readonly string[],
  keys: readonly string[],
  target: string,
  side: DropSide,
): SessionEdits | null {
  const moving = new Set(keys);
  if (moving.has(target) || !visible.includes(target)) {
    return null;
  }
  const group = visible.filter((key) => moving.has(key));
  if (group.length === 0) {
    return null;
  }
  const removed = positionsOf(visible, moving);
  const rest = visible.filter((key) => !moving.has(key));
  const at = rest.indexOf(target) + (side === 'after' ? 1 : 0);
  const cuts = cutsWithout(edits.cuts, removed).map((cut) =>
    cut > at || (cut === at && side === 'after') ? cut + group.length : cut,
  );
  const order = [...rest.slice(0, at), ...group, ...rest.slice(at)];
  if (sameList(order, visible) && sameList(cuts, edits.cuts)) {
    return null;
  }
  return { ...edits, order, cuts };
}

/**
 * Граница наборов после переноса `keys` к странице на позиции `target` видимой ленты (M3.6,
 * KTD8): перенесённые берут группу страницы-цели — смешанное выделение целиком. Новая граница =
 * старая − перенесённых из лиц + все перенесённые, если цель в группе лиц. Перенос внутри группы
 * границу не меняет.
 */
export function dividerAfterMove(
  visible: readonly string[],
  divider: number,
  keys: readonly string[],
  target: number,
): number {
  const moving = new Set(keys);
  const all = visible.filter((key) => moving.has(key)).length;
  return divider - movedFromFronts(visible, divider, moving) + (target < divider ? all : 0);
}

/** Сколько из переносимых страниц стояло в группе лиц (до границы). */
const movedFromFronts = (
  visible: readonly string[],
  divider: number,
  moving: ReadonlySet<string>,
): number => visible.slice(0, divider).filter((key) => moving.has(key)).length;

/**
 * Перенос `keys` через границу наборов без страницы-цели (M3.6, KTD8): бросок на разделитель
 * (верх — в конец лиц, низ — в начало оборотов) или в пустую группу. Страницы встают вплотную к
 * границе со стороны `side` в порядке ленты; порядок меняется, только если выделение к границе
 * не прилегало. Без изменений порядка и границы — `null` (шага нет). Порядок фиксируется явным,
 * как при любом переносе (R7).
 */
export function movedAcross(
  edits: SessionEdits,
  visible: readonly string[],
  divider: number,
  keys: readonly string[],
  side: SetSide,
): SessionEdits | null {
  const moving = new Set(keys);
  const group = visible.filter((key) => moving.has(key));
  if (group.length === 0) {
    return null;
  }
  const rest = visible.filter((key) => !moving.has(key));
  const at = divider - movedFromFronts(visible, divider, moving);
  const order = [...rest.slice(0, at), ...group, ...rest.slice(at)];
  const next = side === 'fronts' ? at + group.length : at;
  if (sameList(order, visible) && next === divider) {
    return null;
  }
  return { ...edits, order, divider: next };
}

/**
 * Граница перед позицией `position` видимой ленты длины `length`: новый документ с пустым
 * именем. Перед первой страницей и там, где граница уже стоит, — `null` (R10).
 */
export function withCut(
  edits: SessionEdits,
  position: number,
  length: number,
): SessionEdits | null {
  if (position <= 0 || position >= length || edits.cuts.includes(position)) {
    return null;
  }
  const index = edits.cuts.filter((cut) => cut < position).length;
  return {
    ...edits,
    cuts: [...edits.cuts.slice(0, index), position, ...edits.cuts.slice(index)],
    names: [...edits.names.slice(0, index + 1), '', ...edits.names.slice(index + 1)],
  };
}

/**
 * Снять границу перед документом `docIndex` (с нуля; у первого документа границы нет — без
 * изменений): его имя уходит вместе с ней (R12).
 */
export function withoutCut(edits: SessionEdits, docIndex: number): SessionEdits {
  if (docIndex <= 0 || docIndex > edits.cuts.length) {
    return edits;
  }
  return {
    ...edits,
    cuts: edits.cuts.filter((_, index) => index !== docIndex - 1),
    names: edits.names.filter((_, index) => index !== docIndex),
  };
}

/**
 * «Это не пустая страница» (M4, KTD5; handoff M4, S9): ключ входит в `notBlank` — любой флаг
 * детектора снимается, страница возвращается в ленту и в файл. Обратной пометки нет: лишнее
 * удаляется. Уже помеченная — без изменений (шага нет).
 */
export function markedNotBlank(edits: SessionEdits, key: string): SessionEdits {
  if (edits.notBlank.includes(key)) {
    return edits;
  }
  return { ...edits, notBlank: [...edits.notBlank, key] };
}

/** Имя документа `docIndex` (с нуля); пустая строка — имя по умолчанию. */
export function renamed(edits: SessionEdits, docIndex: number, name: string): SessionEdits {
  if (docIndex < 0 || docIndex >= edits.names.length || edits.names[docIndex] === name) {
    return edits;
  }
  return {
    ...edits,
    names: edits.names.map((current, index) => (index === docIndex ? name : current)),
  };
}

/**
 * «Выделить в документ»: подряд идущие позиции `from…to` становятся отдельным документом —
 * границы до и после куска одним шагом; в начале и в конце ленты лишних нет (UI_SPEC §6.5).
 * Границы внутри куска снимаются вместе с именами документов, которые они начинали, — иначе
 * вместо одного документа вышло бы несколько. Хвост за куском, чей документ начинался внутри
 * куска, сохраняет его имя. Возвращает правки и номер нового документа (с нуля) — туда уходит
 * фокус имени.
 */
export function separated(
  edits: SessionEdits,
  from: number,
  to: number,
  length: number,
): { readonly edits: SessionEdits; readonly document: number } {
  const inside = (cut: number): boolean => cut > from && cut <= to;
  // Документ страницы за куском — до жеста; его имя переезжает на хвост, если граница,
  // с которой он начинался, снимается.
  const tail = edits.cuts.filter((cut) => cut <= to + 1).length;
  const tailStart = edits.cuts[tail - 1];
  const tailName =
    to + 1 < length && tailStart !== undefined && inside(tailStart) ? edits.names[tail] : undefined;

  let next: SessionEdits = edits.cuts.some(inside)
    ? {
        ...edits,
        cuts: edits.cuts.filter((cut) => !inside(cut)),
        // Имя документа с номером `index` начинается с разреза `index - 1`; у первого его нет.
        names: edits.names.filter((_, index) => {
          const start = edits.cuts[index - 1];
          return start === undefined || !inside(start);
        }),
      }
    : edits;
  for (const position of [from, to + 1]) {
    next = withCut(next, position, length) ?? next;
  }
  const docIndex = next.cuts.filter((cut) => cut <= from).length;
  if (tailName !== undefined) {
    next = renamed(next, docIndex + 1, tailName);
  }
  return { edits: next, document: docIndex };
}

/**
 * «Выделить в документ» для любого выделения (M4, KTD7; handoff M4, S6): страницы `keys` подряд —
 * только разрезы, как `separated`; не подряд — явный порядок (выделенные встают на позицию
 * первой из них, остальные сдвигаются вправо, взаимный порядок не меняется) и разрезы по
 * арифметике `moved`, затем границы до и после куска. Ключей в ленте нет — `null` (жеста нет).
 * Группировка не подряд — перенос: порядок становится явным (R7).
 */
export function grouped(
  edits: SessionEdits,
  visible: readonly string[],
  keys: readonly string[],
): { readonly edits: SessionEdits; readonly document: number } | null {
  const grouping = new Set(keys);
  const positions = positionsOf(visible, grouping);
  const from = positions[0];
  if (from === undefined) {
    return null;
  }
  const to = from + positions.length - 1;
  if (positions.at(-1) === to) {
    return separated(edits, from, to, visible.length);
  }
  const group = visible.filter((key) => grouping.has(key));
  const rest = visible.filter((key) => !grouping.has(key));
  // Кусок встаёт на позицию первой выделенной: разрез на этой позиции остаётся слева от куска,
  // разрезы правее (по исходной ленте — и тот, что стоял сразу за первой выделенной) уезжают за
  // кусок, как у `moved` «перед»; сдвиг на изъятые левее — как у `cutsWithout`.
  const cuts = edits.cuts.map((cut) => {
    const shifted = cut - positions.filter((index) => index < cut).length;
    return cut > from ? shifted + group.length : shifted;
  });
  const order = [...rest.slice(0, from), ...group, ...rest.slice(from)];
  return separated({ ...edits, order, cuts }, from, to, visible.length);
}
