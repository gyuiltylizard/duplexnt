import { EMPTY_EDITS, ok, type Snapshot } from '@shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './i18n';
import { App } from './App';
import { makeSnapshot, pages, PARAMS, READY, stubApi } from './app-fixture';
import { assemblyOf } from './state/assembly-fixture';

// Посадка двустороннего набора (план M4.5, U6; KTD7; handoff M4.5, S5–S7, S10): пауза `merge` по
// набору после его оборотов и после отказа от них, текущая на первой показанной странице набора,
// один тост «добавлено N» (скрытые названы) — после модалки несовпадения, если та нужна; после
// лиц набора и после «Остановить» до первой страницы — ни паузы, ни тоста.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Pass = NonNullable<Snapshot['session']>['passes'][number];
type Session = NonNullable<Snapshot['session']>;

const pass = (number: number, kind: Pass['kind'], count: number, extra: Partial<Pass> = {}) =>
  ({
    number,
    kind,
    after: null,
    pair: null,
    backsDecision: null,
    state: 'completed',
    paramsKnown: true,
    scanner: null,
    rotate180: false,
    pages: pages(count).map((page) => ({
      ...page,
      key: `p0${String(number)}-s01-${String(page.number).padStart(4, '0')}`,
    })),
    ...extra,
  }) satisfies Pass;

/** Пары 3+3 плюс лица набора «Д1» (3 стр. после лица 2) и, если заданы, его обороты. */
function withSet(
  seq: number,
  backs: { readonly count: number; readonly state?: Pass['state'] } | null,
  decision: Pass['backsDecision'] = 'none',
  blankMode: Session['blankMode'] = 'keep',
  verdicts: ReadonlyMap<string, boolean> = new Map(),
): Snapshot {
  const session: Session = {
    blankMode,
    id: 'session.x',
    backsDeclined: false,
    saved: false,
    edits: EMPTY_EDITS,
    assembled: null,
    passes: [
      pass(1, 'fronts', 3),
      pass(2, 'backs', 3),
      pass(3, 'addedFronts', 3, { after: 'p01-s01-0002', backsDecision: decision }),
      ...(backs === null
        ? []
        : [pass(4, 'addedBacks', backs.count, { pair: 3, state: backs.state ?? 'completed' })]),
    ],
  };
  return makeSnapshot({ seq, session, assembly: assemblyOf(session, verdicts) });
}

/** Кадр `scan` оборотов набора: проход идёт, `count` страниц уже принято. */
const scanningBacks = (seq: number, count: number): Snapshot => {
  const base = withSet(seq, { count, state: 'running' });
  return {
    ...base,
    pass: {
      phase: 'scanning',
      resumed: false,
      kind: 'addedBacks',
      expected: 3,
      params: PARAMS,
      pages: count,
    },
  };
};

/** Мост со снимком, который подменяет тест: `push` — новый снимок и событие о нём. */
function liveApi(first: Snapshot, overrides: Parameters<typeof stubApi>[1] = {}) {
  let current = first;
  let notify: (payload: { seq: number }) => void = () => undefined;
  stubApi(current, {
    getSnapshot: vi.fn(() => Promise.resolve(ok(current))),
    onSnapshotChanged: vi.fn((listener: (payload: { seq: number }) => void) => {
      notify = listener;
      return () => undefined;
    }),
    keepSetBacks: vi.fn(() => Promise.resolve(ok(undefined))),
    rescanSetBacks: vi.fn(() => Promise.resolve(ok(undefined))),
    declineBacks: vi.fn(() => Promise.resolve(ok(undefined))),
    ...overrides,
  });
  return async (next: Snapshot) => {
    current = next;
    await act(async () => {
      notify({ seq: next.seq });
      await Promise.resolve();
    });
  };
}

const toastNodes = (): HTMLElement[] =>
  screen.queryAllByRole('status').filter((element) => element.classList.contains('toast'));
const toasts = (): (string | null)[] => toastNodes().map((element) => element.textContent);
const mergeStatus = (): string | null =>
  screen.queryByText('Сопоставляем проходы')?.parentElement?.querySelector('.merge-screen__status')
    ?.textContent ?? null;
const currentKey = (): string | null =>
  screen
    .getAllByRole('option')
    .find((element) => element.getAttribute('aria-selected') === 'true')
    ?.getAttribute('data-key') ?? null;

/**
 * Снимок посадки под фальшивыми таймерами: пауза `merge` ставится на них, `elapse` истекает
 * её; оценок ждать нечего (`keep`), поэтому экран уходит ровно по таймеру.
 */
async function pushLanding(
  push: (next: Snapshot) => Promise<void>,
  next: Snapshot,
  ms: number,
  between: () => void,
): Promise<void> {
  vi.useFakeTimers();
  try {
    await push(next);
    between();
    await act(async () => {
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
    });
  } finally {
    vi.useRealTimers();
  }
}

describe('M4.5: посадка пары набора (KTD7; handoff S6, S10)', () => {
  it('scan оборотов набора → editor: пауза merge по набору, затем посадка на первую страницу набора и один тост под StrictMode', async () => {
    const push = liveApi(scanningBacks(1, 2));
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(await screen.findByText('ДОБАВЛЯЕМ · ОБОРОТЫ')).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('Отсканировано 2 из 3');

    await pushLanding(push, withSet(2, { count: 3 }), 1601, () => {
      expect(mergeStatus()).toBe('набор Д1: совпало пар 3');
      expect(screen.getByText('лица набора 1→3')).toBeDefined();
      expect(screen.getByText('обороты набора 3→1')).toBeDefined();
      expect(toasts()).toEqual([]);
    });
    expect(screen.queryByText('Сопоставляем проходы')).toBeNull();
    expect(toasts()).toEqual(['Добавлено 6 стр.']);
    // Лента: 1л 1о 2л [Д1: f1 b1 f2 b2 f3 b3] 2о 3л 3о — первая страница набора на четвёртом месте.
    expect(currentKey()).toBe('p03-s01-0001');
    expect(screen.getByText('4 из 12')).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole('option', { selected: true }));
    // Следующий снимок той же сессии: тост тот же узел, второй паузы нет.
    const [node] = toastNodes();
    await push(withSet(3, { count: 3 }));
    expect(toastNodes()).toEqual([node]);
    expect(screen.queryByText('Сопоставляем проходы')).toBeNull();
  });

  it('лица набора завершены → flip набора без паузы и тоста; «Обороты не нужны» → короткая пауза и тост', async () => {
    const fronts = {
      ...withSet(1, null),
      pass: {
        phase: 'scanning' as const,
        resumed: false,
        kind: 'addedFronts' as const,
        expected: null,
        params: PARAMS,
        pages: 3,
      },
    };
    const push = liveApi(fronts);
    render(<App />);
    expect(await screen.findByText('ДОБАВЛЯЕМ · ЛИЦА')).toBeDefined();

    await push(withSet(2, null));
    const kicker = screen.getByText('ДОБАВЛЯЕМ · ЛИЦА ГОТОВЫ: 3 листа');
    expect(kicker.className).toBe('kicker kicker--added');
    expect(screen.queryByText('Сопоставляем проходы')).toBeNull();
    expect(toasts()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Обороты не нужны' }));
    expect(window.api.declineBacks).toHaveBeenCalledTimes(1);
    await pushLanding(push, withSet(3, null, 'declined'), 1201, () => {
      expect(mergeStatus()).toBe('набор Д1: обороты не нужны · страниц: 3');
      expect(screen.queryByText(/обороты набора/)).toBeNull();
    });
    expect(screen.queryByText('Сопоставляем проходы')).toBeNull();
    expect(toasts()).toEqual(['Добавлено 3 стр.']);
    expect(currentKey()).toBe('p03-s01-0001');
  });

  it('AE12: «Остановить» на лицах набора до первой страницы — ни паузы, ни тоста, последний проход прежний', async () => {
    const base = makeSnapshot({
      seq: 1,
      scanner: READY,
      session: {
        blankMode: 'keep',
        id: 'session.x',
        backsDeclined: false,
        saved: false,
        edits: EMPTY_EDITS,
        assembled: null,
        passes: [pass(1, 'fronts', 3), pass(2, 'backs', 3)],
      },
    });
    const startPass = vi.fn(() => Promise.resolve(ok({ end: 'stopped', pages: 0, error: null })));
    const push = liveApi(base, { startPass });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Добавить' }));
    expect(
      screen
        .getByRole('radio', { name: /Двустороннее сканирование/u })
        .getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Начать скан' }));
    expect(startPass).toHaveBeenCalledExactlyOnceWith({
      kind: 'addedFronts',
      after: 'p01-s01-0001',
    });

    await push({
      ...base,
      seq: 2,
      pass: {
        phase: 'starting',
        resumed: false,
        kind: 'addedFronts',
        expected: null,
        params: PARAMS,
        pages: 0,
      },
    });
    expect(screen.getByText('ДОБАВЛЯЕМ · ЛИЦА')).toBeDefined();
    await push({ ...base, seq: 3 });

    expect(screen.queryByText('Сопоставляем проходы')).toBeNull();
    expect(toasts()).toEqual([]);
    expect(screen.getByText('стр. 1 из 6')).toBeDefined();
  });

  it('AE2: обороты набора не сошлись — статус и формула набора, после паузы модалка набора; «Оставить» → kept, затем тост', async () => {
    const push = liveApi(scanningBacks(1, 2));
    render(<App />);
    expect(await screen.findByText('ДОБАВЛЯЕМ · ОБОРОТЫ')).toBeDefined();

    await pushLanding(push, withSet(2, { count: 2 }), 1601, () => {
      expect(mergeStatus()).toBe('набор Д1: не сошлось — лиц 3, оборотов 2');
      expect(
        screen.getByText(
          'Обороты набора не сошлись — лица и обороты лежат рядом, набор поправите в редакторе',
        ),
      ).toBeDefined();
      expect(document.querySelector('.merge-screen__row--document')).toBeNull();
    });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('В наборе Д1 лиц 3, оборотов 2')).toBeDefined();
    expect(within(dialog).getByText(/убрать 2 отсканированных оборота набора/)).toBeDefined();
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Оставить как есть' }),
    );
    // Тост ждёт решения.
    expect(toasts()).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Оставить как есть' }));
    expect(window.api.keepSetBacks).toHaveBeenCalledExactlyOnceWith({ set: 1 });
    await push(withSet(3, { count: 2 }, 'kept'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toasts()).toEqual(['Добавлено 5 стр.']);
    // Подблоки: лица набора, затем обороты — первая страница набора остаётся первой.
    expect(currentKey()).toBe('p03-s01-0001');
  });

  it('AE3: «Переснять обороты набора» → команда с номером набора, снимок без прохода оборотов → flip набора', async () => {
    const push = liveApi({ ...withSet(1, { count: 2 }), pass: null });
    render(<App />);

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Переснять обороты набора' }));
    expect(window.api.rescanSetBacks).toHaveBeenCalledExactlyOnceWith({ set: 1 });
    expect(within(dialog).getByRole('button', { name: 'Убираем обороты…' })).toBeDefined();

    await push(withSet(2, null));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('ДОБАВЛЯЕМ · ЛИЦА ГОТОВЫ: 3 листа')).toBeDefined();
    expect(toasts()).toEqual([]);
  });

  it('после перезапуска без решения модалка набора показывается сразу, без паузы и тоста', async () => {
    liveApi(withSet(1, { count: 2 }));
    render(<App />);

    expect(
      await screen.findByRole('dialog', { name: 'В наборе Д1 лиц 3, оборотов 2' }),
    ).toBeDefined();
    expect(screen.queryByText('Сопоставляем проходы')).toBeNull();
    expect(toasts()).toEqual([]);
  });

  it.each([
    ['решение kept', withSet(1, { count: 2 }, 'kept')],
    [
      'обороты приняты плашкой — kept ставит ядро',
      withSet(1, { count: 2, state: 'accepted' }, 'kept'),
    ],
    ['числа сошлись', withSet(1, { count: 3 })],
    ['обороты прерваны — решает плашка', withSet(1, { count: 2, state: 'interrupted' })],
  ])('модалки набора нет: %s', async (_name, snapshot) => {
    liveApi(snapshot);
    render(<App />);

    await screen.findAllByRole('option');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('AE17: скрытый пустой оборот набора — тост называет скрытых, посадка на показанную страницу', async () => {
    // Все обороты оценены: пустой — только последний оборот набора (b3, в ленте за f3).
    const verdicts = new Map<string, boolean>([
      ['p02-s01-0001', false],
      ['p02-s01-0002', false],
      ['p02-s01-0003', false],
      ['p04-s01-0001', true],
      ['p04-s01-0002', false],
      ['p04-s01-0003', false],
    ]);
    const push = liveApi({
      ...scanningBacks(1, 2),
      session: { ...scanningBacks(1, 2).session, blankMode: 'hide' } as Session,
    });
    render(<App />);
    expect(await screen.findByText('ДОБАВЛЯЕМ · ОБОРОТЫ')).toBeDefined();

    await pushLanding(push, withSet(2, { count: 3 }, 'none', 'hide', verdicts), 1601, () => {
      expect(mergeStatus()).toBe('набор Д1: совпало пар 3 · пустых оборотов: 1');
    });
    expect(toasts()).toEqual(['Добавлено 5 стр. — скрыт 1 пустой оборот']);
    expect(currentKey()).toBe('p03-s01-0001');
    expect(screen.getAllByRole('option')).toHaveLength(11);
  });
});
