import type { AssembledDocument, AssembledPage } from '@shared';

// Показанная лента (план M4, U6; KTD4; handoff M4, S1, S3, Behaviour): ядро отдаёт полную
// видимую ленту с флагами пустых оборотов, renderer показывает её без скрытых, пока переключатель
// «Пустые» выключен. Всё, что видит человек, — текущая, выделение, стрелки, нумерация,
// счётчики, якоря — считается по показанной ленте; правки (порядок, разрезы, удаления, граница)
// — по полной: позиции показанной переводятся в позиции полной перед отправкой (R11–R13).
// Скрытый хвост (R12): скрытые обороты, идущие в полной ленте сразу за показанной страницей, —
// её хвост; перенос, группировка, удаление и якорь «после текущей» захватывают его, пока скрытые
// не показаны. При включённом переключателе выделение буквальное.

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

/**
 * Ключи с их скрытыми хвостами в порядке полной ленты: за каждой страницей из `keys` идут
 * скрытые обороты, стоящие сразу за ней, до первой нескрытой. Ключи не из ленты отбрасываются.
 */
export function withHiddenTails(
  keys: readonly string[],
  order: readonly AssembledPage[],
): readonly string[] {
  const wanted = new Set(keys);
  const result: string[] = [];
  let tail = false;
  for (const page of order) {
    if (wanted.has(page.key)) {
      result.push(page.key);
      tail = true;
    } else if (tail && page.blank === 'hidden') {
      result.push(page.key);
    } else {
      tail = false;
    }
  }
  return result;
}

/**
 * Куда переезжает текущая, которой нет среди показанных (стала скрытой): ближайшая показанная
 * справа по полной ленте, в конце — слева; показанных нет — `null`. Показанная текущая остаётся.
 */
export function relocate(
  current: string,
  shown: readonly string[],
  order: readonly string[],
): string | null {
  const visible = new Set(shown);
  if (visible.has(current)) {
    return current;
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
