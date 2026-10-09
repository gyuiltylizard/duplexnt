import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

// Модалка по рецепту дизайн-системы и UI_SPEC раздел 7: затемнение, окно по центру, без анимации.
// Esc и клик вне окна остаются без действия — закрывает только кнопка. Фокус заперт внутри;
// при размонтировании возвращается на элемент, который был в фокусе перед открытием.

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), ' +
  'textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Что в обходе Tab внутри `root`: кнопки с `tabIndex=-1` (невыбранные радио в группах с одной
 * остановкой, M3.5) фокусируемы, но не tabbable — ловушка и начальный фокус их пропускают,
 * иначе кольцо расходится с нативным обходом и Shift+Tab утекает под затемнение.
 */
const tabbablesOf = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.tabIndex >= 0);

export interface ModalProps {
  /** `id` заголовка — для `aria-labelledby`. */
  readonly labelledBy: string;
  /** `id` поясняющего текста — для `aria-describedby` (подтверждения вроде S21). */
  readonly describedBy?: string | undefined;
  readonly small?: boolean;
  /**
   * Команда в полёте: на диалоге `aria-busy`, CSS приглушает `.modal__body` и снимает с него
   * события мыши (S10); клавиатуру это не запирает. Когда недоступны обе кнопки футера,
   * фокус держится на самом окне, чтобы Tab не ушёл под затемнение.
   */
  readonly busy?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Modal({
  labelledBy,
  describedBy,
  small,
  busy,
  className,
  children,
}: ModalProps): ReactNode {
  const dialogRef = useRef<HTMLElement>(null);

  // Элемент, открывший модалку, запоминается при первом рендере: `autoFocus` React вызывает
  // на коммите, до эффектов, и к моменту эффекта фокус уже внутри модалки.
  const [opener] = useState(() => document.activeElement);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.contains(document.activeElement)) {
      tabbablesOf(dialog)[0]?.focus();
    }
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
        return;
      }
      // Открывшая кнопка исчезла — например, вместе с плашкой отказа (S6, S17). Фокус не
      // бросается на body, а идёт на первый фокусируемый элемент экрана под модалкой.
      const fallback = tabbablesOf(document).find((element) => !dialog?.contains(element));
      fallback?.focus();
    };
  }, [opener]);

  // Обе кнопки футера могут стать недоступными разом (S21 «Удаляем…»): браузер сбросил бы
  // фокус на body, и Tab гулял бы под затемнением.
  useEffect(() => {
    if (busy === true) {
      const dialog = dialogRef.current;
      if (dialog !== null && !dialog.contains(document.activeElement)) {
        dialog.focus();
      }
    }
  }, [busy]);

  const trapFocus = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Tab') {
      return;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const focusable = tabbablesOf(dialog);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !dialog.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  const classes = ['modal', small === true ? 'modal--small' : null, className]
    .filter((name) => name !== null && name !== undefined)
    .join(' ');

  return (
    <div className="modal-overlay">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-busy={busy === true ? true : undefined}
        tabIndex={-1}
        className={classes}
        onKeyDown={trapFocus}
      >
        {children}
      </section>
    </div>
  );
}
