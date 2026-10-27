import type { AssembledDocument, AssembledPage, AssemblyMode } from '@shared';

// Показанная лента (план M4, U6; KTD4; handoff M4, S1, S3, Behaviour): ядро отдаёт полную
// видимую ленту с флагами пустых оборотов, renderer показывает её без скрытых, пока переключатель
// «Пустые» выключен. Всё, что видит человек, — текущая, выделение, стрелки, нумерация,
// счётчики, якоря — считается по показанной ленте; правки (порядок, разрезы, удаления, граница)
// — по полной: позиции показанной переводятся в позиции полной перед отправкой (R11–R13).
// Пустой оборот склеен со своим листом независимо от переключателя (B-13, ниже): перенос,
// группировка, удаление и якорь «после текущей» захватывают его; скрытый хвост R12 — частный
// случай склейки.

/** Документ в координатах показанной ленты; `index` — номер в полной (имена, разрезы, тон). */
export interface ShownDocument {
  readonly index: number;
  readonly name: string;
  /** Позиция первой показанной страницы; у документа без показанных — где он стоял бы. */
  readonly start: number;
  /** Показанных страниц; 0 — документ из одних скрытых. */
  readonly count: number;
}

/** Показанная лента: полная при включённом переключателе, иначе без скрытых. */
export function shownOf(
  order: readonly AssembledPage[],
  reveal: boolean,
): readonly AssembledPage[] {
  return reveal ? order : order.filter((page) => page.blank !== 'hidden');
}

// Склеенный оборот (B-13, план 2026-10-27-005, KTD-1): пустой оборот — часть своего листа при
// любом состоянии переключателя и в обоих режимах пустых. Склеен пустой оборот (`blank !== null`;
// флаг ядро ставит только страницам прохода оборотов, сторона не проверяется — в режиме «собрано»
// она позиционная), стоящий сразу за страницей того же документа; цепочка пустых подряд за одной
// страницей — все её. Пара уточняет «чей»: в режиме пар при известных листах у обеих должны
// совпасть набор и лист, иначе цепочка обрывается — оборот, разнесённый со своим лицом поздним
// вердиктом или старой перестановкой, к чужому лицу не клеится. В режиме раздельных наборов
// пар нет — склейки нет. Хвост R12 — частный случай: скрытый оборот склеен так же.

/** Карта «оборот → лицо» склеенных оборотов полной ленты; `starts` — начала документов. */
export type GluedBacks = ReadonlyMap<string, string>;

export const NO_GLUE: GluedBacks = new Map();

const pairMatches = (face: AssembledPage, back: AssembledPage, mode: AssemblyMode): boolean =>
  mode !== 'pairs' ||
  face.sheet === null ||
  back.sheet === null ||
  (face.addedSet === back.addedSet && face.sheet === back.sheet);

export function gluedBacksOf(
  order: readonly AssembledPage[],
  starts: ReadonlySet<number>,
  mode: AssemblyMode,
): GluedBacks {
  const glued = new Map<string, string>();
  if (mode === 'sets') {
    return glued;
  }
  // Лицо текущей цепочки — последняя страница, которая сама не склеена.
  let face: AssembledPage | null = null;
  for (const [index, page] of order.entries()) {
    if (starts.has(index)) {
      face = null;
    }
    if (face !== null && page.blank !== null && pairMatches(face, page, mode)) {
      glued.set(page.key, face.key);
    } else {
      face = page;
    }
  }
  return glued;
}

/** Ключи листа страницы в порядке ленты: лицо и все его склеенные обороты; чужой ключ — `[]`. */
export function sheetOf(key: string, glued: GluedBacks, order: readonly string[]): string[] {
  const face = glued.get(key) ?? key;
  return order.filter((one) => one === face || glued.get(one) === face);
}

/** Склеенные обороты лиц из `keys` — в порядке ленты. */
const backsOf = (keys: ReadonlySet<string>, glued: GluedBacks, order: readonly string[]) =>
  order.filter((key) => {
    const face = glued.get(key);
    return face !== undefined && keys.has(face);
  });

/**
 * Что едет при переносе и что входит в «Выделить в документ» (KTD-3): лицо добирает свои
 * обороты, склеенный оборот без своего лица выпадает. Порядок — полной ленты.
 */
export function movingOf(
  keys: readonly string[],
  glued: GluedBacks,
  order: readonly string[],
): string[] {
  const wanted = new Set(keys);
  const faces = new Set(keys.filter((key) => !glued.has(key)));
  const backs = new Set(backsOf(faces, glued, order));
  return order.filter((key) => backs.has(key) || (wanted.has(key) && !glued.has(key)));
}

/**
 * Что уходит при удалении (KTD-3): выделенные страницы и обороты выделенных лиц; склеенный
 * оборот, выделенный сам по себе, удаляется сам — удаление буквальное.
 */
export function removingOf(
  keys: readonly string[],
  glued: GluedBacks,
  order: readonly string[],
): string[] {
  const wanted = new Set(keys);
  const backs = new Set(backsOf(wanted, glued, order));
  return order.filter((key) => wanted.has(key) || backs.has(key));
}

/** Сторона броска относительно миниатюры. */
export type SheetSide = 'before' | 'after';

/**
 * Цель броска с учётом склейки (R6): бросок на склеенный оборот слева — перед его лицом, справа
 * — после последней страницы листа; «после» лица — после его листа. Цель внутри листа
 * перетаскиваемого — `null`: бросок лица на свой оборот ничего не делает.
 */
export function sheetDrop(
  target: string,
  side: SheetSide,
  moving: readonly string[],
  glued: GluedBacks,
  order: readonly string[],
): { readonly key: string; readonly side: SheetSide } | null {
  const sheet = sheetOf(target, glued, order);
  const face = sheet[0] ?? target;
  if (moving.includes(face)) {
    return null;
  }
  return side === 'before' ? { key: face, side } : { key: sheet.at(-1) ?? target, side };
}

/**
 * Куда переезжает текущая, которой нет среди показанных (стала скрытой): на своё лицо, если она
 * склеенный оборот и лицо показано; иначе ближайшая показанная справа по полной ленте, в конце —
 * слева; показанных нет — `null`. Показанная текущая остаётся.
 */
export function relocate(
  current: string,
  shown: readonly string[],
  order: readonly string[],
  glued: GluedBacks = NO_GLUE,
): string | null {
  const visible = new Set(shown);
  if (visible.has(current)) {
    return current;
  }
  const face = glued.get(current);
  if (face !== undefined && visible.has(face)) {
    return face;
  }
  const at = order.indexOf(current);
  if (at < 0) {
    return null;
  }
  const right = order.slice(at + 1).find((key) => visible.has(key));
  if (right !== undefined) {
    return right;
  }
  return order.slice(0, at).findLast((key) => visible.has(key)) ?? null;
}

/**
 * Документы полной ленты в координатах показанной: `start` и `count` — по показанным страницам,
 * `index` — номер в полной ленте (имена, разрезы, тон не меняются). Документ из одних скрытых
 * получает `count: 0` и позицию, где стоял бы.
 */
export function shownDocumentsOf(
  documents: readonly AssembledDocument[],
  order: readonly AssembledPage[],
  shown: readonly AssembledPage[],
): readonly ShownDocument[] {
  const positions = new Map(shown.map((page, index) => [page.key, index]));
  let next = 0;
  return documents.map((document, index) => {
    const pages = order.slice(document.start, document.start + document.count).flatMap((page) => {
      const position = positions.get(page.key);
      return position === undefined ? [] : [position];
    });
    const start = pages[0] ?? next;
    next = start + pages.length;
    return { index, name: document.name, start, count: pages.length };
  });
}
