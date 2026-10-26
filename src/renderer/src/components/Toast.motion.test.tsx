import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMotionTokens,
  flushMicrotasks,
  setMotionTokens,
  stubAnimate,
  unstubAnimate,
} from '../state/motion-fixture';
import { Toast } from './Toast';

// Движение тоста (B-4, handoff «4. Модалки и тост»).

function Host({
  toast,
  onExpire,
}: {
  readonly toast: string | null;
  readonly onExpire: () => void;
}) {
  return (
    <div className="app">
      {toast !== null && (
        <Toast
          key={toast}
          text={toast}
          action={{ label: 'Открыть папку', onClick: vi.fn() }}
          onExpire={onExpire}
        />
      )}
    </div>
  );
}

describe('тост — движение (B-4)', () => {
  beforeEach(setMotionTokens);
  afterEach(() => {
    cleanup();
    unstubAnimate();
    clearMotionTokens();
    vi.useRealTimers();
  });

  it('появление: проявляется с подъёмом за 180 мс, центровка сохраняется', () => {
    const { animations } = stubAnimate();
    render(<Host toast="Сохранено" onExpire={vi.fn()} />);

    const enter = animations.find((it) => it.element.classList.contains('toast'));
    expect(enter?.keyframes).toEqual([
      { opacity: 0, transform: 'translateX(-50%) translateY(6px)' },
      { opacity: 1, transform: 'translateX(-50%)' },
    ]);
    expect(enter?.options.duration).toBe(180);
  });

  it('срок вышел — тост гаснет копией за 120 мс', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { animations } = stubAnimate();
    const view = render(<Host toast="Сохранено" onExpire={() => undefined} />);

    act(() => {
      vi.advanceTimersByTime(2600);
    });
    view.rerender(<Host toast={null} onExpire={() => undefined} />);
    await act(flushMicrotasks);

    const ghost = view.container.querySelector('.toast');
    expect(ghost?.hasAttribute('inert')).toBe(true);
    expect(animations.find((it) => it.element === ghost)?.keyframes).toEqual([
      { opacity: 1 },
      { opacity: 0 },
    ]);
  });

  it('закрыт действием — тоже гаснет', async () => {
    stubAnimate();
    const view = render(<Host toast="Сохранено" onExpire={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Открыть папку' }));
    view.rerender(<Host toast={null} onExpire={() => undefined} />);
    await act(flushMicrotasks);

    expect(view.container.querySelector('.toast')?.hasAttribute('inert')).toBe(true);
  });

  it('вытеснен новым — снимается сразу, без копии', async () => {
    stubAnimate();
    const view = render(<Host toast="Страница удалена" onExpire={() => undefined} />);

    view.rerender(<Host toast="Сохранено" onExpire={() => undefined} />);
    await act(flushMicrotasks);

    const toasts = view.container.querySelectorAll('.toast');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.textContent).toContain('Сохранено');
    expect(toasts[0]?.hasAttribute('inert')).toBe(false);
  });
});
