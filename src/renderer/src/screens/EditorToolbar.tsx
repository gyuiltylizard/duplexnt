import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssembledDocument, SetsLayout } from '@shared';
import { toneOf } from '../state/page-text';

// Тулбар редактора (handoff M3, S1; M3.5, S1; M3.6, S4–S5; B-45 `2026-11-inspector-v2.md`):
// слева «↺ Новое сканирование» и «+ Добавить», по центру — метка и название документа текущей
// страницы (позиция «документ N из M · стр. K из L» снята в B-45: страница — в статусбаре,
// документ — в списке инспектора) или, в режиме наборов, живые счётчики групп; справа — плашка
// «Есть ручные правки» с мигающей точкой и «Вернуть», пока правки есть. Первичные кнопки
// «Сохранить…» / «Собрать документ» и точка «не сохранено» ушли отсюда в инспектор (B-45).
// Только показ и клики: причины недоступности и жесты считает экран.

export interface EditorToolbarProps {
  readonly documents: readonly AssembledDocument[];
  /** Показываемые имена документов: введённые или по умолчанию. */
  readonly names: readonly string[];
  /** Документ текущей страницы (с нуля); `null` — лента пуста. */
  readonly currentDocument: number | null;
  /** Группы ленты в режиме наборов; `null` — режим пар или собрано. */
  readonly sets: SetsLayout | null;
  /** Причина недоступности «+ Добавить» (M3.5, R12); `undefined` — доступна. */
  readonly addDisabledReason: 'saving' | 'busy' | 'interrupted' | undefined;
  /** «+ Новый документ с этой страницы» уместна (S1). */
  readonly canSplitHere: boolean;
  /** Идёт запись пакета (KTD-9): кнопка границы недоступна. */
  readonly saving: boolean;
  /** Есть ручные правки (S14): плашка в правой зоне; флаг ядра учитывает и тумблер 180°. */
  readonly hasEdits: boolean;
  /** «Вернуть» недоступна: идёт запись, сборка или правка в полёте (KTD-9). */
  readonly revertDisabled: boolean;
  readonly onNewScan: () => void;
  readonly onAdd: () => void;
  readonly onSplit: () => void;
  /** «Вернуть» — открыть подтверждение `revert`. */
  readonly onRevert: () => void;
  /** Клик по поверхности тулбара — сжатие мультивыделения решает экран (M3.5, R21). */
  readonly onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
}

export function EditorToolbar({
  documents,
  names,
  currentDocument,
  sets,
  addDisabledReason,
  canSplitHere,
  saving,
  hasEdits,
  revertDisabled,
  onNewScan,
  onAdd,
  onSplit,
  onRevert,
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
        /* S1: документ текущей страницы — тон и имя. */
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
        {/* S14 M3 → B-45: плашка правок — здесь, без подложки; без правок зона пуста. */}
        {hasEdits && (
          <div className="edits-bar" role="status">
            <span className="dot dot--warning edits-bar__dot" aria-hidden="true" />
            <p className="edits-bar__text">{t('editor.edits.text')}</p>
            <button
              type="button"
              className="btn btn--tinted"
              title={t('editor.edits.revertTitle')}
              disabled={revertDisabled}
              onClick={onRevert}
            >
              {t('editor.edits.revert')}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
