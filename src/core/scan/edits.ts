import {
  EDIT_ANGLES,
  type AssembledDocument,
  type EditAngle,
  type PageAngle,
  type SessionEdits,
} from '@shared';

// Правки редактора поверх автопорядка (план M3, U2; ADR 0004, амендмент 2026-10-06). Чистые
// функции над ключами страниц: ленту считает только ядро (KTD-2), нормализацию делает только
// ядро (KTD-3a) — renderer шлёт итоговое состояние как построил, хранилище приводит его к
// каноническому виду перед записью.
//
// Канонический вид: в `order`, `rotations` и `deleted` только ключи живых страниц, без
// повторов; разрезы строго внутри видимой ленты и по возрастанию — пустых документов нет;
// имён ровно на одно больше, чем разрезов. Нормализация идемпотентна.

function unique(keys: readonly string[], keep: (key: string) => boolean): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keys) {
    if (!seen.has(key) && keep(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}

/**
 * Видимая лента: явный порядок, за ним — ключи, которых в нём нет, в автопорядке (досканирование
 * при ручном порядке дописывается в конец, R4); удалённые не показываются. Пустой `order` —
 * автосортировка: лента равна автопорядку.
 */
export function visibleKeysOf(autoKeys: readonly string[], edits: SessionEdits): string[] {
  const alive = new Set(autoKeys);
  const ordered = unique(edits.order, (key) => alive.has(key));
  const placed = new Set(ordered);
  const deleted = new Set(edits.deleted);
  return [...ordered, ...autoKeys.filter((key) => !placed.has(key))].filter(
    (key) => !deleted.has(key),
  );
}

/**
 * Разрезы внутри ленты длины `length`: выход за края прижимается, порядок выравнивается, пустой
 * документ схлопывается вместе со своим именем — и в начале ленты, и в середине, и в конце.
 */
export function normalizeCuts(
  cuts: readonly number[],
  names: readonly string[],
  length: number,
): Pick<SessionEdits, 'cuts' | 'names'> {
  const bounds = [0];
  for (const cut of cuts) {
    bounds.push(Math.min(length, Math.max(bounds.at(-1) ?? 0, cut)));
  }
  bounds.push(length);
  const kept: { readonly start: number; readonly name: string }[] = [];
  for (let index = 0; index + 1 < bounds.length; index += 1) {
    const start = bounds[index] ?? 0;
    if ((bounds[index + 1] ?? 0) > start) {
      kept.push({ start, name: names[index] ?? '' });
    }
  }
  // Пустая лента (всё удалено) — один пустой документ; первое имя не теряется.
  if (kept.length === 0) {
    return { cuts: [], names: [names[0] ?? ''] };
  }
  return { cuts: kept.slice(1).map((doc) => doc.start), names: kept.map((doc) => doc.name) };
}

/** Канонический вид правок для сессии с автопорядком `autoKeys` (идемпотентно). */
export function normalizeEdits(autoKeys: readonly string[], edits: SessionEdits): SessionEdits {
  const alive = new Set(autoKeys);
  const isAlive = (key: string): boolean => alive.has(key);
  const rotations: Record<string, EditAngle> = {};
  for (const [key, angle] of Object.entries(edits.rotations)) {
    if (isAlive(key) && EDIT_ANGLES.includes(angle)) {
      rotations[key] = angle;
    }
  }
  const order = unique(edits.order, isAlive);
  const deleted = unique(edits.deleted, isAlive);
  const length = visibleKeysOf(autoKeys, { ...edits, order, deleted }).length;
  return { order, rotations, deleted, ...normalizeCuts(edits.cuts, edits.names, length) };
}

/**
 * Перенос разрезов при изменении ленты вне правок (KTD-10): досканирование вставило страницы,
 * сегмент отброшен, сверка вернула файлы. Разрез остаётся перед той же страницей, что шла за ним;
 * если её нет — перед следующей уцелевшей; не осталось ни одной — уходит в конец (и схлопнется
 * нормализацией). Ручной перенос сюда не попадает: там разрез стоит на месте по определению.
 */
export function remapCuts(
  before: readonly string[],
  after: readonly string[],
  cuts: readonly number[],
): number[] {
  const position = new Map(after.map((key, index) => [key, index]));
  return cuts.map((cut) => {
    for (let index = Math.max(0, cut); index < before.length; index += 1) {
      const moved = position.get(before[index] ?? '');
      if (moved !== undefined) {
        return moved;
      }
    }
    return after.length;
  });
}

/**
 * Правки после изменения сессии: если состав живых страниц поменялся (`beforeKeys` — автопорядок
 * до изменения; `null` — сравнивать не с чем), разрезы переносятся вслед за страницами; затем
 * нормализация против нового автопорядка. Правки с исчезнувшими ключами вычищаются здесь же.
 */
export function rebaseEdits(
  beforeKeys: readonly string[] | null,
  afterKeys: readonly string[],
  edits: SessionEdits,
): SessionEdits {
  const changed =
    beforeKeys !== null &&
    (beforeKeys.length !== afterKeys.length || beforeKeys.some((key, i) => key !== afterKeys[i]));
  const cuts =
    changed && edits.cuts.length > 0
      ? remapCuts(visibleKeysOf(beforeKeys, edits), visibleKeysOf(afterKeys, edits), edits.cuts)
      : edits.cuts;
  return normalizeEdits(afterKeys, { ...edits, cuts });
}

/** Документы ленты по разрезам (правки — уже в каноническом виде). */
export function documentsOf(length: number, edits: SessionEdits): AssembledDocument[] {
  const bounds = [0, ...edits.cuts, length];
  return edits.names.map((name, index) => {
    const start = bounds[index] ?? 0;
    return { name, start, count: (bounds[index + 1] ?? length) - start };
  });
}

/** Угол страницы: ручной поворот плюс 180° прохода оборотов, по модулю 360 (KTD-4). */
export function pageAngle(edit: EditAngle | undefined, rotate180: boolean): PageAngle {
  return (((edit ?? 0) + (rotate180 ? 180 : 0)) % 360) as PageAngle;
}

const sameList = <T>(left: readonly T[], right: readonly T[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Равны ли правки по содержанию. Углы сравниваются по ключам, а не по порядку записи: журнал с
 * диска и нормализованный вход могут перечислять их в разном порядке.
 */
export function sameEdits(left: SessionEdits, right: SessionEdits): boolean {
  const leftAngles = Object.entries(left.rotations);
  return (
    sameList(left.order, right.order) &&
    sameList(left.deleted, right.deleted) &&
    sameList(left.cuts, right.cuts) &&
    sameList(left.names, right.names) &&
    leftAngles.length === Object.keys(right.rotations).length &&
    leftAngles.every(([key, angle]) => right.rotations[key] === angle)
  );
}

/** Есть ли что откатывать «Вернуть»: любая правка или включённый поворот оборотов (R8, R9). */
export function hasEdits(edits: SessionEdits, rotateBacks: boolean): boolean {
  return (
    rotateBacks ||
    edits.order.length > 0 ||
    Object.keys(edits.rotations).length > 0 ||
    edits.deleted.length > 0 ||
    edits.cuts.length > 0 ||
    edits.names.some((name) => name !== '')
  );
}
