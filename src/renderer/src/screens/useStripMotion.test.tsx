import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMotionTokens,
  flushMicrotasks,
  setMotionTokens,
  stubAnimate,
  unstubAnimate,
} from '../state/motion-fixture';
import { useLeavingCard, useStripMotion } from './useStripMotion';

// Лента последних страниц на `scan` — движение (B-4, handoff «2. Лента»).

function Card({ id }: { readonly id: string }) {
  const ref = useRef<HTMLLIElement>(null);
  useLeavingCard(ref);
  return <li ref={ref} data-key={id} className="strip__card" />;
}

function Strip({ keys }: { readonly keys: readonly string[] }) {
  const ref = useRef<HTMLUListElement>(null);
  useStripMotion(ref, keys);
  return (
    <ul ref={ref} className="strip">
      {keys.map((key) => (
        <Card key={key} id={key} />
      ))}
    </ul>
  );
}

/** Раскладка для jsdom: карточка по 58 px (50 + зазор 8), место — по позиции в ленте. */
function stubLayout(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    configurable: true,
    get(this: HTMLElement) {
      const siblings = [...(this.parentElement?.querySelectorAll(':scope > [data-key]') ?? [])];
      return siblings.indexOf(this) * 58;
    },
  });
}

describe('лента scan — движение (B-4)', () => {
  beforeEach(() => {
    setMotionTokens();
    stubLayout();
  });
  afterEach(() => {
    cleanup();
    unstubAnimate();
    clearMotionTokens();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, 'offsetLeft');
  });

  it('первый показ — без движения', () => {
    const { animateFn } = stubAnimate();
    render(<Strip keys={['p1', 'p2']} />);

    expect(animateFn).not.toHaveBeenCalled();
  });

  it('пришла страница: новая въезжает справа на 12 px за 180 мс; места прежних не сменились — они стоят', () => {
    const { animations } = stubAnimate();
    const view = render(<Strip keys={['p1', 'p2']} />);

    view.rerender(<Strip keys={['p1', 'p2', 'p3']} />);

    expect(animations).toHaveLength(1);
    expect((animations[0]?.element as HTMLElement).dataset.key).toBe('p3');
    expect(animations[0]?.keyframes).toEqual([
      { opacity: 0, transform: 'translateX(12px)' },
      { transform: 'none' },
    ]);
    expect(animations[0]?.options.duration).toBe(180);
  });

  it('шестая страница: остальные сдвигаются от прежнего места, первая уходит копией — гаснет влево', async () => {
    const { animations } = stubAnimate();
    const keys = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const view = render(<Strip keys={keys} />);

    view.rerender(<Strip keys={['p2', 'p3', 'p4', 'p5', 'p6']} />);
    await act(flushMicrotasks);

    // p2 стояла на 58, теперь на 0 — сдвиг от +58 к месту.
    const p2 = animations.find((it) => (it.element as HTMLElement).dataset.key === 'p2');
    expect(p2?.keyframes).toEqual([{ transform: 'translateX(58px)' }, { transform: 'none' }]);
    const leaving = view.container.querySelector('.strip__card--leaving');
    expect((leaving as HTMLElement | null)?.dataset.key).toBe('p1');
    expect(leaving?.hasAttribute('inert')).toBe(true);
    const fade = animations.find((it) => it.element === leaving);
    expect(fade?.keyframes.at(-1)).toEqual({ opacity: 0, transform: 'translateX(-12px)' });
    expect(fade?.options.duration).toBe(120);
  });

  it('reduced-motion: новая только проявляется за 120 мс, сдвига и копии нет', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    const { animations } = stubAnimate();
    const view = render(<Strip keys={['p1', 'p2', 'p3', 'p4', 'p5']} />);

    view.rerender(<Strip keys={['p2', 'p3', 'p4', 'p5', 'p6']} />);
    await act(flushMicrotasks);

    expect(animations).toHaveLength(1);
    expect(animations[0]?.keyframes).toEqual([{ opacity: 0 }, {}]);
    expect(animations[0]?.options.duration).toBe(120);
    expect(view.container.querySelector('.strip__card--leaving')).toBeNull();
  });
});
