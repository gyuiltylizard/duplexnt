import type { AssemblyReport, PassSnapshot } from '@shared';
import { rolesOf } from './screen';

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
 * Несовпадение заслуживает модалки (KTD-8) и подсказки про «+ Добавить» в ПРОВЕРКЕ (M3.5,
 * KTD-7): отчёт несёт его, исход окончателен — проход оборотов завершён или принят — и в
 * сессии нет добавленного набора со страницами: добавление — ответ человека на несовпадение,
 * после него модалка не показывается и после перезапуска. Прерванный непринятый проход модалку
 * не зовёт: решение ещё за человеком, его ведёт плашка досканирования.
 */
export function mismatchDue(report: AssemblyReport, passes: readonly PassSnapshot[]): boolean {
  return (
    report.mismatch &&
    (report.backsState === 'completed' || report.backsState === 'accepted') &&
    rolesOf(passes).added.length === 0
  );
}
