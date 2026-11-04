import type { ReactNode } from 'react';
import type { StraightenMark, StraightenSummary } from '@shared';
import type { TFunction } from 'i18next';
import { reasonText, straightActionLabel, type StraightSelection } from '../state/straighten-text';
import type { CheckItem } from './InspectorCheck';

// Выравнивание в инспекторе (план M6, U8; handoff M6; правка автора на приёмке B-45,
// 2026-11-04): секция ВЫРАВНИВАНИЕ после ДЕТАЛЕЙ — только заголовок и действие, без текста
// (статус и причина — в факте ДЕТАЛЕЙ, на карточке и в ПРОВЕРКЕ). Одна страница: «Вернуть
// оригинал» у выправленной, «Выровнять» у откаченной, во всю ширину секции, как «Сохранить»;
// после перерисовки кнопка становится парной, фокус остаётся на ней. У остальных статусов
// действия нет — секции нет. Выделение из нескольких: до двух кнопок с числом подходящих друг
// под другом (AE17); подходящих нет — секции нет. Пункт ПРОВЕРКИ — после пустых оборотов.

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

/** Секция нужна только при действии: у одной страницы — выправлена или откачена; у выделения — есть подходящие. */
export function straightSectionDue(selection: StraightSelection, current: StraightenMark): boolean {
  if (selection.count > 1) {
    return selection.keep.length > 0 || selection.restore.length > 0;
  }
  return current.status === 'straightened' || current.status === 'kept';
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
  const action = (
    kind: 'keep' | 'restore',
    label: string,
    onClick: () => void,
    key?: string,
  ): ReactNode => (
    <button
      key={key}
      type="button"
      className="btn btn--tinted inspector__straight-action"
      data-action={kind}
      title={t(`inspector.straight.${kind}Title`)}
      disabled={locked}
      onClick={onClick}
    >
      {label}
    </button>
  );
  let actions: ReactNode;
  if (selection.count <= 1) {
    // Одна страница: действие в одном слоте по статусу.
    actions =
      current.status === 'kept'
        ? action('restore', t('inspector.straight.restore'), onRestore)
        : action('keep', t('inspector.straight.keep'), onKeep);
  } else {
    const { keep, restore, count } = selection;
    actions = (
      <>
        {keep.length > 0 &&
          action('keep', straightActionLabel(t, 'keep', keep.length, count), onKeep, 'keep')}
        {restore.length > 0 &&
          action(
            'restore',
            straightActionLabel(t, 'restore', restore.length, count),
            onRestore,
            'restore',
          )}
      </>
    );
  }
  return (
    <section
      className="inspector__section inspector__section--straight"
      data-section="straight"
      aria-labelledby={headingId}
    >
      <div className="inspector__heading">
        <h2 id={headingId} className="kicker">
          {t('inspector.straight.kicker')}
        </h2>
      </div>
      <div className="inspector__straight-actions">{actions}</div>
    </section>
  );
}
