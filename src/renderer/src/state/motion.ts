// Основа движения (B-4, handoff `2026-10-b4-motion.md`; план, KTD-1). Правила одни на все места:
// движение — только показ поверх конечного состояния, которое ставится классами и разметкой
// сразу (R3); без Web Animations API (jsdom) или под `prefers-reduced-motion` интерфейс в каждом
// кадре такой же, как без анимации. Длительности и кривые — из токенов; токены не прочитались
// (стили не подключены) — анимации нет.

export type DurationToken =
  | '--duration-exit'
  | '--duration-fast'
  | '--duration-screen'
  | '--duration-base'
  | '--duration-turn';

export type EasingToken = '--ease-out' | '--ease-standard';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Человек попросил систему убрать движение. */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches;
}

function tokenOf(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Длительность токена в мс; 0 — токен не прочитан (тогда анимации нет). */
export function durationOf(token: DurationToken): number {
  const match = /^([\d.]+)(ms|s)$/.exec(tokenOf(token));
  if (match?.[1] === undefined) {
    return 0;
  }
  const value = Number(match[1]);
  return match[2] === 's' ? value * 1000 : value;
}

export function easingOf(token: EasingToken): string {
  return tokenOf(token) || 'ease';
}

/** Расстояние токена в px (`--distance-rise`, `--distance-enter`). */
export function distanceOf(token: '--distance-rise' | '--distance-enter'): number {
  return Number.parseFloat(tokenOf(token)) || 0;
}

/**
 * Анимация поверх конечного состояния. `null` — анимировать нечем или незачем: нет WAAPI или
 * длительность нулевая.
 */
export function animate(
  element: Element,
  keyframes: Keyframe[],
  options: { readonly duration: number; readonly easing?: string; readonly delay?: number },
): Animation | null {
  if (typeof element.animate !== 'function' || options.duration <= 0) {
    return null;
  }
  return element.animate(keyframes, { fill: 'backwards', ...options });
}

/** Узел снимается, когда анимация кончилась или отменена; без анимации — сразу. */
function removeAfter(node: Element, animation: Animation | null): void {
  if (animation === null) {
    node.remove();
    return;
  }
  const remove = (): void => {
    node.remove();
  };
  animation.addEventListener('finish', remove);
  animation.addEventListener('cancel', remove);
}

/** Копия уходящего узла: ввод в неё не идёт, вспомогательные технологии её не видят. */
export function ghostOf(node: HTMLElement): HTMLElement {
  const ghost = node.cloneNode(true) as HTMLElement;
  ghost.setAttribute('inert', '');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.removeAttribute('id');
  for (const withId of ghost.querySelectorAll('[id]')) {
    withId.removeAttribute('id');
  }
  return ghost;
}

/**
 * Уход узла, который React вот-вот снимет (KTD-2): копия снимается сейчас, синхронно, пока узел
 * ещё в DOM, а вставляется микрозадачей — после коммита и до отрисовки. Если узел к тому времени
 * на месте, это было не снятие (повторный монтаж StrictMode) — копия не нужна. `into` — куда
 * класть копию, если не на место узла (экран уходит вместе с обёрткой). Возвращает отмену:
 * новая сцена может забрать уход себе (замена модалки, новая смена экрана).
 */
export function leaveWithGhost(
  node: HTMLElement | null,
  place: (ghost: HTMLElement) => Animation | null,
  into: { readonly parent: HTMLElement | null; readonly next: Node | null } | null = null,
): () => void {
  const parent = into === null ? (node?.parentElement ?? null) : into.parent;
  if (node === null || parent === null || typeof node.animate !== 'function') {
    return () => undefined;
  }
  const next = into === null ? node.nextSibling : into.next;
  const ghost = ghostOf(node);
  let cancelled = false;
  queueMicrotask(() => {
    if (cancelled || node.isConnected || !parent.isConnected) {
      return;
    }
    parent.insertBefore(ghost, next?.parentNode === parent ? next : null);
    removeAfter(ghost, place(ghost));
  });
  return () => {
    cancelled = true;
    ghost.remove();
  };
}

/** Гашение копии за `--duration-exit` (уход модалки, тоста). */
export function fadeOut(ghost: HTMLElement): Animation | null {
  return animate(ghost, [{ opacity: 1 }, { opacity: 0 }], {
    duration: durationOf('--duration-exit'),
    easing: easingOf('--ease-standard'),
  });
}
