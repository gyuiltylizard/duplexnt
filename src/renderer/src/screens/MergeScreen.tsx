import { useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssemblyReport, SessionAssembly } from '@shared';
import type { TFunction } from 'i18next';
import { useFocusWhen } from '../components/useFocusWhen';
import { assemblyOutcome } from '../state/assembly-outcome';
import './merge-screen.css';

// Экран `merge` (план M2, U9; UI_SPEC раздел 5; handoff M2, S4; M3.6, S7): процессная пауза без
// органов управления, уходит сам по таймеру App (KTD-5). Диаграмма иллюстративна, статусная
// строка — фактический результат сборки и первой сообщает о несовпадении. При несовпадении
// (режим раздельных наборов) ряда «документ» нет: лица и обороты лежат отдельными наборами,
// документ соберут в редакторе (R21).

/** Пауза `merge` (KTD-5, UI_SPEC раздел 9). */
export const MERGE_PAUSE_MS = 1600;
/** Пауза после «Обороты не нужны». */
export const MERGE_PAUSE_DECLINED_MS = 1200;

/** Потолок ячеек ряда: диаграмма — картинка процесса, числа несёт статусная строка. */
const ROW_CELLS_MAX = 12;
const DOC_CELLS_MAX = 24;

export interface MergeScreenProps {
  readonly assembly: SessionAssembly;
}

/** Статусная строка: исход — общей классификацией, тот же, что увидит `mismatch` (KTD-8). */
function statusText(t: TFunction, report: AssemblyReport): string {
  const { fronts, backs } = report;
  switch (assemblyOutcome(report)) {
    case 'frontsOnly':
      return t('merge.status.frontsOnly', { count: fronts });
    case 'accepted':
      return t('merge.status.accepted', { fronts, backs });
    case 'fewer':
      return t('merge.status.fewer', { fronts, backs });
    case 'extra':
      return t('merge.status.extra', { count: backs - fronts });
    case 'ok':
      return t('merge.status.ok', { count: Math.min(fronts, backs) });
  }
}

function cells(count: number, max: number): number[] {
  return Array.from({ length: Math.max(1, Math.min(count, max)) }, (_, index) => index);
}

/** Ряд диаграммы: подпись + ячейки одного прохода. */
function Row({
  label,
  count,
  side,
}: {
  readonly label: string;
  readonly count: number;
  readonly side: 'front' | 'back';
}): ReactNode {
  return (
    <div className="merge-screen__row">
      <div className="merge-screen__row-label">{label}</div>
      {/* Обороты пришли в обратном порядке — их ряд заполняется с другого края. */}
      <div
        className={
          side === 'back'
            ? 'merge-screen__cells merge-screen__cells--reversed'
            : 'merge-screen__cells'
        }
      >
        {cells(count, ROW_CELLS_MAX).map((index) => (
          <span key={index} className={`merge-screen__cell merge-screen__cell--${side}`} />
        ))}
      </div>
    </div>
  );
}

export function MergeScreen({ assembly }: MergeScreenProps): ReactNode {
  const { t } = useTranslation();
  const screenRef = useRef<HTMLElement>(null);
  const { report } = assembly;

  // Фокусируемых элементов нет — фокус на контейнере экрана (handoff, «Клавиатура»).
  useFocusWhen(screenRef, true);

  return (
    <main className="merge-screen" ref={screenRef} tabIndex={-1}>
      <h1 className="merge-screen__title">{t('merge.title')}</h1>

      <div className="merge-screen__diagram" aria-hidden="true">
        <Row
          label={t('merge.rowFronts', { count: report.fronts })}
          count={report.fronts}
          side="front"
        />
        {!report.backsDeclined && report.backs > 0 && (
          <Row
            label={t('merge.rowBacks', { count: report.backs })}
            count={report.backs}
            side="back"
          />
        )}
        {/* S7 M3.6: при несовпадении документа ещё нет — ряд не рисуется. */}
        {report.mode !== 'sets' && (
          <div className="merge-screen__row merge-screen__row--document">
            <div className="merge-screen__row-label merge-screen__row-label--strong">
              {t('merge.rowDocument')}
            </div>
            {/* Ряд «документ» — из настоящего порядка сборки, а не повтора правила KTD-4. */}
            <div className="merge-screen__cells merge-screen__cells--document">
              {assembly.order.slice(0, DOC_CELLS_MAX).map((page) => (
                <span
                  key={page.key}
                  className={
                    page.side === 'back'
                      ? 'merge-screen__doc-cell merge-screen__doc-cell--back'
                      : 'merge-screen__doc-cell'
                  }
                />
              ))}
            </div>
          </div>
        )}
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
