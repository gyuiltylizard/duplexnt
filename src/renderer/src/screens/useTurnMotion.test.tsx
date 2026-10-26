import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageAngle } from '@shared';
import {
  clearMotionTokens,
  setMotionTokens,
  stubAnimate,
  unstubAnimate,
} from '../state/motion-fixture';
import { clearTurns, markTurn } from '../state/turns';
import { useTurnMotion } from './useTurnMotion';

// Поворот листа целиком на дельту команды (B-4, handoff «3. Поворот»).

function Thumb({ angle }: { readonly angle: PageAngle }) {
  const ref = useRef<HTMLImageElement>(null);
  useTurnMotion(ref, 'p1', angle, 'thumb');
  return <img ref={ref} alt="" className="thumb__img" />;
}

function Preview({ angle }: { readonly angle: PageAngle }) {
  const ref = useRef<HTMLDivElement>(null);
  useTurnMotion(ref, 'p1', angle, 'preview');
  return <div ref={ref} className="preview__paper" />;
}

describe('поворот — движение (B-4)', () => {
  beforeEach(setMotionTokens);
  afterEach(() => {
    cleanup();
    unstubAnimate();
    clearMotionTokens();
    clearTurns();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
  });

  it('↻ на 90°: миниатюра доворачивается от прежнего вида к новому за 240 мс, масштаб вписывания — тоже', () => {
    const { animations } = stubAnimate();
    const view = render(<Thumb angle={0} />);

    markTurn(['p1'], 90);
    view.rerender(<Thumb angle={90} />);

    expect(animations).toHaveLength(1);
    expect(animations[0]?.keyframes).toEqual([
      { transform: 'rotate(0deg) scale(1)' },
      { transform: `rotate(90deg) scale(${String(Math.SQRT1_2)})` },
    ]);
    expect(animations[0]?.options.duration).toBe(240);
  });

  it('270° → 0° по ↻ — четверть оборота по часовой, а не три четверти назад', () => {
    const { animations } = stubAnimate();
    const view = render(<Thumb angle={270} />);

    markTurn(['p1'], 90);
    view.rerender(<Thumb angle={0} />);

    expect(animations[0]?.keyframes).toEqual([
      { transform: `rotate(-90deg) scale(${String(Math.SQRT1_2)})` },
      { transform: 'rotate(0deg) scale(1)' },
    ]);
  });

  it('прерванный поворот продолжается с текущего положения: ↻↻ — одно вращение', () => {
    const { animations } = stubAnimate();
    const view = render(<Thumb angle={0} />);

    markTurn(['p1'], 90);
    view.rerender(<Thumb angle={90} />);
    animations[0]?.setProgress(0.5); // прошёл половину: осталось −45°
    markTurn(['p1'], 90);
    view.rerender(<Thumb angle={180} />);

    expect(animations[0]?.animation.playState).toBe('idle');
    // Новый — от 180 − 90 − 45 = 45°: там, где лист сейчас виден.
    expect(animations[1]?.keyframes[0]).toEqual({
      transform: `rotate(45deg) scale(${String(Math.SQRT1_2)})`,
    });
  });

  it('смена угла без команды (undo, redo, снимок) — без анимации', () => {
    const { animateFn } = stubAnimate();
    const view = render(<Thumb angle={0} />);

    view.rerender(<Thumb angle={90} />);

    expect(animateFn).not.toHaveBeenCalled();
  });

  it('команда отрабатывается один раз: повторный рендер с тем же углом её не повторяет', () => {
    const { animations } = stubAnimate();
    const view = render(<Thumb angle={0} />);

    markTurn(['p1'], 90);
    view.rerender(<Thumb angle={90} />);
    view.rerender(<Thumb angle={0} />); // undo — та же отметка уже отработана

    expect(animations).toHaveLength(1);
  });

  it('превью: лист целиком — от поворота назад на дельту и прежней длинной стороны к месту', () => {
    const { animations } = stubAnimate();
    let width = 400;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => width,
    });
    const view = render(<Preview angle={0} />);

    width = 566; // альбомный лист шире
    markTurn(['p1'], 90);
    view.rerender(<Preview angle={90} />);

    expect(animations[0]?.keyframes).toEqual([
      { transform: `rotate(-90deg) scale(${String(400 / 566)})` },
      { transform: 'none' },
    ]);
  });

  it('reduced-motion — без анимации, классы мгновенно', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    const { animateFn } = stubAnimate();
    const view = render(<Thumb angle={0} />);

    markTurn(['p1'], 90);
    view.rerender(<Thumb angle={90} />);

    expect(animateFn).not.toHaveBeenCalled();
  });
});
