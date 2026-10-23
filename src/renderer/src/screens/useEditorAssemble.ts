import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { AssemblyMode, BlankSummary } from '@shared';
import { errorTextInline } from '../state/error-text';
import { SAVE_TOAST_MS } from './useEditorSaving';

// «Собрать документ» (план M3.6, U7; KTD5; handoff M4, S13): команда `assemble` напрямую, не
// через `edit()` — сборка не правка и не шаг undo; снимок придёт сам. После сборки в режиме
// «Скрывать» скрытые уходят из ленты — их число входит в тост сборки, один тост вместо двух.
// Ответ команды и снимок «собрано» приходят по разным каналам в любом порядке (ядро шлёт
// снимок до ответа, но IPC этого не обещает): тост уходит, когда пришло и то и другое, с числом
// скрытых из снимка «собрано» (ревью сессий 3–4). Вынесено из `EditorScreen` при упрощении M4.

/** Идущая сборка: что уже пришло. */
interface Run {
  readonly sheets: number;
  replied: boolean;
  landed: boolean;
}

export interface EditorAssemble {
  /** Команда в полёте: правки заблокированы, как при записи. */
  readonly assembling: boolean;
  /** После сборки фокус — на карточке текущей (S13 M3.6): карточки перемонтируются в группы. */
  readonly focusAfterRef: RefObject<boolean>;
  /** Собрать; `sheets` — листов для тоста. Гарды режима и блокировки — у экрана. */
  readonly assemble: (sheets: number) => void;
}

export function useEditorAssemble({
  mode,
  blank,
  onToast,
}: {
  /** Режим сборки снимка: переход в «собрано» — посадка снимка сборки. */
  readonly mode: AssemblyMode;
  readonly blank: BlankSummary;
  readonly onToast: (text: string, durationMs?: number) => void;
}): EditorAssemble {
  const { t } = useTranslation();
  const [assembling, setAssembling] = useState(false);
  const focusAfterRef = useRef(false);
  const runRef = useRef<Run | null>(null);
  // Сводка последнего показанного снимка — для ответа, пришедшего после посадки снимка.
  const blankRef = useRef(blank);
  useLayoutEffect(() => {
    blankRef.current = blank;
  });

  const announce = (sheets: number, hidden: number): void => {
    onToast(
      hidden > 0
        ? t('toast.assembledBlank', { sheets: t('toast.sheets', { count: sheets }), count: hidden })
        : t('toast.assembled', { count: sheets }),
    );
  };

  // Снимок «собрано» пришёл: если ответ уже был — тост сейчас, иначе ждём ответа.
  const landed = useEffectEvent(() => {
    const run = runRef.current;
    if (run === null || run.landed) {
      return;
    }
    if (run.replied) {
      runRef.current = null;
      announce(run.sheets, blank.hidden);
    } else {
      run.landed = true;
    }
  });
  useEffect(() => {
    if (mode === 'assembled') {
      landed();
    }
  }, [mode]);

  const assemble = (sheets: number): void => {
    setAssembling(true);
    runRef.current = { sheets, replied: false, landed: false };
    window.api.assemble().then(
      (result) => {
        setAssembling(false);
        const run = runRef.current;
        if (result.ok) {
          focusAfterRef.current = true;
          // Снимок уже посажен — число скрытых в нём; иначе тост уйдёт с посадкой снимка.
          if (run?.landed === true) {
            runRef.current = null;
            announce(run.sheets, blankRef.current.hidden);
          } else if (run !== null) {
            run.replied = true;
          }
          return;
        }
        runRef.current = null;
        onToast(
          t('toast.assembleFailed', { error: errorTextInline(t, result.error) }),
          SAVE_TOAST_MS,
        );
      },
      (error: unknown) => {
        setAssembling(false);
        runRef.current = null;
        console.error('[renderer] сборка не ответила', error);
        onToast(t('toast.assembleNoResponse'), SAVE_TOAST_MS);
      },
    );
  };

  return { assembling, focusAfterRef, assemble };
}
