import { EMPTY_EDITS, fail, ok, type Snapshot } from '@shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './i18n';
import { App } from './App';
import { makeSnapshot, pages, PARAMS, READY, stubApi } from './app-fixture';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('M3.5: посадка добавленного набора (KTD-7; handoff S9–S10)', () => {
  type Pass = NonNullable<Snapshot['session']>['passes'][number];

  const pass = (number: number, kind: Pass['kind'], count: number, extra: Partial<Pass> = {}) =>
    ({
      number,
      kind,
      after: null,
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

  /** Пары 3+3 плюс добавленный набор из `count` страниц после лица 2. */
  function withAdded(seq: number, count: number, state: Pass['state'] = 'completed'): Snapshot {
    return makeSnapshot({
      seq,
      session: {
        id: 'session.x',
        backsDeclined: false,
        saved: false,
        edits: EMPTY_EDITS,
        assembled: null,
        passes: [
          pass(1, 'fronts', 3),
          pass(2, 'backs', 3),
          ...(count === 0 ? [] : [pass(3, 'added', count, { state, after: 'p01-s01-0002' })]),
        ],
      },
    });
  }

  const scanning = (seq: number, count: number): Snapshot => {
    const base = withAdded(seq, count, 'running');
    return {
      ...base,
      pass: {
        phase: 'scanning',
        resumed: false,
        kind: 'added',
        expected: null,
        params: PARAMS,
        pages: count,
      },
    };
  };

  /** Мост со снимком, который подменяет тест: `push` — новый снимок и событие о нём. */
  function liveApi(first: Snapshot): (next: Snapshot) => Promise<void> {
    let current = first;
    let notify: (payload: { seq: number }) => void = () => undefined;
    stubApi(current, {
      getSnapshot: vi.fn(() => Promise.resolve(ok(current))),
      onSnapshotChanged: vi.fn((listener: (payload: { seq: number }) => void) => {
        notify = listener;
        return () => undefined;
      }),
    });
    return async (next) => {
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

  /**
   * Запуск из этого процесса — «Досканировать остаток» прерванного набора из одной страницы:
   * App помнит страницы до него. Возвращает `push` для следующих снимков.
   */
  async function launchedFromInterrupted(strict = false) {
    const push = liveApi({ ...withAdded(1, 1, 'interrupted'), canResume: true, canAccept: true });
    const app = <App />;
    render(strict ? <StrictMode>{app}</StrictMode> : app);
    fireEvent.click(await screen.findByRole('button', { name: 'Досканировать остаток' }));
    return push;
  }

  const currentKey = (): string | null =>
    screen
      .getAllByRole('option')
      .find((element) => element.getAttribute('aria-selected') === 'true')
      ?.getAttribute('data-key') ?? null;

  it('scan → editor после добавленного прохода: без паузы merge, тост один раз под StrictMode, текущая — первая добавленная и в фокусе', async () => {
    const push = await launchedFromInterrupted(true);

    await push(scanning(2, 2));
    expect(screen.getByText('ДОБАВЛЯЕМ СТРАНИЦЫ')).toBeDefined();

    await push(withAdded(3, 3));
    expect(screen.queryByText('Сопоставляем проходы')).toBeNull();
    expect(toasts()).toEqual(['Добавлено 2 стр.']);
    // Лента: 1л 1о 2л Д1.1 Д1.2 Д1.3 2о 3л 3о — первая новая страница на пятом месте.
    expect(currentKey()).toBe('p03-s01-0002');
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(1);
    expect(screen.getByText('5 из 9')).toBeDefined();
    // Фокус на первой добавленной: `focus()` и прокручивает к ней (S9), и даёт точку входа
    // клавиатуры.
    expect(document.activeElement).toBe(screen.getByRole('option', { selected: true }));
    // Пришёл ещё снимок той же сессии — тост тот же узел: не перезапущен (ключ по запуску).
    const [node] = toastNodes();
    await push(withAdded(4, 3));
    expect(toastNodes()).toEqual([node]);
  });

  it('ответ startPass раньше снимка: посадка по снимку всё равно состоится (KTD-7)', async () => {
    let answer: (result: unknown) => void = () => undefined;
    const startPass = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const push = liveApi({ ...withAdded(1, 1, 'interrupted'), canResume: true, canAccept: true });
    vi.mocked(window.api.startPass).mockImplementation(startPass as never);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Досканировать остаток' }));

    // Ответ пришёл, а снимок хранилище ещё дотягивает.
    await act(async () => {
      answer(ok({ end: 'completed', pages: 2, error: null }));
      await Promise.resolve();
    });
    expect(toasts()).toEqual([]);

    await push(withAdded(2, 3));
    expect(toasts()).toEqual(['Добавлено 2 стр.']);
    expect(currentKey()).toBe('p03-s01-0002');
  });

  it('«Остановить» до первой страницы добавленного набора — ни тоста, ни плашки, editor прежний', async () => {
    const startPass = vi.fn(() => Promise.resolve(ok({ end: 'stopped', pages: 0, error: null })));
    stubApi({ ...withAdded(1, 0), scanner: READY }, { startPass });
    render(<App />);

    fireEvent.click(await screen.findByRole('option', { name: /Страница 3/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    fireEvent.click(screen.getByRole('button', { name: 'Начать скан' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(toasts()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('стр. 3 из 6')).toBeDefined();
  });

  it('повторное «Начать скан» до ответа ядра запуск не дублирует', async () => {
    const startPass = vi.fn(() => new Promise(() => undefined));
    stubApi({ ...withAdded(1, 0), scanner: READY }, { startPass });
    render(<App />);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.click(await screen.findByRole('button', { name: 'Добавить' }));
      fireEvent.click(screen.getByRole('button', { name: 'Начать скан' }));
    }
    expect(startPass).toHaveBeenCalledTimes(1);
  });

  it('добавленный проход без страниц после кадра scan: паузы merge нет, редактор как был', async () => {
    // Ядро выбросило пустой проход: последним снова стал проход оборотов, но пауза —
    // по намерению запуска (R15), не по роли последнего прохода.
    const startPass = vi.fn(() => Promise.resolve(fail('scanNoPaper')));
    const push = liveApi({ ...withAdded(1, 0), scanner: READY });
    vi.mocked(window.api.startPass).mockImplementation(startPass);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Добавить' }));
    fireEvent.click(screen.getByRole('button', { name: 'Начать скан' }));

    await push({
      ...withAdded(2, 0),
      scanner: READY,
      pass: {
        phase: 'starting',
        resumed: false,
        kind: 'added',
        expected: null,
        params: PARAMS,
        pages: 0,
      },
    });
    expect(screen.getByText('ДОБАВЛЯЕМ СТРАНИЦЫ')).toBeDefined();
    await push({ ...withAdded(3, 0), scanner: READY });

    expect(screen.queryByText('Сопоставляем проходы')).toBeNull();
    expect(screen.getByText('стр. 1 из 6')).toBeDefined();
    expect(toasts()).toEqual([
      'Не удалось начать: в лотке нет бумаги. Положите листы в автоподатчик и запустите ещё раз.',
    ]);
  });

  it('после прохода оборотов пауза merge остаётся (регресс)', async () => {
    const backs = {
      ...withAdded(1, 0),
      pass: {
        phase: 'scanning' as const,
        resumed: false,
        kind: 'backs' as const,
        expected: 3,
        params: PARAMS,
        pages: 3,
      },
    };
    const push = liveApi(backs);
    render(<App />);
    expect(await screen.findByText('ПРОХОД 2 · ОБОРОТЫ')).toBeDefined();

    vi.useFakeTimers();
    try {
      await push(withAdded(2, 0));
      expect(screen.getByText('Сопоставляем проходы')).toBeDefined();
      act(() => {
        vi.advanceTimersByTime(1601);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByText('стр. 1 из 6')).toBeDefined();
  });

  it('кадры scan пропущены: editor → editor с выросшей лентой после запуска — тост, не пауза', async () => {
    const push = await launchedFromInterrupted();

    await push(withAdded(2, 3));
    expect(screen.queryByText('Сопоставляем проходы')).toBeNull();
    expect(toasts()).toEqual(['Добавлено 2 стр.']);
    expect(currentKey()).toBe('p03-s01-0002');
  });

  it('обрыв добавленного прохода: плашка S4, тоста нет', async () => {
    const push = await launchedFromInterrupted();

    await push({ ...withAdded(2, 2, 'interrupted'), canResume: true, canAccept: true });
    expect(screen.getByText('Добавление прервалось после страницы 2')).toBeDefined();
    expect(toasts()).toEqual([]);
    // Лента прежняя — текущая первая, как при обычном монтировании.
    expect(currentKey()).toBe('p01-s01-0001');
  });

  it.each([
    ['отказ до старта (лоток пуст)', fail('scanNoPaper'), /в лотке нет бумаги/],
    [
      'обрыв до первой страницы при живой сессии',
      ok({ end: 'interrupted' as const, pages: 0, error: { code: 'scanFeedFailed' as const } }),
      /сканер прервал подачу бумаги/,
    ],
  ])(
    'отказ запуска из add — %s — тост 6 с, плашки нет, editor прежний',
    async (_name, result, reason) => {
      const startPass = vi.fn(() => Promise.resolve(result));
      stubApi({ ...withAdded(1, 0), scanner: READY }, { startPass });
      render(<App />);

      // Текущая — третья: якорь и выделение после отказа должны остаться её.
      fireEvent.click(await screen.findByRole('option', { name: /Страница 3/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
      fireEvent.click(screen.getByRole('button', { name: 'Начать скан' }));
      expect(startPass).toHaveBeenCalledExactlyOnceWith({ kind: 'added', after: 'p01-s01-0002' });

      const toast = await screen.findByText(/^Не удалось начать: /);
      expect(toast.parentElement?.classList.contains('toast')).toBe(true);
      expect(toast.textContent).toMatch(reason);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByText('стр. 3 из 6')).toBeDefined();
    },
  );

  it('mismatch при добавленном наборе показывается и после перезапуска: режим активен (M3.6, R20)', async () => {
    const session = withAdded(1, 1).session;
    stubApi(
      makeSnapshot({
        session: session && {
          ...session,
          passes: [pass(1, 'fronts', 3), pass(2, 'backs', 2), pass(3, 'added', 1)],
        },
      }),
    );
    render(<App />);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('В первом проходе 3 листа, во втором — 2')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Понятно' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('стр. 1 из 6')).toBeDefined();
  });
});
