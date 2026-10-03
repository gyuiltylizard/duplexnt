import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

// Модалка по рецепту дизайн-системы и UI_SPEC раздел 7: затемнение, окно по центру, без анимации.
// Esc и клик вне окна остаются без действия — закрывает только кнопка. Фокус заперт внутри;
// при размонтировании возвращается на элемент, который был в фокусе перед открытием.

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), ' +
  'textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  /** `id` заголовка — для `aria-labelledby`. */
  readonly labelledBy: string;
  readonly small?: boolean;
  /** Подключение идёт: тело приглушено и не кликается (S10). */
  readonly busy?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Modal({ labelledBy, small, busy, className, children }: ModalProps): ReactNode {
  const dialogRef = useRef<HTMLElement>(null);

  // Элемент, открывший модалку, запоминается при первом рендере: `autoFocus` React вызывает
  // на коммите, до эффектов, и к моменту эффекта фокус уже внутри модалки.
  const [opener] = useState(() => document.activeElement);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.contains(document.activeElement)) {
      dialog.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, [opener]);

  const trapFocus = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Tab') {
      return;
    }
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
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
        aria-busy={busy === true ? true : undefined}
        className={classes}
        onKeyDown={trapFocus}
      >
        {children}
      </section>
    </div>
  );
}
