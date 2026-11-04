import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMotionTokens,
  flushMicrotasks,
  setMotionTokens,
  stubAnimate,
  unstubAnimate,
} from '../state/motion-fixture';
import { Modal } from './Modal';

// Движение модалки (B-4, handoff «4. Модалки и тост»).

function Dialog({ name, lines = 1 }: { readonly name: string; readonly lines?: number }) {
  return (
    <Modal labelledBy={`${name}-title`}>
      <h2 id={`${name}-title`}>{name}</h2>
      {Array.from({ length: lines }, (_, index) => (
        <p key={index}>строка {index + 1}</p>
      ))}
      <button type="button">Ок</button>
    </Modal>
  );
}

function Host({ open }: { readonly open: 'newscan' | 'save' | null }) {
  return (
    <div className="screen">
      {open === 'newscan' && <Dialog key="newscan" name="newscan" />}
      {open === 'save' && <Dialog key="save" name="save" />}
    </div>
  );
}

/** Высота окна для jsdom: раскладки там нет, `offsetHeight` всегда 0. */
let heights = new Map<string, number>();
function stubHeights(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return heights.get(this.getAttribute('role') ?? '') ?? 0;
    },
  });
}

function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: reduced })),
  );
}

describe('модалка — движение (B-4)', () => {
  beforeEach(setMotionTokens);
  afterEach(() => {
    cleanup();
    unstubAnimate();
    clearMotionTokens();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
    heights = new Map();
  });

  it('открытие: затемнение проявляется за 150 мс, окно поднимается за 180 мс', () => {
    const { animations } = stubAnimate();
    render(<Host open="newscan" />);

    const overlay = animations.find((it) => it.element.classList.contains('modal-overlay'));
    expect(overlay?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(overlay?.options.duration).toBe(150);
    const dialog = animations.find((it) => it.element.getAttribute('role') === 'dialog');
    expect(dialog?.keyframes).toEqual([
      { opacity: 0, transform: 'translateY(6px)' },
      { opacity: 1, transform: 'none' },
    ]);
    expect(dialog?.options.duration).toBe(180);
  });

  it('StrictMode (dev): повторный монтаж — не замена, затемнение проявляется', () => {
    const { animations } = stubAnimate();
    render(
      <StrictMode>
        <Host open="newscan" />
      </StrictMode>,
    );

    expect(animations.some((it) => it.element.classList.contains('modal-overlay'))).toBe(true);
  });

  it('закрытие: копия затемнения с окном гаснет за 120 мс, ввод в неё не идёт, затем снимается', async () => {
    const { animations } = stubAnimate();
    const view = render(<Host open="newscan" />);

    view.rerender(<Host open={null} />);
    await act(flushMicrotasks);

    const ghost = view.container.querySelector('.modal-overlay');
    expect(ghost?.hasAttribute('inert')).toBe(true);
    expect(ghost?.querySelector('[role="dialog"]')).not.toBeNull();
    const fade = animations.find((it) => it.element === ghost);
    expect(fade?.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(fade?.options.duration).toBe(120);
    fade?.finish();
    expect(view.container.querySelector('.modal-overlay')).toBeNull();
  });

  it('замена (newscan → save): затемнение не моргает — копии нет, поднимается только новое окно', async () => {
    const { animations } = stubAnimate();
    const view = render(<Host open="newscan" />);
    const before = animations.length;

    view.rerender(<Host open="save" />);
    await act(flushMicrotasks);

    expect(view.container.querySelectorAll('.modal-overlay')).toHaveLength(1);
    const fresh = animations.slice(before);
    expect(fresh.some((it) => it.element.classList.contains('modal-overlay'))).toBe(false);
    expect(fresh.filter((it) => it.element.getAttribute('role') === 'dialog')).toHaveLength(1);
  });

  it('смена содержимого: высота окна от прежней к новой за 200 мс', () => {
    const { animations } = stubAnimate();
    stubHeights();
    heights.set('dialog', 300);
    const view = render(<Dialog name="save" lines={1} />);

    heights.set('dialog', 420);
    view.rerender(<Dialog name="save" lines={4} />);

    const height = animations.find((it) => 'height' in (it.keyframes[0] ?? {}));
    expect(height?.keyframes).toEqual([{ height: '300px' }, { height: '420px' }]);
    expect(height?.options.duration).toBe(200);
  });

  it('пока высота едет, окно несёт modal--resizing (тело без прокрутки); конец или отмена снимают', () => {
    const { animations } = stubAnimate();
    stubHeights();
    heights.set('dialog', 300);
    const view = render(<Dialog name="save" lines={1} />);
    const dialog = view.getByRole('dialog');

    heights.set('dialog', 420);
    view.rerender(<Dialog name="save" lines={4} />);
    expect(dialog.classList.contains('modal--resizing')).toBe(true);

    const first = animations.find((it) => 'height' in (it.keyframes[0] ?? {}));
    first?.finish();
    expect(dialog.classList.contains('modal--resizing')).toBe(false);

    // Рендер поверх идущей анимации отменяет её; новой нет (в jsdom видимая высота равна
    // естественной) — класс снят вместе с отменой, а не висит до события `cancel`.
    heights.set('dialog', 500);
    view.rerender(<Dialog name="save" lines={6} />);
    expect(dialog.classList.contains('modal--resizing')).toBe(true);
    view.rerender(<Dialog name="save" lines={6} />);
    const all = animations.filter((it) => 'height' in (it.keyframes[0] ?? {}));
    expect(all.length).toBe(2);
    expect(all[1]?.animation.playState).toBe('idle');
    expect(dialog.classList.contains('modal--resizing')).toBe(false);
  });

  it('высота не изменилась — анимации высоты нет', () => {
    const { animations } = stubAnimate();
    stubHeights();
    heights.set('dialog', 300);
    const view = render(<Dialog name="save" />);

    view.rerender(<Dialog name="save" />);

    expect(animations.some((it) => 'height' in (it.keyframes[0] ?? {}))).toBe(false);
  });

  it('reduced-motion: окно только проявляется за 120 мс без подъёма, высота — мгновенно', () => {
    const { animations } = stubAnimate();
    stubReducedMotion(true);
    stubHeights();
    heights.set('dialog', 300);
    const view = render(<Dialog name="save" />);

    const dialog = animations.find((it) => it.element.getAttribute('role') === 'dialog');
    expect(dialog?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(dialog?.options.duration).toBe(120);

    heights.set('dialog', 420);
    view.rerender(<Dialog name="save" lines={4} />);
    expect(animations.some((it) => 'height' in (it.keyframes[0] ?? {}))).toBe(false);
  });
});
