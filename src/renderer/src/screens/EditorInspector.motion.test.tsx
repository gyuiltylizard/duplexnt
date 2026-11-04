import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkewOutcome, StraightenFact, StraightenFacts } from '@shared';
import '../i18n';
import {
  clearMotionTokens,
  setMotionTokens,
  stubAnimate,
  unstubAnimate,
} from '../state/motion-fixture';
import { makePass, makeSnapshot, option, pages, renderEditor, stubApi } from './editor-fixture';

// Движение секций инспектора (B-45, handoff «Motion»; план U4, KTD-1…3): ключевые кадры и
// длительности поверх конечного состояния; `hidden` на теле ДЕТАЛЕЙ — по концу свёртывания;
// ушедшая секция — спейсер; под reduced-motion и без токенов движения ничего не играется.

const P = (n: number): string => `p01-s01-000${String(n)}`;
const fact = (
  outcome: SkewOutcome | null,
  extra: Partial<StraightenFact> = {},
): StraightenFact => ({
  outcome,
  version: null,
  detector: extra.version === undefined || extra.version === null ? null : 1,
  stale: false,
  deferred: null,
  cause: null,
  ...extra,
});
// 1 — выровнена (секция ВЫРАВНИВАНИЕ есть), 2 — ровная (секции нет), 3 — не померить (есть).
const FACTS: StraightenFacts = new Map([
  [P(1), fact('willStraighten', { version: 1 })],
  [P(2), fact('level')],
  [P(3), fact('unmeasurable')],
]);

const snapshot = () =>
  makeSnapshot([makePass({ pages: pages(3) })], {}, { straighten: 'auto' }, undefined, FACTS);

/** Высоты для jsdom (раскладки нет): секция — по `data-section`, с учётом свёрнутости ДЕТАЛЕЙ. */
const heights = new Map<string, number>();
function stubHeights(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const key = this.getAttribute('data-section');
      if (key === 'details') {
        // Идёт анимация — видимая (промежуточная) высота; иначе естественная по свёрнутости.
        if (this.classList.contains('inspector__section--resizing')) {
          return heights.get('details-visible') ?? 0;
        }
        const body = this.querySelector('.details');
        return body?.hasAttribute('hidden') === false ? (heights.get('details-open') ?? 0) : 40;
      }
      return key === null ? 0 : (heights.get(key) ?? 0);
    },
  });
}

const section = (key: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-section="${key}"]`);
const toggle = (): HTMLElement => screen.getByRole('button', { name: /ДЕТАЛИ/u });
const body = (): HTMLElement | null => document.querySelector<HTMLElement>('.details');
const heightFrames = (animations: ReturnType<typeof stubAnimate>['animations']) =>
  animations.filter((it) => 'height' in (it.keyframes[0] ?? {}));

describe('движение секций инспектора (B-45)', () => {
  beforeEach(() => {
    setMotionTokens();
    stubHeights();
    heights.set('details-open', 300);
    heights.set('straight', 120);
    heights.set('docs', 200);
  });
  afterEach(() => {
    cleanup();
    unstubAnimate();
    clearMotionTokens();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
    heights.clear();
  });

  it('первый рендер — без движения; раскрытие ДЕТАЛЕЙ: высота 40 → 300 за 240 мс, тело проявляется с задержкой ¼, стрелка поворачивается', () => {
    const { animations } = stubAnimate();
    stubApi();
    renderEditor(snapshot());
    expect(heightFrames(animations)).toHaveLength(0);

    fireEvent.click(toggle());
    const details = section('details');
    const height = heightFrames(animations).find((it) => it.element === details);
    expect(height?.keyframes).toEqual([{ height: '40px' }, { height: '300px' }]);
    expect(height?.options.duration).toBe(240);
    expect(height?.options.easing).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
    expect(details?.classList.contains('inspector__section--resizing')).toBe(true);
    const fade = animations.find((it) => it.element === body());
    expect(fade?.keyframes).toEqual([{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }]);
    const arrow = animations.find((it) => 'transform' in (it.keyframes[0] ?? {}));
    expect(arrow?.keyframes).toEqual([
      { transform: 'rotate(0deg)' },
      { transform: 'rotate(180deg)' },
    ]);

    height?.finish();
    expect(details?.classList.contains('inspector__section--resizing')).toBe(false);
  });

  it('свёртывание: тело видимо до конца, гаснет за 60 %, высота 300 → 40; hidden — по finish', () => {
    const { animations } = stubAnimate();
    stubApi();
    renderEditor(snapshot());
    fireEvent.click(toggle());
    heightFrames(animations).forEach((it) => {
      it.finish();
    });
    const before = animations.length;

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(body()?.hasAttribute('hidden')).toBe(false);
    const fresh = animations.slice(before);
    const height = heightFrames(fresh).find((it) => it.element === section('details'));
    expect(height?.keyframes).toEqual([{ height: '300px' }, { height: '40px' }]);
    const fade = fresh.find((it) => it.element === body());
    expect(fade?.keyframes).toEqual([{ opacity: 1 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }]);

    height?.finish();
    expect(body()?.hasAttribute('hidden')).toBe(true);
  });

  it('повторное раскрытие во время свёртывания: прежняя отменена, новая стартует от видимой высоты, hidden не ставится', () => {
    const { animations } = stubAnimate();
    stubApi();
    renderEditor(snapshot());
    fireEvent.click(toggle());
    heightFrames(animations).forEach((it) => {
      it.finish();
    });
    fireEvent.click(toggle());
    const collapsing = heightFrames(animations).at(-1);
    // Видимая высота посреди свёртывания — между раскрытой и свёрнутой.
    heights.set('details-visible', 180);

    fireEvent.click(toggle());
    expect(collapsing?.animation.playState).toBe('idle');
    const reopening = heightFrames(animations).at(-1);
    expect(reopening?.keyframes).toEqual([{ height: '180px' }, { height: '300px' }]);
    expect(body()?.hasAttribute('hidden')).toBe(false);
    // Отменённое свёртывание тело не прячет.
    collapsing?.finish();
    expect(body()?.hasAttribute('hidden')).toBe(false);
  });

  it('ВЫРАВНИВАНИЕ: уход — спейсер 120 → 0 перед ДОКУМЕНТАМИ; появление — 0 → 120 с проявлением; смена текста — 120 → 150', () => {
    const { animations } = stubAnimate();
    stubApi();
    renderEditor(snapshot());
    expect(section('straight')).not.toBeNull();

    // Страница 2 ровная — секции нет, на её месте спейсер.
    fireEvent.click(option(1));
    expect(section('straight')).toBeNull();
    const spacer = document.querySelector<HTMLElement>('.inspector__spacer');
    expect(spacer?.nextElementSibling).toBe(section('docs'));
    const collapse = animations.find((it) => it.element === spacer);
    expect(collapse?.keyframes).toEqual([{ height: '120px' }, { height: '0px' }]);
    collapse?.finish();
    expect(document.querySelector('.inspector__spacer')).toBeNull();

    // Страница 3 — секция появляется.
    fireEvent.click(option(2));
    const appear = animations.find((it) => it.element === section('straight'));
    expect(appear?.keyframes).toEqual([
      { height: '0px', opacity: 0 },
      { height: '120px', opacity: 1 },
    ]);
    appear?.finish();

    // Страница 1 — другой текст, другая высота.
    heights.set('straight', 150);
    fireEvent.click(option(0));
    const change = heightFrames(animations).at(-1);
    expect(change?.element).toBe(section('straight'));
    expect(change?.keyframes).toEqual([{ height: '120px' }, { height: '150px' }]);
  });

  it('reduced-motion: анимаций нет, свёрнутое тело скрыто сразу', () => {
    const { animations } = stubAnimate();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    stubApi();
    renderEditor(snapshot());

    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(heightFrames(animations)).toHaveLength(0);
    expect(body()?.hasAttribute('hidden')).toBe(true);
    fireEvent.click(option(1));
    expect(document.querySelector('.inspector__spacer')).toBeNull();
  });

  it('без токена длительности движения нет', () => {
    const { animations } = stubAnimate();
    document.documentElement.style.removeProperty('--duration-section');
    stubApi();
    renderEditor(snapshot());

    fireEvent.click(toggle());
    expect(heightFrames(animations)).toHaveLength(0);
  });
});
