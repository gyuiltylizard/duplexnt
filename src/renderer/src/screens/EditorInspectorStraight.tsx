import type { ReactNode } from 'react';
import type { StraightenMark, StraightenSummary } from '@shared';
import type { TFunction } from 'i18next';
import {
  reasonText,
  straightActionLabel,
  straightNoteText,
  straightSelectionText,
  type StraightSelection,
} from '../state/straighten-text';
import type { CheckItem } from './InspectorCheck';

// Выравнивание в инспекторе (план M6, U8; handoff M6 «Anatomy», «States», «Behaviour»): секция
// ВЫРАВНИВАНИЕ после ДЕТАЛЕЙ — по образцу ПУСТОГО ОБОРОТА (у страницы бывает только одна из
// двух: у пустой статуса нет) — и пункт ПРОВЕРКИ после пустых оборотов. Одна страница: текст по
// статусу и действие «Оставить оригинал» (`straightened`) или «Выровнять» (`kept`) в одном
// слоте — после перерисовки кнопка становится парной, фокус остаётся на ней. Выделение из
// нескольких: строка «Из N выделенных: …» и до двух кнопок с числом подходящих (AE17);
// подходящих нет — одна недоступная кнопка и причина строкой ниже.

/**
 * Пункт ПРОВЕРКИ (handoff M6 «ПРОВЕРКА»): при «Не трогать» пункта нет; обработка идёт — точка с
 * числом и подсказкой, она перекрывает итог; закончена — галочка: «Выровнено N стр.» с хвостом
 * про оставленные оригиналом, «Все страницы ровные» или «Ни одна страница не выровнена». Причины
 * «не выровнено» со счётом — в подсказке; при отложенных — что делать.
 */
export function straightChecks(t: TFunction, straighten: StraightenSummary): CheckItem[] {
  if (straighten.mode !== 'auto') {
    return [];
  }
  if (straighten.pending > 0) {
    return [
      {
        key: 'straight',
        warning: true,
        text: (
          <>
            {t('inspector.check.straightPending', { count: straighten.pending })}
            <span className="check__hint">{t('inspector.check.straightPendingHint')}</span>
          </>
        ),
      },
    ];
  }
  const undone = straighten.unmeasurable + straighten.deferred;
  let text: string;
  if (straighten.straightened + straighten.kept > 0) {
    text = t('inspector.check.straightened', { count: straighten.straightened });
    if (straighten.kept > 0) {
      text += t('inspector.check.straightKept', { count: straighten.kept });
    }
  } else {
    text = t(undone === 0 ? 'inspector.check.straightNone' : 'inspector.check.straightFailedAll');
  }
  let hint: string | null = null;
  if (undone > 0) {
    const { reasons } = straighten;
    const listed = (['measure', 'shape', 'nohelp', 'disk', 'fail'] as const)
      .filter((reason) => reasons[reason] > 0)
      .map((reason) =>
        t('inspector.check.straightReason', {
          reason: reasonText(t, reason),
          count: reasons[reason],
        }),
      )
      .join(', ');
    hint = t('inspector.check.straightHint', { count: undone, reasons: listed });
    if (reasons.disk > 0) {
      hint += ` ${t('inspector.check.straightHintDisk')}`;
    } else if (reasons.fail > 0) {
      hint += ` ${t('inspector.check.straightHintRetry')}`;
    }
  }
  return [
    {
      key: 'straight',
      warning: false,
      text: (
        <>
          {text}
          {hint !== null && <span className="check__hint">{hint}</span>}
        </>
      ),
    },
  ];
}

export interface StraightSectionProps {
  readonly t: TFunction;
  /** `id` заголовка секции. */
  readonly headingId: string;
  /** Выделение по статусам; при одной странице — её статус. */
  readonly selection: StraightSelection;
  /** Статус текущей — текст секции у одной страницы. */
  readonly current: StraightenMark;
  /** Идёт запись или сборка (KTD-9): действия недоступны. */
  readonly locked: boolean;
  readonly onKeep: () => void;
  readonly onRestore: () => void;
}

/** Секция нужна: выделение из нескольких — всегда; одна страница — когда у статуса есть текст. */
export function straightSectionDue(
  t: TFunction,
  selection: StraightSelection,
  current: StraightenMark,
): boolean {
  return selection.count > 1 || straightNoteText(t, current) !== null;
}

export function StraightSection({
  t,
  headingId,
  selection,
  current,
  locked,
  onKeep,
  onRestore,
}: StraightSectionProps): ReactNode {
  let body: ReactNode;
  if (selection.count <= 1) {
    // Одна страница: действие — одной кнопкой в одном слоте, по статусу.
    const action =
      current.status === 'straightened' ? 'keep' : current.status === 'kept' ? 'restore' : null;
    body = (
      <>
        <p className="inspector__note">{straightNoteText(t, current)}</p>
        {action !== null && (
          <button
            type="button"
            className="btn btn--tinted inspector__blank-action"
            data-action={action}
            title={t(`inspector.straight.${action}Title`)}
            disabled={locked}
            onClick={action === 'keep' ? onKeep : onRestore}
          >
            {t(`inspector.straight.${action}`)}
          </button>
        )}
      </>
    );
  } else {
    const { keep, restore, count } = selection;
    const none = keep.length === 0 && restore.length === 0;
    const reason = none
      ? t(
          selection.pending > 0
            ? 'inspector.straight.allPending'
            : 'inspector.straight.noneEligible',
        )
      : null;
    body = (
      <>
        <p className="inspector__note">{straightSelectionText(t, selection)}</p>
        <div className="inspector__straight-actions">
          {keep.length > 0 && (
            <button
              type="button"
              className="btn btn--tinted"
              data-action="keep"
              title={t('inspector.straight.keepTitle')}
              disabled={locked}
              onClick={onKeep}
            >
              {straightActionLabel(t, 'keep', keep.length, count)}
            </button>
          )}
          {restore.length > 0 && (
            <button
              type="button"
              className="btn btn--tinted"
              data-action="restore"
              title={t('inspector.straight.restoreTitle')}
              disabled={locked}
              onClick={onRestore}
            >
              {straightActionLabel(t, 'restore', restore.length, count)}
            </button>
          )}
          {reason !== null && (
            <button type="button" className="btn btn--tinted" disabled title={reason}>
              {t('inspector.straight.keep')}
            </button>
          )}
        </div>
        {reason !== null && <p className="inspector__straight-reason">{reason}</p>}
      </>
    );
  }
  return (
    <section
      className="inspector__section inspector__section--straight"
      aria-labelledby={headingId}
    >
      <div className="inspector__heading">
        <h2 id={headingId} className="kicker">
          {t('inspector.straight.kicker')}
        </h2>
      </div>
      {body}
    </section>
  );
}
