import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssemblyReport } from '@shared';
import type { TFunction } from 'i18next';
import './merge-screen.css';

// Экран `merge` (план M2, U9; UI_SPEC раздел 5; handoff M2, S4): процессная пауза без органов
// управления, уходит сам по таймеру App (KTD-5). Диаграмма иллюстративна, статусная строка —
// фактический результат сборки и первой сообщает о несовпадении.

/** Пауза `merge` (KTD-5, UI_SPEC раздел 9). */
export const MERGE_PAUSE_MS = 1600;
/** Пауза после «Обороты не нужны». */
export const MERGE_PAUSE_DECLINED_MS = 1200;

/** Потолок ячеек ряда: диаграмма — картинка процесса, числа несёт статусная строка. */
const ROW_CELLS_MAX = 12;
const DOC_CELLS_MAX = 24;

export interface MergeScreenProps {
  readonly report: AssemblyReport;
}

/** Статусная строка: при несовпадении или принятом коротком проходе сообщает о нём первым. */
function statusText(t: TFunction, report: AssemblyReport): string {
  if (report.backsDeclined) {
    return t('merge.status.frontsOnly', { count: report.fronts });
  }
  if (report.backsState === 'accepted') {
    return t('merge.status.accepted', { pairs: report.pairs, fronts: report.fronts });
  }
  if (report.unpairedSheets.length > 0) {
    return t('merge.status.fewer', { fronts: report.fronts, backs: report.backs });
  }
  if (report.extraBacks > 0) {
    return t('merge.status.extra', { count: report.extraBacks });
  }
  return t('merge.status.ok', { pairs: report.pairs });
}

function cells(count: number, max: number): number[] {
  return Array.from({ length: Math.max(1, Math.min(count, max)) }, (_, index) => index);
}

/**
 * Ряд «документ» повторяет фактическую сборку, а не идеальное чередование: непарные лица —
 * в начале (младшие листы без оборота), пары — чередованием, лишние обороты — в конце.
 */
function documentSides(report: AssemblyReport): readonly ('front' | 'back')[] {
  const sides: ('front' | 'back')[] = [
    ...report.unpairedSheets.map(() => 'front' as const),
    ...Array.from({ length: report.pairs }).flatMap(() => ['front', 'back'] as const),
    ...Array.from({ length: report.extraBacks }, () => 'back' as const),
  ];
  if (sides.length === 0) {
    // «Обороты не нужны»: набор — только лицевые.
    return Array.from({ length: report.fronts }, () => 'front' as const);
  }
  return sides.slice(0, DOC_CELLS_MAX);
}

export function MergeScreen({ report }: MergeScreenProps): ReactNode {
  const { t } = useTranslation();
  const screenRef = useRef<HTMLElement>(null);

  // Фокусируемых элементов нет — фокус на контейнере экрана (handoff, «Клавиатура»).
  useEffect(() => {
    screenRef.current?.focus();
  }, []);

  return (
    <main className="merge-screen" ref={screenRef} tabIndex={-1}>
      <h1 className="merge-screen__title">{t('merge.title')}</h1>

      <div className="merge-screen__diagram" aria-hidden="true">
        <div className="merge-screen__row">
          <div className="merge-screen__row-label">
            {t('merge.rowFronts', { count: report.fronts })}
          </div>
          <div className="merge-screen__cells">
            {cells(report.fronts, ROW_CELLS_MAX).map((index) => (
              <span key={index} className="merge-screen__cell merge-screen__cell--front" />
            ))}
          </div>
        </div>
        {!report.backsDeclined && report.backs > 0 && (
          <div className="merge-screen__row">
            <div className="merge-screen__row-label">
              {t('merge.rowBacks', { count: report.backs })}
            </div>
            <div className="merge-screen__cells merge-screen__cells--reversed">
              {cells(report.backs, ROW_CELLS_MAX).map((index) => (
                <span key={index} className="merge-screen__cell merge-screen__cell--back" />
              ))}
            </div>
          </div>
        )}
        <div className="merge-screen__row merge-screen__row--document">
          <div className="merge-screen__row-label merge-screen__row-label--strong">
            {t('merge.rowDocument')}
          </div>
          <div className="merge-screen__cells merge-screen__cells--document">
            {documentSides(report).map((side, index) => (
              <span
                key={index}
                className={
                  side === 'back'
                    ? 'merge-screen__doc-cell merge-screen__doc-cell--back'
                    : 'merge-screen__doc-cell'
                }
              />
            ))}
          </div>
        </div>
      </div>

      <footer className="merge-screen__footer">
        {!report.backsDeclined && (
          <p className="merge-screen__formula">
            {t(report.mismatch ? 'merge.formulaMismatch' : 'merge.formula')}
          </p>
        )}
        <p className="merge-screen__status" role="status">
          {statusText(t, report)}
        </p>
      </footer>
    </main>
  );
}
