import { useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AddedSetReport, AssembledPage, AssemblyReport, SessionAssembly } from '@shared';
import type { TFunction } from 'i18next';
import { useFocusWhen } from '../components/useFocusWhen';
import { assemblyOutcome } from '../state/assembly-outcome';
import './merge-screen.css';

// Экран `merge` (план M2, U9; UI_SPEC раздел 5; handoff M2, S4; M3.6, S7): процессная пауза без
// органов управления, уходит сам по таймеру App (KTD-5). Диаграмма иллюстративна, статусная
// строка — фактический результат сборки и первой сообщает о несовпадении. При несовпадении
// (режим раздельных наборов) ряда «документ» нет: лица и обороты лежат отдельными наборами,
// документ соберут в редакторе (R21). С M4 (S12) статус получает хвост про пустые обороты, а
// App держит экран, пока оценки не пришли (решение автора: без потолка). С M4.5 (R9; handoff
// M4.5, S6) та же пауза после пары набора «ДN»: ряды и статус называют набор, ряд «документ» —
// чередование его блока; при несовпадении набора ряда «документ» нет, формула — про набор.

/** Пауза `merge` (KTD-5, UI_SPEC раздел 9). */
export const MERGE_PAUSE_MS = 1600;
/** Пауза после «Обороты не нужны». */
export const MERGE_PAUSE_DECLINED_MS = 1200;

/** Потолок ячеек ряда: диаграмма — картинка процесса, числа несёт статусная строка. */
const ROW_CELLS_MAX = 12;
const DOC_CELLS_MAX = 24;

export interface MergeScreenProps {
  readonly assembly: SessionAssembly;
  /** Набор «ДN», чья пара только что закрылась (M4.5); `null` — основная пачка. */
  readonly set?: number | null;
}

/** Что сопоставляем: числа, состояние оборотов и отказ — у основной пачки или у набора. */
interface Pack {
  readonly set: AddedSetReport | null;
  readonly fronts: number;
  readonly backs: number;
  readonly backsState: AssemblyReport['backsState'];
  readonly declined: boolean;
  readonly mismatch: boolean;
  /** Страницы ряда «документ»: вся лента или блок набора. */
  readonly pages: readonly AssembledPage[];
}

function packOf(assembly: SessionAssembly, setNumber: number | null): Pack {
  const { report } = assembly;
  const set = setNumber === null ? null : (report.sets.find((it) => it.set === setNumber) ?? null);
  if (set === null) {
    return {
      set: null,
      fronts: report.fronts,
      backs: report.backs,
      backsState: report.backsState,
      declined: report.backsDeclined,
      mismatch: report.mode === 'sets',
      pages: assembly.order,
    };
  }
  return {
    set,
    fronts: set.fronts,
    backs: set.backs,
    backsState: set.backsState,
    declined: set.decision === 'declined',
    mismatch: set.mismatch,
    pages: assembly.order.filter((page) => page.addedSet === set.set),
  };
}

/**
 * Хвост статуса про пустые обороты (M4, S12): только при режиме, отличном от «Оставлять», при
 * проходе оборотов и вне режима наборов — там детектор не работал или страницы не скрываются.
 */
function blankStatus(t: TFunction, assembly: SessionAssembly, pack: Pack): string | null {
  const { blank, report } = assembly;
  if (blank.mode === 'keep' || pack.backsState === null || report.mode === 'sets') {
    return null;
  }
  if (blank.pending > 0) {
    return t('merge.blank.scoring');
  }
  return blank.found === 0 ? t('merge.blank.none') : t('merge.blank.found', { count: blank.found });
}

/** Статусная строка: исход — общей классификацией, тот же, что увидит `mismatch` (KTD-8). */
function statusText(t: TFunction, assembly: SessionAssembly, pack: Pack): string {
  const status = pack.set === null ? outcomeText(t, assembly.report) : setOutcomeText(t, pack.set);
  const blank = blankStatus(t, assembly, pack);
  return blank === null ? status : t('merge.blank.join', { status, blank });
}

function outcomeText(t: TFunction, report: AssemblyReport): string {
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

/** Статус по набору (S6 M4.5): начинается с «набор ДN», чтобы не читался как сборка документа. */
function setOutcomeText(t: TFunction, set: AddedSetReport): string {
  const { fronts, backs } = set;
  if (set.decision === 'declined') {
    return t('merge.status.setDeclined', { set: set.set, count: fronts });
  }
  if (set.backsState === 'accepted') {
    return t('merge.status.setAccepted', { set: set.set, fronts, backs });
  }
  if (set.mismatch) {
    return t('merge.status.setMismatch', { set: set.set, fronts, backs });
  }
  return t('merge.status.setOk', { set: set.set, count: fronts });
}

/**
 * Строка-формула под схемой. При несовпадении документа ещё нет: у всей ленты лица и обороты
 * лежат отдельными наборами, у набора (S6 M4.5) — подблоками рядом, поэтому формулировки разные.
 */
function formulaKeyOf(
  pack: Pack,
): 'merge.formula' | 'merge.formulaMismatch' | 'merge.formulaSetMismatch' {
  if (!pack.mismatch) {
    return 'merge.formula';
  }
  return pack.set === null ? 'merge.formulaMismatch' : 'merge.formulaSetMismatch';
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

export function MergeScreen({ assembly, set = null }: MergeScreenProps): ReactNode {
  const { t } = useTranslation();
  const screenRef = useRef<HTMLElement>(null);
  const pack = packOf(assembly, set);
  const ofSet = pack.set !== null;

  // Фокусируемых элементов нет — фокус на контейнере экрана (handoff, «Клавиатура»).
  useFocusWhen(screenRef, true);

  return (
    <main className="merge-screen" ref={screenRef} tabIndex={-1}>
      <h1 className="merge-screen__title">{t('merge.title')}</h1>

      <div className="merge-screen__diagram" aria-hidden="true">
        <Row
          label={t(ofSet ? 'merge.rowSetFronts' : 'merge.rowFronts', { count: pack.fronts })}
          count={pack.fronts}
          side="front"
        />
        {!pack.declined && pack.backs > 0 && (
          <Row
            label={t(ofSet ? 'merge.rowSetBacks' : 'merge.rowBacks', { count: pack.backs })}
            count={pack.backs}
            side="back"
          />
        )}
        {/* S7 M3.6: при несовпадении документа ещё нет — ряд не рисуется; у набора (S6 M4.5)
            несовпавший блок лежит подблоками — тоже без ряда. */}
        {!pack.mismatch && (
          <div className="merge-screen__row merge-screen__row--document">
            <div className="merge-screen__row-label merge-screen__row-label--strong">
              {t('merge.rowDocument')}
            </div>
            {/* Ряд «документ» — из настоящего порядка сборки, а не повтора правила KTD-4. */}
            <div className="merge-screen__cells merge-screen__cells--document">
              {pack.pages.slice(0, DOC_CELLS_MAX).map((page) => (
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
        {!pack.declined && <p className="merge-screen__formula">{t(formulaKeyOf(pack))}</p>}
        <p className="merge-screen__status" role="status">
          {statusText(t, assembly, pack)}
        </p>
      </footer>
    </main>
  );
}
