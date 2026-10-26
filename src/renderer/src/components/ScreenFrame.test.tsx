import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearMotionTokens,
  flushMicrotasks,
  setMotionTokens,
  stubAnimate,
  unstubAnimate,
} from '../state/motion-fixture';
import { ScreenFrame } from './ScreenFrame';

function Screens({ screen }: { readonly screen: 'setup' | 'scan' }) {
  return (
    <div className="app">
      {screen === 'setup' ? (
        <ScreenFrame key="setup">
          <main className="setup-screen">
            <button type="button">Сканировать</button>
          </main>
        </ScreenFrame>
      ) : (
        <ScreenFrame key="scan">
          <main className="scan-screen">Сканируем</main>
        </ScreenFrame>
      )}
    </div>
  );
}

describe('смена экранов — растворение (B-4)', () => {
  beforeEach(setMotionTokens);
  afterEach(() => {
    cleanup();
    unstubAnimate();
    clearMotionTokens();
  });

  it('первый экран не проявляется — переходом это не было', () => {
    const { animateFn } = stubAnimate();
    render(<Screens screen="setup" />);

    expect(animateFn).not.toHaveBeenCalled();
  });

  it('новый поверх проявляется за --duration-screen, копия прежнего — под ним, inert, и снимается', async () => {
    const { animations } = stubAnimate();
    const view = render(<Screens screen="setup" />);

    view.rerender(<Screens screen="scan" />);
    await act(flushMicrotasks);

    const app = view.container.querySelector('.app');
    const ghost = app?.querySelector('.app__leaving');
    expect(ghost?.classList.contains('setup-screen')).toBe(true);
    expect(ghost?.hasAttribute('inert')).toBe(true);
    expect(ghost?.querySelector('button')).not.toBeNull();
    const fadeIn = animations.find((it) => it.element.classList.contains('scan-screen'));
    expect(fadeIn?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(fadeIn?.options.duration).toBe(180);

    // Копия держится, пока проявляется новый, затем снимается.
    animations.find((it) => it.element === ghost)?.finish();
    expect(app?.querySelector('.app__leaving')).toBeNull();
  });

  it('новая смена во время перехода: прежний переход доводится мгновенно, двух копий нет', async () => {
    const { animations } = stubAnimate();
    const view = render(<Screens screen="setup" />);

    view.rerender(<Screens screen="scan" />);
    await act(flushMicrotasks);
    view.rerender(<Screens screen="setup" />);
    await act(flushMicrotasks);

    const ghosts = view.container.querySelectorAll('.app__leaving');
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]?.classList.contains('scan-screen')).toBe(true);
    const firstFadeIn = animations.find((it) => it.element.classList.contains('scan-screen'));
    expect(firstFadeIn?.animation.playState).toBe('finished');
  });

  it('StrictMode (dev): повторный монтаж нового экрана не отменяет переход — копия прежнего есть', async () => {
    const { animations } = stubAnimate();
    const view = render(
      <StrictMode>
        <Screens screen="setup" />
      </StrictMode>,
    );
    await act(flushMicrotasks);

    view.rerender(
      <StrictMode>
        <Screens screen="scan" />
      </StrictMode>,
    );
    await act(flushMicrotasks);

    const ghost = view.container.querySelector('.app__leaving');
    expect(ghost?.classList.contains('setup-screen')).toBe(true);
    expect(
      animations.some(
        (it) =>
          it.element.classList.contains('scan-screen') &&
          !it.element.classList.contains('app__leaving'),
      ),
    ).toBe(true);
  });

  it('StrictMode (двойной монтаж dev) копий не оставляет', async () => {
    stubAnimate();
    const view = render(
      <StrictMode>
        <Screens screen="setup" />
      </StrictMode>,
    );
    await act(flushMicrotasks);

    expect(view.container.querySelectorAll('.app__leaving')).toHaveLength(0);
    expect(view.container.querySelectorAll('main')).toHaveLength(1);
  });
});
