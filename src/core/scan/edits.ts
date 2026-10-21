import {
  EDIT_ANGLES,
  sameList,
  type AssembledDocument,
  type EditAngle,
  type PageAngle,
  type SessionEdits,
} from '@shared';

// Правки редактора поверх автопорядка (план M3, U2; ADR 0004, амендменты 2026-10-06 и
// 2026-10-07). Чистые функции над ключами страниц: ленту считает только ядро (KTD-2),
// нормализацию делает только ядро (KTD-3a) — renderer шлёт итоговое состояние как построил,
// хранилище приводит его к каноническому виду перед записью.
//
// Канонический вид: в `order`, `rotations` и `deleted` только ключи живых страниц, без
// повторов; разрезы строго внутри видимой ленты и по возрастанию — пустых документов нет;
// имён ровно на одно больше, чем разрезов. В режиме раздельных наборов (M3.6, KTD3) разрезов и
// имён нет — вместо них граница наборов `divider` в пределах ленты (0 и «все» допустимы),
// `null` при равенстве авто; вне режима граница всегда `null`. Нормализация идемпотентна.

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
 * Видимая лента: явный порядок, за ним — ключи, которых в нём нет, в автопорядке (неразмещённые:
 * новый ключ без предшественника в `order`, см. `rebaseOrder`); удалённые не показываются.
 * Пустой `order` — автосортировка: лента равна автопорядку.
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

/**
 * Против чего нормализуются разрезы и граница (M3.6, R8): в режиме пар и «собрано» живут
 * разрезы, граница — `null`; в режиме раздельных наборов — граница с авто-значением `auto`
 * (число видимых лиц), разрезов нет; переходный — идёт проход оборотов: режим ленты «пары», но
 * ни разрезы, ни граница не обрезаются до остановки прохода, иначе досканирование стирало бы
 * расстановку, а запуск оборотов — разрезы.
 */
export type EditsContext =
  | { readonly kind: 'pairs' }
  | { readonly kind: 'sets'; readonly auto: number }
  | { readonly kind: 'transit' };

export const PAIRS_CONTEXT: EditsContext = { kind: 'pairs' };
export const TRANSIT_CONTEXT: EditsContext = { kind: 'transit' };
export const setsContext = (auto: number): EditsContext => ({ kind: 'sets', auto });

/**
 * Граница наборов внутри ленты длины `length` (KTD3): выход за края прижимается, равная
 * автоматической `auto` — `null` (`auto` неизвестно в переходном состоянии — только прижатие).
 * В отличие от разреза не схлопывается: группа без видимых страниц существует.
 */
function normalizeDivider(
  divider: number | null,
  auto: number | null,
  length: number,
): number | null {
  if (divider === null) {
    return null;
  }
  const clamped = Math.min(length, Math.max(0, Math.trunc(divider)));
  return clamped === auto ? null : clamped;
}

/** Канонический вид правок для сессии с базовым порядком `autoKeys` в контексте режима (идемпотентно). */
export function normalizeEdits(
  autoKeys: readonly string[],
  edits: SessionEdits,
  context: EditsContext = PAIRS_CONTEXT,
): SessionEdits {
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
  const base = { order, rotations, deleted };
  switch (context.kind) {
    case 'sets':
      // «Равна авто» значит «та же граница» только при автопорядке: при явном порядке позиции и
      // базовые группы расходятся, и схлопнутая к null граница пересчиталась бы по группам
      // (ревью M3.6, #4).
      return {
        ...base,
        cuts: [],
        names: [''],
        divider: normalizeDivider(edits.divider, order.length === 0 ? context.auto : null, length),
      };
    case 'transit':
      return {
        ...base,
        ...normalizeCuts(edits.cuts, edits.names, length),
        divider: normalizeDivider(edits.divider, null, length),
      };
    default:
      return { ...base, ...normalizeCuts(edits.cuts, edits.names, length), divider: null };
  }
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
 * Ручной порядок после появления новых ключей (M3.5, KTD-3; ADR 0004, амендмент 2026-10-07):
 * каждый новый ключ (есть в `after`, нет в `before`) встаёт в `order` сразу после ближайшего
 * предшественника по новому автопорядку, который в `order` есть; предшественника нет — ключ не
 * размещается (лента покажет его в конце, `visibleKeysOf`). Новые ключи обходятся в порядке
 * автопорядка, каждый следующий видит уже вставленные: страницы одного сегмента ложатся подряд.
 * Одно правило для всех проходов — добавленного с якорем и досканированного. Это перебазирование,
 * как `remapCuts`, а не правка: расстановка пользователя не переставляется.
 */
export function rebaseOrder(
  before: readonly string[],
  after: readonly string[],
  order: readonly string[],
): string[] {
  const known = new Set(before);
  const placed = [...order];
  for (const [index, key] of after.entries()) {
    if (known.has(key)) {
      continue;
    }
    for (let back = index - 1; back >= 0; back -= 1) {
      const at = placed.indexOf(after[back] ?? '');
      if (at !== -1) {
        placed.splice(at + 1, 0, key);
        break;
      }
    }
  }
  // Мёртвые ключи вычищает нормализация — здесь только расстановка.
  return placed;
}

/**
 * Правки после изменения сессии: если состав живых страниц поменялся (`beforeKeys` — базовый
 * порядок до изменения; `null` — сравнивать не с чем), новые ключи встают в ручной порядок на
 * своё место (`rebaseOrder`), разрезы и граница наборов переносятся вслед за страницами (граница
 * — той же функцией, что разрезы: перед той же страницей, R9); затем нормализация против нового
 * базового порядка в контексте режима (`context` — как у `normalizeEdits`). Правки с
 * исчезнувшими ключами вычищаются здесь же.
 */
export function rebaseEdits(
  beforeKeys: readonly string[] | null,
  afterKeys: readonly string[],
  edits: SessionEdits,
  context: EditsContext = PAIRS_CONTEXT,
): SessionEdits {
  const changed = beforeKeys !== null && !sameList(beforeKeys, afterKeys);
  if (!changed) {
    return normalizeEdits(afterKeys, edits, context);
  }
  const rebased = { ...edits, order: rebaseOrder(beforeKeys, afterKeys, edits.order) };
  const before = visibleKeysOf(beforeKeys, edits);
  const after = visibleKeysOf(afterKeys, rebased);
  const cuts = edits.cuts.length > 0 ? remapCuts(before, after, edits.cuts) : edits.cuts;
  const divider =
    edits.divider === null ? null : (remapCuts(before, after, [edits.divider])[0] ?? null);
  return normalizeEdits(afterKeys, { ...rebased, cuts, divider }, context);
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

/** Есть ли что откатывать «Вернуть»: любая правка или включённый поворот оборотов (R8, R9). */
export function hasEdits(edits: SessionEdits, rotateBacks: boolean): boolean {
  return (
    rotateBacks ||
    edits.order.length > 0 ||
    Object.keys(edits.rotations).length > 0 ||
    edits.deleted.length > 0 ||
    edits.cuts.length > 0 ||
    edits.names.some((name) => name !== '') ||
    edits.divider !== null
  );
}
