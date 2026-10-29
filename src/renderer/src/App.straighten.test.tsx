import {
  EMPTY_EDITS,
  ok,
  type PassSnapshot,
  type SessionSnapshot,
  type StraightenFacts,
} from '@shared';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './i18n';
import { App } from './App';
import { makeSnapshot, pages, PARAMS, stubApi } from './app-fixture';
import { assemblyOf } from './state/assembly-fixture';

// Каркас приложения, M6 (handoff M6, `merge`): после паузы `merge` экран держится, пока идёт
// выравнивание, — без потолка, как с оценками пустых; хвост статуса меняется на итог, и экран
// держится ещё немного, чтобы итог успели прочесть; затем `editor`.

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
    blankMode: 'keep',
    straighten: 'auto',
    passes: [pass({}), pass({ number: 2, kind: 'backs', state: backsState, pages: BACKS })],
  };
}

const LEVEL = { outcome: 'level', version: null, deferred: null } as const;
const STRAIGHT = { outcome: 'willStraighten', version: 1, deferred: null } as const;
const PENDING = { outcome: null, version: null, deferred: null } as const;

/** Все шесть страниц с фактами: лица по `fronts`, обороты ровные. */
const factsOf = (fronts: readonly (typeof LEVEL | typeof STRAIGHT | typeof PENDING)[]) =>
  new Map<string, typeof LEVEL | typeof STRAIGHT | typeof PENDING>([
    ...fronts.map((fact, index) => [`p01-s01-000${String(index + 1)}`, fact] as const),
    ...BACKS.map((page) => [page.key, LEVEL] as const),
  ]) satisfies StraightenFacts;

function setup(frames: { readonly pending: StraightenFacts; readonly done: StraightenFacts }) {
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
  const completed = session('completed');
  const pending = makeSnapshot({
    seq: 2,
    session: completed,
    assembly: assemblyOf(completed, undefined, frames.pending),
  });
  const done = makeSnapshot({
    seq: 3,
    session: completed,
    assembly: assemblyOf(completed, undefined, frames.done),
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
  const deliver = async (snapshot: typeof pending): Promise<void> => {
    current = snapshot;
    await act(async () => {
      notify({ seq: snapshot.seq });
      await Promise.resolve();
    });
  };
  return { pending, done, deliver };
}

const mergeStatus = (): string | null | undefined =>
  document.querySelector('.merge-screen__status')?.textContent;

describe('ожидание выравнивания на merge (M6)', () => {
  it('после паузы экран держится, пока идёт обработка; итог показывается ещё 500 мс, затем editor', async () => {
    const { pending, done, deliver } = setup({
      pending: factsOf([STRAIGHT, PENDING, PENDING]),
      done: factsOf([STRAIGHT, STRAIGHT, LEVEL]),
    });
    render(<App />);
    expect((await screen.findByRole('status')).textContent).toBe('Отсканировано 3 из 3');

    vi.useFakeTimers();
    try {
      await deliver(pending);
      expect(mergeStatus()).toBe('совпало пар: 3 · выравнивание: ещё 2 стр.');

      act(() => {
        vi.advanceTimersByTime(1601);
      });
      expect(document.querySelector('.merge-screen')).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(document.querySelector('.merge-screen')).not.toBeNull();

      await deliver(done);
      expect(mergeStatus()).toBe('совпало пар: 3 · выровнено: 2 стр.');
      act(() => {
        vi.advanceTimersByTime(499);
      });
      expect(document.querySelector('.merge-screen')).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(document.querySelector('.merge-screen')).toBeNull();
      // Редактор открылся с готовыми статусами — тоста поздних нет.
      expect(screen.getByText('стр. 1 из 6')).toBeDefined();
      expect(screen.queryByText(/Выровнено ещё/u)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('обработка закончена к концу паузы — экран уходит по таймеру с итогом, без добавки', async () => {
    const { done, deliver } = setup({
      pending: factsOf([LEVEL, LEVEL, LEVEL]),
      done: factsOf([STRAIGHT, LEVEL, LEVEL]),
    });
    render(<App />);
    await screen.findByRole('status');

    vi.useFakeTimers();
    try {
      await deliver(done);
      expect(mergeStatus()).toBe('совпало пар: 3 · выровнено: 1 стр.');
      act(() => {
        vi.advanceTimersByTime(1601);
      });
      expect(document.querySelector('.merge-screen')).toBeNull();
      expect(screen.getByText('стр. 1 из 6')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
