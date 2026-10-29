import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssembledPage, SessionEdits } from '@shared';
import { keptOriginal, restoredStraight } from '../state/edits';
import type { EditState } from '../state/history';
import type { Selection } from '../state/selection';
import { straightSelectionOf, type StraightSelection } from '../state/straighten-text';
import type { EditorEdits } from './useEditorEdits';
import { useLateStraighten } from './useLateStraighten';

// Выравнивание в редакторе (план M6, U8; handoff M6 «Behaviour»): «Оставить оригинал» /
// «Выровнять» — ручная правка того же рода, что поворот: один `setEdits`, один шаг undo, плашка
// правок; действует на текущую или на всё выделение, но только на подходящие по статусу
// страницы (AE17), остальные не трогаются. Тост — только при действии на выделение из двух и
// более страниц (часть карточек может быть вне видимости); на одну — смена видна в превью.
// Текущая, выделение и фокус после нажатия не меняются: после перерисовки фокус — на парной
// кнопке. Поздние статусы (досканирование, пересчёт) — тост на порцию (`useLateStraighten`).
// Вынесено из `EditorScreen` — экран у порога размера.

export type StraightAction = 'keep' | 'restore';

export interface EditorStraighten {
  /** Выделение по статусам — для секции инспектора и подписей кнопок. */
  readonly selection: StraightSelection;
  readonly keepOriginal: () => void;
  readonly restoreStraight: () => void;
  /**
   * Снимок после действия показан — фокус на парную кнопку (`true` — поставлен; экран прерывает
   * свой порядок фокуса). Зовётся из эффекта фокуса экрана, когда правка не в полёте.
   */
  readonly refocus: () => boolean;
}

export function useEditorStraighten({
  edits,
  withEdits,
  order,
  shown,
  selection,
  onToast,
}: {
  readonly edits: EditorEdits;
  /** Состояние с текущим тумблером поверх новых правок. */
  readonly withEdits: (next: SessionEdits) => EditState;
  /** Полная видимая лента снимка — для поздних статусов. */
  readonly order: readonly AssembledPage[];
  /** Показанная лента — для счёта выделения. */
  readonly shown: readonly AssembledPage[];
  readonly selection: Selection;
  readonly onToast: (text: string) => void;
}): EditorStraighten {
  const { t } = useTranslation();
  const straightSelection = useMemo(
    () => straightSelectionOf(shown, selection.keys),
    [shown, selection.keys],
  );
  const refocusTo = useRef<StraightAction | null>(null);

  const act = (action: StraightAction): void => {
    const keys = action === 'keep' ? straightSelection.keep : straightSelection.restore;
    if (keys.length === 0) {
      return;
    }
    const current = edits.current.edits;
    const next = action === 'keep' ? keptOriginal(current, keys) : restoredStraight(current, keys);
    const many = straightSelection.count > 1;
    const sent = edits.edit(withEdits(next), keys, {
      onSuccess: () => {
        if (many) {
          onToast(
            t(action === 'keep' ? 'toast.straightKept' : 'toast.straightRestored', {
              count: keys.length,
            }),
          );
        }
      },
    });
    if (sent) {
      refocusTo.current = action === 'keep' ? 'restore' : 'keep';
    }
  };

  const refocus = (): boolean => {
    const action = refocusTo.current;
    if (action === null || edits.busy) {
      return false;
    }
    refocusTo.current = null;
    const button = document.querySelector<HTMLButtonElement>(
      `.inspector__section--straight button[data-action="${action}"]`,
    );
    if (button === null) {
      return false;
    }
    button.focus();
    return true;
  };

  useLateStraighten({
    order,
    onLate: (count, recalc) => {
      if (!recalc) {
        onToast(t('toast.straightLate', { count }));
      } else if (count > 0) {
        onToast(t('toast.straightRecalcCount', { count }));
      } else {
        onToast(t('toast.straightRecalc'));
      }
    },
  });

  return {
    selection: straightSelection,
    keepOriginal: () => {
      act('keep');
    },
    restoreStraight: () => {
      act('restore');
    },
    refocus,
  };
}
