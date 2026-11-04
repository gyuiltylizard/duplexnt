import { EMPTY_EDITS, ok, type PassSnapshot, type SessionSnapshot } from '@shared';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './i18n';
import { App } from './App';
import { makeSnapshot, pages, PARAMS, stubApi } from './app-fixture';
import { assemblyOf } from './state/assembly-fixture';

// Каркас приложения, M4 (KTD6; handoff M4, S12; решение автора 2026-10-22): после паузы `merge`
// экран держится, пока идут оценки пустых оборотов, — без потолка; статус говорит, что ищем.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BACKS = pages(3, 1).map((page) => ({ ...page, key: `p02-s01-000${String(page.number)}` }));

function pass(overrides: Partial<PassSnapshot>): PassSnapshot {
  return {
    number: 1,
    state: 'completed',
    paramsKnown: true,
    scanner: null,
    kind: 'fronts',
    after: null,
    pair: null,
    backsDecision: null,
    rotate180: false,
    pages: pages(3),
    ...overrides,
  };
}

function session(backsState: PassSnapshot['state']): SessionSnapshot {
  return {
    id: 'session.x',
    backsDeclined: false,
    saved: false,
    edits: EMPTY_EDITS,
    assembled: null,
    blankMode: 'hide',
    straighten: 'off',
    passes: [pass({}), pass({ number: 2, kind: 'backs', state: backsState, pages: BACKS })],
  };
}

describe('ожидание оценок пустых оборотов на merge (M4)', () => {
  it('S12: после паузы экран держится, пока pending > 0; снимок с оценками отпускает его', async () => {
    const scanning = makeSnapshot({
      pass: {
        phase: 'scanning',
        resumed: false,
        kind: 'backs',
        expected: 3,
        params: PARAMS,
        pages: 3,
      },
      session: session('running'),
    });
    // Проход завершён, оценён пока один оборот из трёх.
    const done = session('completed');
    const pending = makeSnapshot({
      seq: 2,
      session: done,
      assembly: assemblyOf(done, new Map([['p02-s01-0001', false]])),
    });
    const scored = makeSnapshot({
      seq: 3,
      session: done,
      assembly: assemblyOf(
        done,
        new Map([
          ['p02-s01-0001', false],
          ['p02-s01-0002', true],
          ['p02-s01-0003', false],
        ]),
      ),
    });
    let current = scanning;
    let notify: (payload: { seq: number }) => void = () => undefined;
    stubApi(scanning, {
      getSnapshot: vi.fn(() => Promise.resolve(ok(current))),
      onSnapshotChanged: vi.fn((listener: (payload: { seq: number }) => void) => {
        notify = listener;
        return () => undefined;
      }),
    });
    render(<App />);
    expect((await screen.findByRole('status')).textContent).toBe('Отсканировано 3 из 3');

    vi.useFakeTimers();
    try {
      current = pending;
      await act(async () => {
        notify({ seq: 2 });
        await Promise.resolve();
      });
      expect(document.querySelector('.merge-screen')).not.toBeNull();
      expect(document.querySelector('.merge-screen__status')?.textContent).toBe(
        'совпало пар: 3 · ищем пустые обороты…',
      );

      // Пауза истекла, оценки ещё идут — экран остаётся, сколько бы ни прошло.
      act(() => {
        vi.advanceTimersByTime(1601);
      });
      expect(document.querySelector('.merge-screen')).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(document.querySelector('.merge-screen')).not.toBeNull();

      current = scored;
      await act(async () => {
        notify({ seq: 3 });
        await Promise.resolve();
      });
      expect(document.querySelector('.merge-screen')).toBeNull();
      // Редактор открылся сразу с правильной лентой: один оборот скрыт, тоста поздних нет.
      expect(screen.getByText('1 из 5')).toBeDefined();
      expect(screen.queryByText(/переключатель «Пустые» покажет/u)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('S12: оценки готовы к концу паузы — экран уходит по таймеру со статусом о пустых', async () => {
    const scanning = makeSnapshot({
      pass: {
        phase: 'scanning',
        resumed: false,
        kind: 'backs',
        expected: 3,
        params: PARAMS,
        pages: 3,
      },
      session: session('running'),
    });
    const done = session('completed');
    const scored = makeSnapshot({
      seq: 2,
      session: done,
      assembly: assemblyOf(
        done,
        new Map([
          ['p02-s01-0001', true],
          ['p02-s01-0002', true],
          ['p02-s01-0003', false],
        ]),
      ),
    });
    let current = scanning;
    let notify: (payload: { seq: number }) => void = () => undefined;
    stubApi(scanning, {
      getSnapshot: vi.fn(() => Promise.resolve(ok(current))),
      onSnapshotChanged: vi.fn((listener: (payload: { seq: number }) => void) => {
        notify = listener;
        return () => undefined;
      }),
    });
    render(<App />);
    await screen.findByRole('status');

    vi.useFakeTimers();
    try {
      current = scored;
      await act(async () => {
        notify({ seq: 2 });
        await Promise.resolve();
      });
      expect(document.querySelector('.merge-screen__status')?.textContent).toBe(
        'совпало пар: 3 · пустых оборотов: 2',
      );
      act(() => {
        vi.advanceTimersByTime(1601);
      });
      expect(document.querySelector('.merge-screen')).toBeNull();
      expect(screen.getByText('1 из 4')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
