import { useTranslation } from 'react-i18next';
import type { SaveDocumentsReport, SessionEdits } from '@shared';
import type { ToastAction } from '../components/Toast';
import { renamed } from '../state/edits';
import { errorTextInline } from '../state/error-text';
import type { EditState } from '../state/history';
import type { EditorEdits } from './useEditorEdits';

// Сохранение и закрытие сессии из редактора (план M3, U9; handoff M3, S16–S18; M3.5, KTD-9):
// имена из модалки `save` уходят правкой до записи пакета, тост полного успеха несёт «Открыть
// папку», «Сначала сохранить текущий» закрывает сессию после записи; отказ и молчание моста —
// тостом, сессия цела. Вынесено из `EditorScreen` при M4 (ревью размера файла).

/** Тосты сохранения и отказов — 6 с (UI_SPEC раздел 8). */
export const SAVE_TOAST_MS = 6000;

/** «Сохранено … — можно закладывать новые листы» после «Сначала сохранить текущий» (S17). */
const THEN_NEW_TOAST_MS = 3600;

export interface EditorSaving {
  /** Закрыть сессию без модалки; `saved` — текст тоста сохранения, если закрываем после записи. */
  readonly closeSession: (saved?: string) => void;
  /** Имена, тронутые в модалке `save`, — в документы одним шагом; `false` — правка не прошла. */
  readonly renameDocuments: (next: ReadonlyMap<number, string>) => Promise<boolean>;
  /** Пакет записан целиком: тост или закрытие сессии (`saveThenNew`). */
  readonly saved: (report: SaveDocumentsReport) => void;
}

export function useEditorSaving({
  edits,
  withEdits,
  thenNew,
  onSaved,
  onToast,
}: {
  readonly edits: EditorEdits;
  /** Состояние с текущим тумблером поверх новых правок. */
  readonly withEdits: (next: SessionEdits) => EditState;
  /** `save` открыта из `newscan` («Сначала сохранить текущий»): после успеха сессия закрывается. */
  readonly thenNew: boolean;
  /** Модалка `save` закрывается — до тоста или закрытия сессии. */
  readonly onSaved: () => void;
  readonly onToast: (text: string, durationMs?: number, action?: ToastAction) => void;
}): EditorSaving {
  const { t } = useTranslation();

  // Закрытие сессии без модалки: пустая сессия и «Сначала сохранить текущий» после записи
  // (`saved` — текст тоста сохранения). Отказ и молчание моста — тостом: сессия цела (S17), а
  // после записи человек должен узнать и то, что файлы сохранены.
  const closeSession = (saved?: string): void => {
    const failed = (reason: string): void => {
      onToast(
        saved === undefined
          ? t('toast.closeFailed', { error: reason })
          : t('toast.savedCloseFailed', { saved, error: reason }),
        SAVE_TOAST_MS,
      );
    };
    window.api.closeSession().then(
      (result) => {
        if (!result.ok) {
          failed(errorTextInline(t, result.error));
          return;
        }
        if (saved !== undefined) {
          onToast(t('toast.savedThenNew', { saved }), THEN_NEW_TOAST_MS);
        }
      },
      (error: unknown) => {
        console.error('[renderer] закрытие сессии не ответило', error);
        failed(t('toast.closeNoResponse'));
      },
    );
  };

  // Имена, тронутые в модалке `save`, — в документы одним шагом undo, до записи пакета (S16).
  // Только тронутые: нетронутые строки показывают живые имена, откатывать ими нечего.
  const renameDocuments = (next: ReadonlyMap<number, string>): Promise<boolean> => {
    const target = [...next].reduce(
      (state, [index, name]) => renamed(state, index, name),
      edits.current.edits,
    );
    if (target === edits.current.edits) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const sent = edits.edit(withEdits(target), [], {
        onSuccess: () => {
          resolve(true);
        },
        onFailure: () => {
          resolve(false);
        },
      });
      if (!sent) {
        resolve(false);
      }
    });
  };

  // «Открыть папку» из тоста «Сохранено» (M3.5, KTD-9): команда без входа — папку последнего
  // пакета помнит ядро, путь от renderer не принимается; отказ — тостом ошибки.
  const openSaveFolder = (): void => {
    window.api.openSaveFolder().then(
      (result) => {
        if (!result.ok) {
          onToast(
            t('toast.openFolderFailed', { error: errorTextInline(t, result.error) }),
            SAVE_TOAST_MS,
          );
        }
      },
      (error: unknown) => {
        console.error('[renderer] открытие папки не ответило', error);
      },
    );
  };

  // Пакет записан целиком: тост 6 с с кнопкой «Открыть папку» (S18 M3, пересмотр M3.5 S10:
  // «Новое сканирование» есть в тулбаре). После «Сначала сохранить текущий» — сразу закрытие.
  const saved = (report: SaveDocumentsReport): void => {
    onSaved();
    const [only] = report.written;
    const text =
      report.written.length === 1 && only !== undefined
        ? t('toast.saved', { file: only.fileName, folder: report.folder })
        : t('toast.savedMany', { count: report.written.length, folder: report.folder });
    if (thenNew) {
      closeSession(text);
      return;
    }
    onToast(text, SAVE_TOAST_MS, { label: t('toast.openFolder'), onClick: openSaveFolder });
  };

  return { closeSession, renameDocuments, saved };
}
