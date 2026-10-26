import { useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AddedSetReport, AssemblyReport, SessionAssembly } from '@shared';
import type { TFunction } from 'i18next';
import { useFocusWhen } from '../components/useFocusWhen';
import { assemblyOutcome } from '../state/assembly-outcome';
import './merge-screen.css';
import './merge-sort.css';

// Экран `merge` (план M2, U9; UI_SPEC раздел 5; редизайн B-5 — handoff
// `2026-10-b5-merge.md`): процессная пауза без органов управления, уходит сам по таймеру App
// (KTD-5). Иллюстрация «сортировки» одна на все исходы — индикатор «идёт сборка», а не
// рассказ об исходе: лица раскладываются, на каждое ложится его оборот, пары собираются в
// стопку (решение автора на приёмке B-5: пауза короче цикла, и картинка несовпадения не
// доигрывалась — о несовпадении сообщает модалка). Строка состояния — фактический результат
// сборки. После «Обороты не нужны» экрана нет (App). С M4 (S12) у строки хвост про пустые
// обороты, а App держит экран, пока оценки не пришли (решение автора: без потолка). С M4.5
// (S6) та же пауза после пары набора «ДN»: тег и заголовок набора, статус по набору.

/** Пауза `merge` (KTD-5, UI_SPEC раздел 9). */
export const MERGE_PAUSE_MS = 1600;

export interface MergeScreenProps {
  readonly assembly: SessionAssembly;
  /** Набор «ДN», чья пара только что закрылась (M4.5); `null` — основная пачка. */
  readonly set?: number | null;
}

/** Что сопоставляем: основная пачка или набор. */
interface Pack {
  readonly set: AddedSetReport | null;
  readonly backsState: AssemblyReport['backsState'];
  /** Лица и обороты не сошлись (или приняты неравными) — строка янтарная. */
  readonly mismatch: boolean;
}

function packOf(assembly: SessionAssembly, setNumber: number | null): Pack {
  const { report } = assembly;
  const set = setNumber === null ? null : (report.sets.find((it) => it.set === setNumber) ?? null);
  if (set === null) {
    const outcome = assemblyOutcome(report);
    return {
      set: null,
      backsState: report.backsState,
      mismatch: outcome === 'fewer' || outcome === 'extra' || outcome === 'accepted',
    };
  }
  return {
    set,
    backsState: set.backsState,
    mismatch: set.mismatch || set.backsState === 'accepted',
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

/** Лист иллюстрации: три строки «текста», как у листов `feed` и `turn`. */
function SortSheet({ className }: { readonly className: string }): ReactNode {
  return (
    <span className={`sort__sheet ${className}`}>
      <span className="sort__line" />
      <span className="sort__line" />
      <span className="sort__line" />
    </span>
  );
}

/**
 * Иллюстрация «сортировки» — одна на все исходы (индикатор сборки): шесть листов, число листов
 * документа она не показывает — его несёт строка состояния.
 */
function Sort(): ReactNode {
  return (
    <div className="sort" aria-hidden="true">
      <SortSheet className="sort__sheet--front sort__sheet--f1" />
      <SortSheet className="sort__sheet--front sort__sheet--f2" />
      <SortSheet className="sort__sheet--front sort__sheet--f3" />
      <SortSheet className="sort__sheet--back sort__sheet--b1" />
      <SortSheet className="sort__sheet--back sort__sheet--b2" />
      <SortSheet className="sort__sheet--back sort__sheet--b3" />
    </div>
  );
}

export function MergeScreen({ assembly, set = null }: MergeScreenProps): ReactNode {
  const { t } = useTranslation();
  const screenRef = useRef<HTMLElement>(null);
  const pack = packOf(assembly, set);
  const title = pack.set === null ? t('merge.title') : t('merge.titleSet');
  const warning = pack.mismatch;
  const status = pack.set === null ? outcomeText(t, assembly.report) : setOutcomeText(t, pack.set);
  const blank = blankStatus(t, assembly, pack);

  // Фокусируемых элементов нет — фокус на контейнере экрана (handoff, «Клавиатура»).
  useFocusWhen(screenRef, true);

  return (
    <main className="merge-screen" ref={screenRef} tabIndex={-1} aria-label={title}>
      <div className="merge-screen__head">
        {pack.set !== null && (
          <div className="merge-screen__tag">{t('merge.setTag', { set: pack.set.set })}</div>
        )}
        <h1 className="merge-screen__title">{title}</h1>
      </div>

      <Sort />

      <p
        className={
          warning ? 'merge-screen__status merge-screen__status--warning' : 'merge-screen__status'
        }
        role="status"
        aria-live="polite"
      >
        {warning && <span className="dot dot--warning" aria-hidden="true" />}
        <span className="merge-screen__main">{status}</span>
        {/* Хвост — отдельным узлом с ключом по тексту: смена проявляется, основное не мигает. */}
        {blank !== null && (
          <span key={blank} className="merge-screen__tail">
            {t('merge.blank.tail', { blank })}
          </span>
        )}
      </p>
    </main>
  );
}
