import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  animate,
  distanceOf,
  durationOf,
  easingOf,
  fadeOut,
  leaveWithGhost,
  prefersReducedMotion,
} from '../state/motion';

// Модалка по рецепту дизайн-системы и UI_SPEC раздел 7: затемнение, окно по центру. Esc — то же,
// что кнопка отмены или закрытия модалки (B-11): модалка передаёт её обработчик в `onEscape`,
// без него (решение без отмены, кнопка недоступна) Esc без действия. Клик вне окна без действия.
// Фокус заперт внутри; при размонтировании возвращается на элемент, который был в фокусе перед
// открытием.
//
// Движение (B-4, handoff «4. Модалки и тост»): затемнение проявляется, окно поднимается; уходя,
// модалка оставляет гаснущую копию — ввод снят сразу. Модалка, открытая тем же коммитом, в
// котором закрылась прежняя (`newscan` → `save`), — замена: затемнение не моргает, поднимается
// только окно. Смена содержимого меняет высоту окна плавно.

/**
 * Модалка закрылась в этом коммите: её уход может забрать следующая (замена). Узел — чтобы
 * отличить замену от повторного монтажа StrictMode (dev): там «закрывается» тот же узел.
 */
let closingThisCommit: { readonly node: HTMLElement | null; readonly cancel: () => void } | null =
  null;

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
  /**
   * Esc (B-11) — тот же обработчик, что у кнопки отмены или закрытия; `undefined` — Esc без
   * действия: модалка-решение без отмены или кнопка сейчас недоступна.
   */
  readonly onEscape?: (() => void) | undefined;
  readonly children: ReactNode;
}

/** Класс окна на время анимации высоты: тело без прокрутки (см. эффект высоты). */
const RESIZING_CLASS = 'modal--resizing';

export function Modal({
  labelledBy,
  describedBy,
  small,
  busy,
  className,
  onEscape,
  children,
}: ModalProps): ReactNode {
  const overlayRef = useRef<HTMLDivElement>(null);
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

  // Открытие и уход (B-4). Замена забирает уход прежней себе: копия прежней не вставляется,
  // затемнение остаётся, поднимается только новое окно.
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const dialog = dialogRef.current;
    const reduced = prefersReducedMotion();
    const replacing = closingThisCommit !== null && closingThisCommit.node !== overlay;
    if (replacing) {
      closingThisCommit?.cancel();
    }
    closingThisCommit = null;
    if (overlay !== null && !replacing) {
      animate(overlay, [{ opacity: 0 }, { opacity: 1 }], {
        duration: durationOf(reduced ? '--duration-exit' : '--duration-fast'),
        easing: easingOf('--ease-standard'),
      });
    }
    if (dialog !== null) {
      const rise = `translateY(${String(distanceOf('--distance-rise'))}px)`;
      animate(
        dialog,
        reduced
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              { opacity: 0, transform: rise },
              { opacity: 1, transform: 'none' },
            ],
        {
          duration: durationOf(reduced ? '--duration-exit' : '--duration-screen'),
          easing: easingOf(reduced ? '--ease-standard' : '--ease-out'),
        },
      );
    }
    return () => {
      const closing = { node: overlay, cancel: leaveWithGhost(overlay, fadeOut) };
      closingThisCommit = closing;
      queueMicrotask(() => {
        if (closingThisCommit === closing) {
          closingThisCommit = null;
        }
      });
    };
  }, []);

  // Высота при смене содержимого (B-4, KTD-4): после каждого рендера — сверка с прошлой высотой.
  // Идёт прежнее изменение — новое начинается от текущей, видимой высоты. Пока высота едет, окно
  // ниже содержимого, и тело (`overflow: auto`) показало бы скроллбар на эти 200 мс — класс
  // `modal--resizing` отключает ему прокрутку до конца анимации (замечание автора, 2026-11-04:
  // «Дополнительно» в `device`). Класс ставится прямо на элемент: состояние React перерисовало бы
  // окно и этим же эффектом перезапустило анимацию.
  const lastHeight = useRef<number | null>(null);
  const heightAnimation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const running = heightAnimation.current?.playState === 'running';
    const visible = dialog.offsetHeight;
    heightAnimation.current?.cancel();
    heightAnimation.current = null;
    dialog.classList.remove(RESIZING_CLASS);
    const natural = dialog.offsetHeight;
    const from = running ? visible : lastHeight.current;
    lastHeight.current = natural;
    if (from !== null && Math.abs(natural - from) > 1 && !prefersReducedMotion()) {
      const animation = animate(
        dialog,
        [{ height: `${String(from)}px` }, { height: `${String(natural)}px` }],
        { duration: durationOf('--duration-base'), easing: easingOf('--ease-out') },
      );
      if (animation === null) {
        return;
      }
      heightAnimation.current = animation;
      dialog.classList.add(RESIZING_CLASS);
      // Событие отмены приходит асинхронно — уже после старта следующей анимации: класс снимает
      // только та, что ещё текущая.
      const settle = (): void => {
        if (heightAnimation.current === animation) {
          heightAnimation.current = null;
          dialog.classList.remove(RESIZING_CLASS);
        }
      };
      animation.addEventListener('finish', settle);
      animation.addEventListener('cancel', settle);
    }
  });

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

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      // Обработанный Esc экрану под модалкой не достаётся: лента редактора сжала бы выделение.
      if (onEscape !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }
      return;
    }
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
    <div className="modal-overlay" ref={overlayRef}>
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-busy={busy === true ? true : undefined}
        tabIndex={-1}
        className={classes}
        onKeyDown={onKeyDown}
      >
        {children}
      </section>
    </div>
  );
}
