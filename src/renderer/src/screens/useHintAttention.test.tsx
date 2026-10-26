import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@shared';
import { useHintAttention } from './useHintAttention';

// Подсказка «обратить внимание» (B-4, handoff «5. Подсказка про Ctrl/Shift»).

function Inspector({ eligible }: { readonly eligible: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const attention = useHintAttention(ref, 'docsSplit', eligible);
  return (
    <div>
      <aside className="rail">
        <button type="button">миниатюра</button>
      </aside>
      <p ref={ref} data-testid="note" data-attention={attention}>
        Границы не отмечены
      </p>
    </div>
  );
}

const note = (): HTMLElement => screen.getByTestId('note');

describe('подсказка про Ctrl/Shift — внимание (B-4)', () => {
  let markHintSeen: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    markHintSeen = vi.fn(() => Promise.resolve(ok(undefined)));
    vi.stubGlobal('api', { markHintSeen });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('первый показ: флаг ставится сразу, подсветка — через 580 мс, гаснет по концу анимации', () => {
    render(<Inspector eligible />);

    expect(markHintSeen).toHaveBeenCalledExactlyOnceWith('docsSplit');
    expect(note().dataset.attention).toBe('none');
    act(() => {
      vi.advanceTimersByTime(580);
    });
    expect(note().dataset.attention).toBe('blink');

    fireEvent.animationEnd(note());
    expect(note().dataset.attention).toBe('none');
  });

  it('пришёл снимок с флагом — идущая подсветка не обрывается, флаг повторно не ставится', () => {
    const view = render(<Inspector eligible />);
    act(() => {
      vi.advanceTimersByTime(580);
    });

    view.rerender(<Inspector eligible={false} />);
    view.rerender(<Inspector eligible />);

    expect(note().dataset.attention).toBe('blink');
    expect(markHintSeen).toHaveBeenCalledOnce();
  });

  it('гаснет раньше: наведение на подсказку', () => {
    render(<Inspector eligible />);
    act(() => {
      vi.advanceTimersByTime(580);
    });

    fireEvent.mouseEnter(note());

    expect(note().dataset.attention).toBe('none');
  });

  it('гаснет раньше: человек занялся лентой (до или во время подсветки)', () => {
    render(<Inspector eligible />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'миниатюра' }));
    act(() => {
      vi.advanceTimersByTime(580);
    });

    expect(note().dataset.attention).toBe('none');
  });

  it('уже показывалась — ни подсветки, ни отметки', () => {
    render(<Inspector eligible={false} />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(markHintSeen).not.toHaveBeenCalled();
    expect(note().dataset.attention).toBe('none');
  });

  it('reduced-motion: ровная подсветка на 3,8 с вместо мигания, затем гаснет', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    render(<Inspector eligible />);

    act(() => {
      vi.advanceTimersByTime(580);
    });
    expect(note().dataset.attention).toBe('static');
    act(() => {
      vi.advanceTimersByTime(3800);
    });
    expect(note().dataset.attention).toBe('none');
  });
});
