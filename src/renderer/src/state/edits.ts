import { EMPTY_EDITS, sameList, type EditAngle, type SessionEdits } from '@shared';
import type { EditState } from './history';

// Жесты редактора (план M3, U6; KTD-3a): каждый строит следующее состояние правок от правок
// снимка и видимой ленты из снимка. Нормализует только ядро — мёртвые ключи, совпавшие разрезы
// и пустые документы с их именами оно вычистит само. Здесь — одно правило, которого ядро знать
// не может: разрез — позиция между соседями, и жест, сдвигающий страницы, сдвигает разрезы так,
// чтобы неподвижные соседи остались по своим сторонам (AE5; журнал M3, требование к U6).

/** «Вернуть»: правок нет, поворот оборотов выключен (R9). */
export const REVERTED: EditState = { edits: EMPTY_EDITS, rotate180: false };

/** Куда бросили: перед страницей под курсором или после неё (половина миниатюры, KTD-8). */
export type DropSide = 'before' | 'after';

/** Разрезы после изъятия страниц с позиций `removed`: каждый сдвигается на изъятые левее него. */
function cutsWithout(cuts: readonly number[], removed: readonly number[]): number[] {
  return cuts.map((cut) => cut - removed.filter((index) => index < cut).length);
}

/** Поворот на 90° по часовой каждой из страниц; полный оборот снимает запись. */
export function rotated(edits: SessionEdits, keys: readonly string[]): SessionEdits {
  const rotations = new Map(Object.entries(edits.rotations));
  for (const key of new Set(keys)) {
    const angle = ((rotations.get(key) ?? 0) + 90) % 360;
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
  const removed = visible.flatMap((key, index) => (removing.has(key) ? [index] : []));
  if (removed.length === 0) {
    return edits;
  }
  const marked = new Set(edits.deleted);
  const added = visible.filter((key) => removing.has(key) && !marked.has(key));
  return {
    ...edits,
    deleted: [...edits.deleted, ...added],
    cuts: cutsWithout(edits.cuts, removed),
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
  const removed = visible.flatMap((key, index) => (moving.has(key) ? [index] : []));
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

/** Снять границу перед документом `document` (с единицы): его имя уходит вместе с ней (R12). */
export function withoutCut(edits: SessionEdits, document: number): SessionEdits {
  if (document <= 0 || document > edits.cuts.length) {
    return edits;
  }
  return {
    ...edits,
    cuts: edits.cuts.filter((_, index) => index !== document - 1),
    names: edits.names.filter((_, index) => index !== document),
  };
}

/** Имя документа `document` (с нуля); пустая строка — имя по умолчанию. */
export function renamed(edits: SessionEdits, document: number, name: string): SessionEdits {
  if (document < 0 || document >= edits.names.length || edits.names[document] === name) {
    return edits;
  }
  return {
    ...edits,
    names: edits.names.map((current, index) => (index === document ? name : current)),
  };
}

/**
 * «Выделить в документ»: подряд идущие позиции `from…to` становятся отдельным документом —
 * границы до и после куска одним шагом; в начале и в конце ленты лишних нет (UI_SPEC §6.5).
 * Возвращает правки и номер нового документа (с нуля) — туда уходит фокус имени.
 */
export function separated(
  edits: SessionEdits,
  from: number,
  to: number,
  length: number,
): { readonly edits: SessionEdits; readonly document: number } {
  let next = edits;
  for (const position of [from, to + 1]) {
    next = withCut(next, position, length) ?? next;
  }
  return { edits: next, document: next.cuts.filter((cut) => cut <= from).length };
}
