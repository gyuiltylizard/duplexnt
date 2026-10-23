import {
  passesByKind,
  sessionConflict,
  type AssembledPage,
  type BlankSummary,
  type PageSnapshot,
  type Result,
  type SessionSnapshot,
} from '@shared';

// Пустые обороты в службе проходов (план M4, U4; KTD3, KTD4, KTD9): какие страницы оценивает
// детектор и чем отвечает запись PDF, пока оценки не пришли или документ оказался из одних
// скрытых. Чистые функции — служба только зовёт их.

/**
 * Страницы, которые получают оценку (KTD9): только проход оборотов, только не потерянные, и
 * только при режиме сессии ≠ «Оставлять». Лица и добавленные наборы не оцениваются.
 */
export function pagesToScore(session: SessionSnapshot | null): readonly PageSnapshot[] {
  if (session === null || session.blankMode === 'keep') {
    return [];
  }
  const backs = passesByKind(session.passes, (pass) => pass.pages.length > 0).backs;
  return (backs?.pages ?? []).filter((page) => !page.lost);
}

/** Документы без скрытых пустых оборотов (R10): режутся по полной ленте, пишутся без них. */
export function shownSpansOf(
  spans: readonly (readonly AssembledPage[])[],
): readonly (readonly AssembledPage[])[] {
  return spans.map((span) => span.filter((page) => page.blank !== 'hidden'));
}

/**
 * Отказ записи по пустым оборотам (KTD4), после `notAssembled`: оценки ещё идут —
 * `blankPending` с числом (файл без них молча унёс бы пустые обороты в документ); все документы
 * пусты — `nothingToSave`; часть пуста — `documentBlank` с номерами документов от 1 через
 * запятую (детали ошибки — плоские). `null` — писать можно.
 */
export function blankRefusal(
  blank: BlankSummary,
  shown: readonly (readonly AssembledPage[])[],
): Result<never> | null {
  if (blank.pending > 0) {
    return { ok: false, error: sessionConflict('blankPending', { pending: blank.pending }) };
  }
  if (shown.every((span) => span.length === 0)) {
    return { ok: false, error: sessionConflict('nothingToSave') };
  }
  const empty = shown.flatMap((span, index) => (span.length === 0 ? [index + 1] : []));
  return empty.length === 0
    ? null
    : { ok: false, error: sessionConflict('documentBlank', { documents: empty.join(',') }) };
}
