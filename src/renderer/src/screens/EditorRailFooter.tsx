import type { ChangeEvent, ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlankMode, BlankSummary } from '@shared';

// Подвал ленты (handoff M4, S4–S5; R18): постоянное место строк под миниатюрами — переключатель
// «добавить пустые» со счётчиком и тумблер 180°; панель выделения переезжает сюда в U7. Обе
// строки — свойства прохода оборотов: без него подвала нет. Только показ и клики: что показывать
// и что делать, решает экран.

export interface RailRotate {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

export interface EditorRailFooterProps {
  /** Сводка пустых оборотов из снимка: найдено, скрыто, ждут оценки. */
  readonly blank: BlankSummary;
  /** Режим пустых оборотов сессии: переключатель — только при «Скрывать». */
  readonly blankMode: BlankMode;
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
  blank,
  blankMode,
  inSets,
  reveal,
  toggleRef,
  onReveal,
  rotate,
}: EditorRailFooterProps): ReactNode {
  const { t } = useTranslation();
  if (rotate === null) {
    return null;
  }
  // S5: без найденных переключатель недоступен с подписью «не найдено» или «оцениваются…».
  const found = blank.found > 0;
  const idle = blank.pending > 0 ? 'scoring' : 'none';
  return (
    <footer className="rail__footer">
      {blankMode === 'hide' && !inSets && (
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
    </footer>
  );
}
