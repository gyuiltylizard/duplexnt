import { useLayoutEffect, useRef, type RefObject } from 'react';
import { animate, durationOf, easingOf, prefersReducedMotion } from '../state/motion';

// Движение секций инспектора (B-45, handoff `2026-11-inspector-v2.md` «Motion»; план KTD-1…3).
// Один хук на инспектор: после каждого рендера секции с `data-section` сверяются с прошлым
// замером `offsetHeight` (layout-размер, не `getBoundingClientRect`: при масштабе окна старт был
// бы неверным), и разница играется поверх конечного состояния за `--duration-section` по
// `--ease-section`. Как и у высоты модалки (B-4, KTD-4): идёт прежняя анимация — новая стартует
// от видимой высоты; под reduced-motion и без WAAPI (jsdom) — ничего, разметка и так конечная.
//
// ДЕТАЛИ: раскрытие — высота от свёрнутой к полной, тело проявляется с задержкой ¼; свёртывание —
// тело остаётся видимым до конца и гаснет за 60 %, `hidden` ставится по `finish` (KTD-2: 240 мс
// показ расходится с разметкой — единственное такое место). ПУСТОЙ ОБОРОТ и ВЫРАВНИВАНИЕ:
// появление `0 → h` с проявлением, смена текста `h1 → h2`, уход — спейсер прежней высоты на том
// же месте схлопывается (KTD-3), ДОКУМЕНТЫ поднимаются по потоку. Скролл инспектора сохраняется.

/** Секции в порядке колонки; `docs` и `footer` сами не анимируются — едут по потоку. */
const SECTION_ORDER = ['details', 'blank', 'straight', 'docs', 'footer'] as const;
export type InspectorSection = (typeof SECTION_ORDER)[number];
const ANIMATED: readonly InspectorSection[] = ['blank', 'straight'];

/** Класс секции на время анимации высоты: содержимое не выглядывает за растущий край. */
export const RESIZING_CLASS = 'inspector__section--resizing';
const SPACER_CLASS = 'inspector__spacer';

function sectionsOf(root: HTMLElement): Map<InspectorSection, HTMLElement> {
  const found = new Map<InspectorSection, HTMLElement>();
  for (const key of SECTION_ORDER) {
    const element = root.querySelector<HTMLElement>(`:scope > [data-section="${key}"]`);
    if (element !== null) {
      found.set(key, element);
    }
  }
  return found;
}

const px = (value: number): string => `${String(value)}px`;

export function useInspectorMotion(
  root: RefObject<HTMLElement | null>,
  detailsOpen: boolean,
): void {
  /** Естественные высоты после прошлого рендера; `null` — рендера ещё не было. */
  const heights = useRef<Map<InspectorSection, number> | null>(null);
  const running = useRef<Map<InspectorSection, Animation>>(new Map());
  const wasOpen = useRef(detailsOpen);
  const openNow = useRef(detailsOpen);

  useLayoutEffect(() => {
    openNow.current = detailsOpen;
    const aside = root.current;
    if (aside === null) {
      return;
    }
    const sections = sectionsOf(aside);
    const previous = heights.current;
    const previousOpen = wasOpen.current;
    wasOpen.current = detailsOpen;

    // Видимые высоты — до отмены идущих анимаций: от них стартует новое движение.
    const visible = new Map<InspectorSection, number>();
    const wasRunning = new Set(running.current.keys());
    for (const [key, element] of sections) {
      visible.set(key, element.offsetHeight);
    }
    for (const animation of running.current.values()) {
      animation.cancel();
    }
    running.current.clear();
    for (const element of sections.values()) {
      element.classList.remove(RESIZING_CLASS);
    }
    const natural = new Map<InspectorSection, number>();
    for (const [key, element] of sections) {
      natural.set(key, element.offsetHeight);
    }
    heights.current = natural;

    const duration = durationOf('--duration-section');
    const easing = easingOf('--ease-section');
    if (previous === null || duration <= 0 || prefersReducedMotion()) {
      return;
    }
    const scrollTop = aside.scrollTop;
    const startOf = (key: InspectorSection): number | undefined =>
      wasRunning.has(key) ? visible.get(key) : previous.get(key);

    const run = (
      key: InspectorSection,
      element: HTMLElement,
      from: number,
      to: number,
      options: { readonly fadeIn?: boolean; readonly onFinish?: () => void } = {},
    ): Animation | null => {
      if (Math.abs(to - from) <= 1 && options.fadeIn !== true) {
        return null;
      }
      const frames: Keyframe[] =
        options.fadeIn === true
          ? [
              { height: px(from), opacity: 0 },
              { height: px(to), opacity: 1 },
            ]
          : [{ height: px(from) }, { height: px(to) }];
      const animation = animate(element, frames, { duration, easing });
      if (animation === null) {
        return null;
      }
      element.classList.add(RESIZING_CLASS);
      running.current.set(key, animation);
      // Событие отмены приходит асинхронно, уже после старта следующей анимации: снимает
      // класс только та, что ещё текущая.
      const settle = (event: Event): void => {
        if (running.current.get(key) !== animation) {
          return;
        }
        running.current.delete(key);
        element.classList.remove(RESIZING_CLASS);
        if (event.type === 'finish') {
          options.onFinish?.();
        }
      };
      animation.addEventListener('finish', settle);
      animation.addEventListener('cancel', settle);
      return animation;
    };

    // ДЕТАЛИ: раскрытие, свёртывание и смена содержимого (другая страница — другие факты).
    const details = sections.get('details');
    if (details !== undefined) {
      const body = details.querySelector<HTMLElement>('.details');
      const arrow = details.querySelector<HTMLElement>('.details-toggle__arrow');
      const to = natural.get('details') ?? 0;
      const from = startOf('details');
      if (previousOpen && !detailsOpen && body !== null && from !== undefined) {
        // Тело видимо до конца анимации; без анимации — остаётся скрытым, как в разметке.
        body.hidden = false;
        const height = run('details', details, from, to, {
          onFinish: () => {
            if (!openNow.current) {
              body.hidden = true;
            }
          },
        });
        if (height === null) {
          body.hidden = true;
        } else {
          animate(body, [{ opacity: 1 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }], {
            duration,
            easing,
          });
        }
      } else {
        const height = run('details', details, from ?? to, to);
        if (!previousOpen && detailsOpen && body !== null && height !== null) {
          animate(body, [{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }], {
            duration,
            easing,
          });
        }
      }
      if (arrow !== null && previousOpen !== detailsOpen) {
        animate(
          arrow,
          [
            { transform: `rotate(${previousOpen ? '180' : '0'}deg)` },
            { transform: `rotate(${detailsOpen ? '180' : '0'}deg)` },
          ],
          { duration, easing },
        );
      }
    }

    // ПУСТОЙ ОБОРОТ и ВЫРАВНИВАНИЕ: появление, смена текста, уход.
    for (const key of ANIMATED) {
      const element = sections.get(key);
      const before = startOf(key);
      const to = natural.get(key);
      if (element !== undefined && to !== undefined) {
        if (before === undefined) {
          run(key, element, 0, to, { fadeIn: true });
        } else {
          run(key, element, before, to);
        }
        continue;
      }
      if (before === undefined) {
        continue;
      }
      // Секция ушла: спейсер её высоты на её месте схлопывается, нижние едут по потоку.
      const next = SECTION_ORDER.slice(SECTION_ORDER.indexOf(key) + 1)
        .map((later) => sections.get(later))
        .find((candidate) => candidate !== undefined);
      const spacer = document.createElement('div');
      spacer.className = SPACER_CLASS;
      spacer.setAttribute('aria-hidden', 'true');
      spacer.style.height = px(before);
      aside.insertBefore(spacer, next ?? null);
      const collapse = animate(spacer, [{ height: px(before) }, { height: px(0) }], {
        duration,
        easing,
      });
      if (collapse === null) {
        spacer.remove();
      } else {
        const remove = (): void => {
          spacer.remove();
        };
        collapse.addEventListener('finish', remove);
        collapse.addEventListener('cancel', remove);
      }
    }
    restoreScroll(aside, scrollTop);
  });
}

/** Скролл инспектора после перестановки секций — тот же, что до неё. */
function restoreScroll(element: HTMLElement, top: number): void {
  element.scrollTop = top;
}
