import { vi } from 'vitest';

// ТОЛЬКО ДЛЯ ТЕСТОВ: подставной Web Animations API (jsdom его не знает) и токены движения (B-4).

export interface StubAnimation {
  readonly element: Element;
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions;
  readonly animation: Animation;
  /** Анимация дошла до конца: `finish` для слушателей. */
  readonly finish: () => void;
}

/**
 * `Element.prototype.animate` — запись вызовов; анимация — цель событий с `finish()` и
 * `cancel()`, как у настоящей. Снимается `unstubAnimate`.
 */
export function stubAnimate() {
  const animations: StubAnimation[] = [];
  const animateFn = vi.fn(function (
    this: Element,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ) {
    const target = new EventTarget();
    let state: AnimationPlayState = 'running';
    const finish = (): void => {
      if (state === 'running') {
        state = 'finished';
        target.dispatchEvent(new Event('finish'));
      }
    };
    // Геттер — через defineProperty: Object.assign скопировал бы значение, а не геттер.
    const animation = Object.defineProperties(target, {
      finish: { value: finish },
      cancel: {
        value: () => {
          if (state === 'running') {
            state = 'idle';
            target.dispatchEvent(new Event('cancel'));
          }
        },
      },
      playState: { get: () => state },
    }) as unknown as Animation;
    animations.push({ element: this, keyframes, options, animation, finish });
    return animation;
  });
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: animateFn,
  });
  return { animateFn, animations };
}

export function unstubAnimate(): void {
  Reflect.deleteProperty(Element.prototype, 'animate');
}

/** Токены движения на корне документа: без них длительности нулевые и анимации нет. */
export function setMotionTokens(): void {
  const root = document.documentElement.style;
  root.setProperty('--duration-exit', '120ms');
  root.setProperty('--duration-fast', '150ms');
  root.setProperty('--duration-screen', '180ms');
  root.setProperty('--duration-base', '200ms');
  root.setProperty('--duration-turn', '240ms');
  root.setProperty('--ease-out', 'cubic-bezier(0.2, 0, 0, 1)');
  root.setProperty('--ease-standard', 'ease');
  root.setProperty('--distance-rise', '6px');
  root.setProperty('--distance-enter', '12px');
}

export function clearMotionTokens(): void {
  document.documentElement.removeAttribute('style');
}

/** Дождаться микрозадач: копия уходящего узла вставляется микрозадачей после коммита. */
export const flushMicrotasks = (): Promise<void> =>
  new Promise((done) => {
    queueMicrotask(done);
  });
