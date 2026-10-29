import { isBacksKind, type BlankVerdicts, type PageSnapshot, type SessionSnapshot } from '@shared';

// Выравнивание перекоса в службе проходов (план M6, U5; R6, KTD-4): какие страницы получают
// измерение. Чистые функции — служба только зовёт их.

/**
 * Страницы, которые измеряются (R6): все проходы сессии в режиме «выравнивать», только не
 * потерянные; у оборотов при режиме пустых ≠ «Оставлять» — только с вердиктом «не пусто» или с
 * пометкой «Это не пустая страница» (решение пользователя важнее оценки). Оборот без вердикта
 * ещё не измеряется — измерение запускает приход вердикта. В режиме «не выравнивать» — никто.
 */
export function pagesToMeasure(
  session: SessionSnapshot | null,
  blank: BlankVerdicts,
): readonly PageSnapshot[] {
  if (session?.straighten !== 'auto') {
    return [];
  }
  const notBlank = new Set(session.edits.notBlank);
  const scored = session.blankMode !== 'keep';
  return session.passes.flatMap((pass) =>
    pass.pages.filter((page) => {
      if (page.lost) {
        return false;
      }
      if (!scored || !isBacksKind(pass.kind) || notBlank.has(page.key)) {
        return true;
      }
      return blank.get(page.key) === false;
    }),
  );
}
