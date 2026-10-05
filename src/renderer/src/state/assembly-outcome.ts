import type { AssemblyReport } from '@shared';

// Классификация отчёта сборки — одна на статусную строку `merge` и модалку `mismatch`:
// порядок веток закреплён здесь, и два экрана не могут назвать одну сборку по-разному.

export type AssemblyOutcome = 'frontsOnly' | 'accepted' | 'fewer' | 'extra' | 'ok';

export function assemblyOutcome(report: AssemblyReport): AssemblyOutcome {
  if (report.backsDeclined) {
    return 'frontsOnly';
  }
  // Принятый коротким (или длинным) проход важнее арифметики: человек уже решил.
  if (report.backsState === 'accepted') {
    return 'accepted';
  }
  if (report.unpairedSheets.length > 0) {
    return 'fewer';
  }
  if (report.extraBacks > 0) {
    return 'extra';
  }
  return 'ok';
}

/** Сборка «состоялась» — условие паузы `merge` (KTD-5): проход оборотов завершён или не нужен. */
export function assemblyLanded(report: AssemblyReport): boolean {
  return report.backsState === 'completed' || report.backsDeclined;
}

/**
 * Несовпадение заслуживает модалки (KTD-8): отчёт несёт его, и исход окончателен — проход
 * завершён или принят. Прерванный непринятый проход модалку не зовёт: решение ещё за
 * человеком, его ведёт плашка досканирования.
 */
export function mismatchDue(report: AssemblyReport): boolean {
  return report.mismatch && (report.backsState === 'completed' || report.backsState === 'accepted');
}
