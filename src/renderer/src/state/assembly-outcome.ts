import type { AssemblyReport } from '@shared';

// Классификация отчёта сборки — одна на статусную строку `merge` и модалку `mismatch`:
// порядок веток закреплён здесь, и два экрана не могут назвать одну сборку по-разному.
// С M3.6 ветвится по режиму (KTD7): несовпадение — это режим раздельных наборов, числа — по
// проходам (в тулбаре и ПРОВЕРКЕ — живые счётчики групп из `assembly.sets`).

export type AssemblyOutcome = 'frontsOnly' | 'accepted' | 'fewer' | 'extra' | 'ok';

export function assemblyOutcome(report: AssemblyReport): AssemblyOutcome {
  if (report.backsDeclined) {
    return 'frontsOnly';
  }
  // Принятый коротким (или длинным) проход важнее арифметики: человек уже решил.
  if (report.backsState === 'accepted') {
    return 'accepted';
  }
  if (report.mode === 'sets') {
    return report.backs < report.fronts ? 'fewer' : 'extra';
  }
  return 'ok';
}

/** Сборка «состоялась» — условие паузы `merge` (KTD-5): проход оборотов завершён или не нужен. */
export function assemblyLanded(report: AssemblyReport): boolean {
  return report.backsState === 'completed' || report.backsDeclined;
}

/**
 * Несовпадение заслуживает модалки (M2, KTD-8; M3.6, R20): режим раздельных наборов активен и
 * исход окончателен — проход оборотов завершён или принят. Добавленные наборы показ не
 * отменяют: режим активен — объяснение нужно, в том числе после перезапуска. Прерванный
 * непринятый проход модалку не зовёт: решение ещё за человеком, его ведёт плашка
 * досканирования. После сборки и в режиме пар — нет.
 */
export function mismatchDue(report: AssemblyReport): boolean {
  return (
    report.mode === 'sets' &&
    (report.backsState === 'completed' || report.backsState === 'accepted')
  );
}
