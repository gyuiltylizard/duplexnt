import type { AddedSetReport, AssemblyReport } from '@shared';

// Классификация отчёта сборки — одна на статусную строку `merge` и модалку `mismatch`:
// порядок веток закреплён здесь, и два экрана не могут назвать одну сборку по-разному.
// С M3.6 ветвится по режиму (KTD7): несовпадение — это режим раздельных наборов, числа — по
// проходам (в тулбаре и ПРОВЕРКЕ — живые счётчики групп из `assembly.sets`). С M4.5 (KTD7) —
// предикаты по двусторонним наборам «ДN»: посадка пары и модалка несовпадения набора.

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

/**
 * Пара набора закрыта (M4.5, R9): обороты набора завершены или приняты, либо от них отказались
 * — условие паузы `merge`, посадки и тоста «добавлено». Односторонний набор и набор с идущими
 * или прерванными оборотами — нет: там посадка M3.5 или плашка досканирования.
 */
export function pairLanded(set: AddedSetReport): boolean {
  return (
    set.sides === 'two' &&
    (set.backsState === 'completed' || set.backsState === 'accepted' || set.decision === 'declined')
  );
}

/**
 * Набор, чьё несовпадение ждёт решения (M4.5, R15; KTD7): обороты завершены — не прерваны и не
 * приняты плашкой (приёмка ставит `kept` сама), число не равно числу лиц, решения нет. Модалка
 * закрывается только решением, поэтому предикат один — без подтверждений за процесс: «Оставить»
 * ставит `kept`, «Переснять» убирает проход. Первый найденный — наборов с открытым решением
 * больше одного не бывает (новый набор не добавить, пока пара ждёт).
 */
export function setMismatchDue(report: AssemblyReport): AddedSetReport | null {
  return (
    report.sets.find(
      (set) => set.backsState === 'completed' && set.mismatch && set.decision === 'none',
    ) ?? null
  );
}
