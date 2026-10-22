import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssembledDocument, SetsLayout } from '@shared';
import { toneOf } from '../state/page-text';

// Тулбар редактора (handoff M3, S1; M3.5, S1; M3.6, S4–S5): слева «↺ Новое сканирование» и
// «+ Добавить», по центру — документ текущей страницы или, в режиме наборов, живые счётчики
// групп, справа — точка несохранённого и «Сохранить документ» / «Собрать документ». Только
// показ и клики: причины недоступности и жесты считает экран.

export interface EditorToolbarProps {
  readonly total: number;
  readonly saved: boolean;
  readonly documents: readonly AssembledDocument[];
  /** Показываемые имена документов: введённые или по умолчанию. */
  readonly names: readonly string[];
  readonly currentIndex: number;
  /** Документ текущей страницы (с нуля); `null` — лента пуста. */
  readonly currentDocument: number | null;
  /** Группы ленты в режиме наборов; `null` — режим пар или собрано. */
  readonly sets: SetsLayout | null;
  /** Причина недоступности «+ Добавить» (M3.5, R12); `undefined` — доступна. */
  readonly addDisabledReason: 'saving' | 'busy' | 'interrupted' | undefined;
  /** «Собрать документ»: недоступна с причиной в `title` (S5) или пока команда в полёте. */
  readonly assembleDisabled: boolean;
  readonly assembleTitle: string | undefined;
  /** «+ Новый документ с этой страницы» уместна (S1). */
  readonly canSplitHere: boolean;
  /** Идёт запись пакета (KTD-9): кнопка границы недоступна. */
  readonly saving: boolean;
  readonly onNewScan: () => void;
  readonly onAdd: () => void;
  readonly onSplit: () => void;
  readonly onAssemble: () => void;
  readonly onSave: () => void;
  /** Клик по поверхности тулбара — сжатие мультивыделения решает экран (M3.5, R21). */
  readonly onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
}

export function EditorToolbar({
  total,
  saved,
  documents,
  names,
  currentIndex,
  currentDocument,
  sets,
  addDisabledReason,
  assembleDisabled,
  assembleTitle,
  canSplitHere,
  saving,
  onNewScan,
  onAdd,
  onSplit,
  onAssemble,
  onSave,
  onMouseDown,
}: EditorToolbarProps): ReactNode {
  const { t } = useTranslation();
  const currentDoc = currentDocument === null ? undefined : documents[currentDocument];
  // Наборы уравнены (S4): равные ненулевые счётчики — акцентная точка и приглашение собрать.
  const setsEqual = sets !== null && sets.fronts === sets.backs && sets.fronts > 0;

  return (
    <header className="editor-screen__toolbar" onMouseDown={onMouseDown}>
      <div className="editor-screen__toolbar-left">
        <button type="button" className="btn btn--secondary" onClick={onNewScan}>
          <span aria-hidden="true">↺</span> {t('editor.newScan')}
        </button>
        <button
          type="button"
          className="btn btn--secondary editor-screen__add"
          disabled={addDisabledReason !== undefined}
          title={
            addDisabledReason === undefined
              ? undefined
              : t(`editor.addDisabled.${addDisabledReason}`)
          }
          onClick={onAdd}
        >
          <span className="editor-screen__add-plus" aria-hidden="true">
            +
          </span>{' '}
          {t('editor.add')}
        </button>
      </div>
      {/* S4 M3.6: в режиме наборов — живые счётчики групп вместо метки документа. */}
      {sets !== null ? (
        <div className="editor-screen__toolbar-center editor-screen__toolbar-center--sets">
          <span className={setsEqual ? 'dot dot--accent' : 'dot dot--warning'} aria-hidden="true" />
          <span className="editor-screen__sets-text" role="status">
            {setsEqual
              ? t('editor.sets.equal')
              : t('editor.sets.mismatch', { fronts: sets.fronts, backs: sets.backs })}
          </span>
        </div>
      ) : (
        /* S1: документ текущей страницы — тон, имя, позиция. */
        <div
          className={
            currentDocument === null
              ? 'editor-screen__toolbar-center'
              : `editor-screen__toolbar-center ${toneOf(currentDocument)}`
          }
        >
          {currentDoc === undefined || currentDocument === null ? (
            <span className="editor-screen__doc-title">{t('editor.noPages')}</span>
          ) : (
            <>
              <span className="editor-screen__doc-mark" aria-hidden="true" />
              <span className="editor-screen__doc-title">{names[currentDocument]}</span>
              <span className="editor-screen__doc-pos">
                {documents.length > 1
                  ? t('editor.docPosition', {
                      doc: currentDocument + 1,
                      docs: documents.length,
                      page: currentIndex - currentDoc.start + 1,
                      pages: currentDoc.count,
                    })
                  : t('editor.pagePosition', { page: currentIndex + 1, pages: total })}
              </span>
              {canSplitHere && (
                <button
                  type="button"
                  className="btn btn--tinted editor-screen__split"
                  disabled={saving}
                  onClick={onSplit}
                >
                  {t('editor.splitHere')}
                </button>
              )}
            </>
          )}
        </div>
      )}
      <div className="editor-screen__toolbar-right">
        {/* S9 M2: точка несохранённого; скрыта, когда набор пуст или сохранён. */}
        {!saved && total > 0 && (
          <span
            className="editor-screen__unsaved dot dot--warning"
            role="status"
            title={t('editor.unsaved')}
          >
            <span className="visually-hidden">{t('editor.unsaved')}</span>
          </span>
        )}
        {sets !== null ? (
          /* S4–S5 M3.6: «Собрать документ» на месте «Сохранить»; причина — в title. */
          <button
            type="button"
            className="btn btn--primary btn--small editor-screen__assemble"
            disabled={assembleDisabled}
            title={assembleTitle}
            onClick={onAssemble}
          >
            {t('editor.assemble')}
          </button>
        ) : (
          /* S1: «Сохранить документ» при одном документе, «Сохранить N файлов» при нескольких;
             пустая лента — сохранять нечего. */
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={total === 0}
            onClick={onSave}
          >
            {documents.length > 1
              ? t('editor.saveFiles', { count: documents.length })
              : t('editor.save')}
          </button>
        )}
      </div>
    </header>
  );
}
