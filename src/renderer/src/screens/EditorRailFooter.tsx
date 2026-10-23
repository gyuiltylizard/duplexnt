import type { ChangeEvent, ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlankSummary } from '@shared';

// Подвал ленты (handoff M4, S4–S6; R18): постоянное место трёх строк под миниатюрами — панель
// выделения (при выделении больше одной страницы), переключатель «добавить пустые» со
// счётчиком и тумблер 180°. Строки появляются и исчезают, лента над подвалом не сдвигается.
// Переключатель и тумблер — свойства прохода оборотов; панель — выделения. Ни одной строки —
// подвала нет. Только показ и клики: что показывать и что делать, решает экран.

export interface RailRotate {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

/** Панель выделения (S6): текст, «Выделить в документ» вне режима наборов, «Снять». */
export interface RailSelection {
  /** Выделенных показанных страниц — больше одной. */
  readonly count: number;
  /** «Выделить в документ» — вне режима наборов (M3.6, KTD8); `null` — кнопки нет. */
  readonly group: { readonly disabled: boolean; readonly onClick: () => void } | null;
  readonly onClear: () => void;
}

export interface EditorRailFooterProps {
  /** Панель выделения; `null` — выделена одна страница или ни одной. */
  readonly selection: RailSelection | null;
  /** Сводка пустых оборотов из снимка: режим сессии, найдено, скрыто, ждут оценки. */
  readonly blank: BlankSummary;
  /** Режим раздельных наборов: скрытых нет, переключателя тоже (S5). */
  readonly inSets: boolean;
  /** Скрытые показаны (R13) — состояние экрана. */
  readonly reveal: boolean;
  /** Чекбокс переключателя — туда уходит фокус, когда все страницы скрыты (S7). */
  readonly toggleRef: RefObject<HTMLInputElement | null>;
  readonly onReveal: (reveal: boolean) => void;
  /** Тумблер 180° прохода оборотов (M2, S7); `null` — прохода оборотов нет. */
  readonly rotate: RailRotate | null;
}

export function EditorRailFooter({
  selection,
  blank,
  inSets,
  reveal,
  toggleRef,
  onReveal,
  rotate,
}: EditorRailFooterProps): ReactNode {
  const { t } = useTranslation();
  if (selection === null && rotate === null) {
    return null;
  }
  // S5: без найденных переключатель недоступен с подписью «не найдено» или «оцениваются…».
  const found = blank.found > 0;
  const idle = blank.pending > 0 ? 'scoring' : 'none';
  return (
    <footer className="rail__footer">
      {selection !== null && (
        <div className="rail__selection" role="region" aria-label={t('editor.selection.label')}>
          <p className="rail__selection-text">
            {t('editor.selection.text', { count: selection.count })}
          </p>
          <div className="rail__selection-actions">
            {selection.group !== null && (
              <button
                type="button"
                className="rail__selection-group"
                disabled={selection.group.disabled}
                onClick={selection.group.onClick}
              >
                {t('editor.selection.group')}
              </button>
            )}
            <button type="button" className="rail__selection-clear" onClick={selection.onClear}>
              {t('editor.selection.clear')}
            </button>
          </div>
        </div>
      )}
      {rotate !== null && blank.mode === 'hide' && !inSets && (
        <label
          className={found ? 'toggle-row' : 'toggle-row toggle-row--disabled'}
          title={
            found
              ? t(reveal ? 'editor.blank.toggleTitle.on' : 'editor.blank.toggleTitle.off')
              : t(`editor.blank.toggleTitle.${idle}`)
          }
        >
          <span className="toggle">
            <input
              ref={toggleRef}
              className="toggle__input"
              type="checkbox"
              checked={reveal}
              disabled={!found}
              aria-label={t('editor.blank.toggleLabel')}
              onChange={(event) => {
                onReveal(event.target.checked);
              }}
            />
            <span className="toggle__track" aria-hidden="true" />
          </span>
          <span className="toggle-row__label">{t('editor.blank.toggle')}</span>
          <span className="toggle-row__count">
            {found
              ? t(reveal ? 'editor.blank.shown' : 'editor.blank.hidden', { count: blank.hidden })
              : t(`editor.blank.${idle}`)}
          </span>
        </label>
      )}
      {rotate !== null && (
        <label className="toggle-row" title={t('editor.rotateBacksTitle')}>
          <span className="toggle">
            <input
              className="toggle__input"
              type="checkbox"
              checked={rotate.checked}
              disabled={rotate.disabled}
              onChange={rotate.onChange}
            />
            <span className="toggle__track" aria-hidden="true" />
          </span>
          <span className="toggle-row__label">{t('editor.rotateBacks')}</span>
        </label>
      )}
    </footer>
  );
}
