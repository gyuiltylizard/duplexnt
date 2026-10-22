import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlankSummary } from '@shared';
import { errorTextInline } from '../state/error-text';
import { SAVE_TOAST_MS } from './useEditorSaving';

// «Собрать документ» (план M3.6, U7; KTD5; handoff M4, S13): команда `assemble` напрямую, не
// через `edit()` — сборка не правка и не шаг undo; снимок придёт сам. После сборки в режиме
// «Скрывать» скрытые уходят из ленты — их число входит в тост сборки, один тост вместо двух;
// сводка — из последнего показанного снимка. Вынесено из `EditorScreen` при упрощении M4.

export interface EditorAssemble {
  /** Команда в полёте: правки заблокированы, как при записи. */
  readonly assembling: boolean;
  /** Сколько скрыла последняя сборка — о них уже сказал тост сборки (для `useLateHidden`). */
  readonly assembledHidden: number;
  /** После сборки фокус — на карточке текущей (S13 M3.6): карточки перемонтируются в группы. */
  readonly focusAfterRef: RefObject<boolean>;
  /** Собрать; `sheets` — листов для тоста. Гарды режима и блокировки — у экрана. */
  readonly assemble: (sheets: number) => void;
}

export function useEditorAssemble({
  blank,
  onToast,
}: {
  readonly blank: BlankSummary;
  readonly onToast: (text: string, durationMs?: number) => void;
}): EditorAssemble {
  const { t } = useTranslation();
  const [assembling, setAssembling] = useState(false);
  const [assembledHidden, setAssembledHidden] = useState(0);
  const focusAfterRef = useRef(false);
  const blankRef = useRef(blank);
  useLayoutEffect(() => {
    blankRef.current = blank;
  });

  const assemble = (sheets: number): void => {
    setAssembling(true);
    window.api.assemble().then(
      (result) => {
        setAssembling(false);
        if (result.ok) {
          focusAfterRef.current = true;
          const hidden = blankRef.current.hidden;
          setAssembledHidden(hidden);
          onToast(
            hidden > 0
              ? t('toast.assembledBlank', {
                  sheets: t('toast.sheets', { count: sheets }),
                  count: hidden,
                })
              : t('toast.assembled', { count: sheets }),
          );
          return;
        }
        onToast(
          t('toast.assembleFailed', { error: errorTextInline(t, result.error) }),
          SAVE_TOAST_MS,
        );
      },
      (error: unknown) => {
        setAssembling(false);
        console.error('[renderer] сборка не ответила', error);
        onToast(t('toast.assembleNoResponse'), SAVE_TOAST_MS);
      },
    );
  };

  return { assembling, assembledHidden, focusAfterRef, assemble };
}
