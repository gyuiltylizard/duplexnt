import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { animate, durationOf, easingOf, fadeOut, ghostOf, leaveWithGhost } from './motion';
import { flushMicrotasks as flush, stubAnimate, unstubAnimate } from './motion-fixture';

describe('основа движения (B-4)', () => {
  beforeEach(() => {
    document.documentElement.style.setProperty('--duration-exit', '120ms');
    document.documentElement.style.setProperty('--duration-screen', '0.18s');
    document.documentElement.style.setProperty('--ease-out', 'cubic-bezier(0.2, 0, 0, 1)');
  });

  afterEach(() => {
    document.documentElement.removeAttribute('style');
    document.body.replaceChildren();
    unstubAnimate();
  });

  it('длительности и кривые — из токенов; токена нет — 0, то есть без анимации', () => {
    expect(durationOf('--duration-exit')).toBe(120);
    expect(durationOf('--duration-screen')).toBe(180);
    expect(durationOf('--duration-turn')).toBe(0);
    expect(easingOf('--ease-out')).toBe('cubic-bezier(0.2, 0, 0, 1)');
  });

  it('без WAAPI (jsdom) и при нулевой длительности анимации нет — интерфейс как без движения', () => {
    const element = document.createElement('div');
    expect(animate(element, [{ opacity: 0 }, { opacity: 1 }], { duration: 180 })).toBeNull();

    const { animateFn } = stubAnimate();
    expect(animate(element, [{ opacity: 0 }, { opacity: 1 }], { duration: 0 })).toBeNull();
    expect(animateFn).not.toHaveBeenCalled();
  });

  it('копия уходящего узла: inert, скрыта от вспомогательных технологий, без id', () => {
    const node = document.createElement('section');
    node.id = 'dialog';
    node.innerHTML = '<h2 id="title">Заголовок</h2><button>Ок</button>';

    const ghost = ghostOf(node);

    expect(ghost.hasAttribute('inert')).toBe(true);
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.querySelectorAll('[id]')).toHaveLength(0);
    expect(ghost.id).toBe('');
    expect(node.id).toBe('dialog');
  });

  it('уход: копия встаёт на место снятого узла, гаснет и снимается по концу анимации', async () => {
    const { animations } = stubAnimate();
    const parent = document.createElement('div');
    const node = document.createElement('div');
    node.className = 'toast';
    const after = document.createElement('span');
    parent.append(node, after);
    document.body.append(parent);

    leaveWithGhost(node, fadeOut);
    node.remove(); // React снимает узел в том же коммите
    await flush();

    const ghost = parent.querySelector('.toast');
    expect(ghost).not.toBeNull();
    expect(ghost?.nextSibling).toBe(after);
    expect(animations.at(-1)?.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    animations.at(-1)?.finish();
    expect(parent.querySelector('.toast')).toBeNull();
  });

  it('узел остался на месте (повторный монтаж StrictMode) — копии нет', async () => {
    stubAnimate();
    const parent = document.createElement('div');
    const node = document.createElement('div');
    parent.append(node);
    document.body.append(parent);

    leaveWithGhost(node, fadeOut);
    await flush();

    expect(parent.children).toHaveLength(1);
  });

  it('отмена ухода — копия не вставляется (замена модалки забирает уход себе)', async () => {
    stubAnimate();
    const parent = document.createElement('div');
    const node = document.createElement('div');
    parent.append(node);
    document.body.append(parent);

    const cancel = leaveWithGhost(node, fadeOut);
    node.remove();
    cancel();
    await flush();

    expect(parent.children).toHaveLength(0);
  });

  it('копия в другое место: экран уходит вместе с обёрткой — копия ложится в контейнер', async () => {
    stubAnimate();
    const app = document.createElement('div');
    const wrapper = document.createElement('div');
    const screen = document.createElement('main');
    wrapper.append(screen);
    app.append(wrapper);
    document.body.append(app);

    leaveWithGhost(screen, (ghost) => animate(ghost, [{}, {}], { duration: 180 }), {
      parent: app,
      next: app.firstChild,
    });
    wrapper.remove();
    await flush();

    expect(app.firstElementChild?.tagName).toBe('MAIN');
    expect(app.firstElementChild?.hasAttribute('inert')).toBe(true);
  });
});
