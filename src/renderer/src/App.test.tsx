import { EMPTY_EDITS, fail, ok } from '@shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './i18n';
import { App } from './App';
import { FOUND, makeSnapshot, pages, PARAMS, READY, stubApi } from './app-fixture';
import { NO_EDITS_ASSEMBLY } from './state/assembly-fixture';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('каркас приложения', () => {
  it('нет сессии — окно открывается на setup', async () => {
    stubApi(makeSnapshot({}));
    render(<App />);

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Сканируем обе стороны в два прохода',
    );
  });

  it('идущий проход — экран scan со счётчиком принятых страниц', async () => {
    stubApi(
      makeSnapshot({
        pass: {
          phase: 'scanning',
          resumed: false,
          kind: 'fronts',
          expected: null,
          params: PARAMS,
          pages: 7,
        },
        session: {
          blankMode: 'keep',
          straighten: 'off',
          id: 'session.x',
          backsDeclined: false,
          saved: false,
          edits: EMPTY_EDITS,
          assembled: null,
          passes: [
            {
              number: 1,
              state: 'running',
              paramsKnown: true,
              scanner: null,
              kind: 'fronts',
              after: null,
              pair: null,
              backsDecision: null,
              rotate180: false,
              pages: pages(7),
            },
          ],
        },
      }),
    );
    render(<App />);

    expect((await screen.findByRole('status')).textContent).toBe('Отсканировано 7');
    expect(screen.getByText('СКАНИРУЕМ ЛИЦЕВЫЕ СТОРОНЫ')).toBeDefined();
  });

  it('завершённый лицевой проход без оборотов — flip с запуском второго прохода', async () => {
    const startPass = vi.fn(() => new Promise(() => undefined));
    stubApi(
      makeSnapshot({
        session: {
          blankMode: 'keep',
          straighten: 'off',
          id: 'session.x',
          backsDeclined: false,
          saved: false,
          edits: EMPTY_EDITS,
          assembled: null,
          passes: [
            {
              number: 1,
              state: 'completed',
              paramsKnown: true,
              scanner: null,
              kind: 'fronts',
              after: null,
              pair: null,
              backsDecision: null,
              rotate180: false,
              pages: pages(12),
            },
          ],
        },
        assembly: {
          ...NO_EDITS_ASSEMBLY,
          report: {
            mode: 'pairs',
            groups: null,
            sets: [],
            pendingSet: null,
            fronts: 12,
            backs: 0,
            backsState: null,
            backsDeclined: false,
            mismatch: false,
          },
        },
      }),
      { startPass },
    );
    render(<App />);

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Разверните листы на 180° — все разом',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Листы в лотке — сканировать обороты' }));
    expect(startPass).toHaveBeenCalledTimes(1);
  });

  it('сессия со страницами без прохода — editor с позицией в наборе', async () => {
    stubApi(
      makeSnapshot({
        session: {
          blankMode: 'keep',
          straighten: 'off',
          id: 'session.x',
          backsDeclined: false,
          saved: false,
          edits: EMPTY_EDITS,
          assembled: null,
          passes: [
            {
              number: 1,
              state: 'interrupted',
              paramsKnown: true,
              scanner: null,
              kind: 'fronts',
              after: null,
              pair: null,
              backsDecision: null,
              rotate180: false,
              pages: pages(5),
            },
          ],
        },
      }),
    );
    render(<App />);

    expect(await screen.findByText('1 из 5')).toBeDefined();
  });

  it('M3: правка в StrictMode — одна подписка на сочетания, Delete шлёт один setEdits', async () => {
    const setEdits = vi.fn(() => Promise.resolve(ok({ seq: 2 })));
    stubApi(
      makeSnapshot({
        session: {
          blankMode: 'keep',
          straighten: 'off',
          id: 'session.x',
          backsDeclined: true,
          saved: false,
          edits: EMPTY_EDITS,
          assembled: null,
          passes: [
            {
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
            },
          ],
        },
        // Односторонний набор после «Обороты не нужны» — сразу editor.
      }),
      { setEdits },
    );
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await screen.findByText('1 из 3');

    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: { ...EMPTY_EDITS, deleted: ['p01-s01-0001'] },
      rotate180: {},
    });
  });

  it('несовместимые данные — свой экран вместо любого другого', async () => {
    stubApi(makeSnapshot({ storage: { incompatible: true, unsaved: false } }));
    render(<App />);

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Эти сканы сохранила более новая версия приложения',
    );
    expect(screen.queryByText('Сканируем обе стороны в два прохода')).toBeNull();
  });

  it('StrictMode (двойное монтирование dev) не оставляет окно пустым', async () => {
    stubApi(makeSnapshot({}));
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Сканируем обе стороны в два прохода',
    );
  });

  it('размонтирование отписывает от события снимка', async () => {
    const { unsubscribe } = stubApi(makeSnapshot({}));
    const view = render(<App />);
    await screen.findByRole('heading', { level: 1 });

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('уведомление запуска показывается плашкой и закрывается «Понятно»', async () => {
    stubApi(makeSnapshot({ notices: ['journalRebuilt'] }));
    render(<App />);

    expect(await screen.findByText(/восстановлен по файлам/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Понятно' }));
    expect(screen.queryByText(/восстановлен по файлам/)).toBeNull();
  });

  it('pagesLost без потерянных страниц в ленте не показывается', async () => {
    stubApi(makeSnapshot({ notices: ['pagesLost'] }));
    render(<App />);

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/не нашлось файлов/)).toBeNull();
  });

  it('отказ запуска до первой страницы возвращается плашкой на setup', async () => {
    stubApi(makeSnapshot({ scanner: READY }), {
      startPass: vi.fn(() => Promise.resolve(fail('scanNoPaper'))),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Сканировать лицевые стороны' }));
    expect((await screen.findByRole('alert')).textContent).toContain('В лотке нет бумаги');
  });

  it('после отказа запуск доступен снова, плашка снимается следующим нажатием', async () => {
    const startPass = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(fail('scanNoPaper')))
      .mockImplementation(() => new Promise(() => undefined));
    stubApi(makeSnapshot({ scanner: READY }), { startPass });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Сканировать лицевые стороны' }));
    expect((await screen.findByRole('alert')).textContent).toContain('В лотке нет бумаги');

    fireEvent.click(screen.getByRole('button', { name: 'Сканировать лицевые стороны' }));
    expect(startPass).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('S15: отказ закрытия сегмента после «Остановить» — тостом', async () => {
    stubApi(
      makeSnapshot({
        pass: {
          phase: 'scanning',
          resumed: false,
          kind: 'fronts',
          expected: null,
          params: PARAMS,
          pages: 2,
        },
        session: {
          blankMode: 'keep',
          straighten: 'off',
          id: 'session.x',
          backsDeclined: false,
          saved: false,
          edits: EMPTY_EDITS,
          assembled: null,
          passes: [
            {
              number: 1,
              state: 'running',
              paramsKnown: true,
              scanner: null,
              kind: 'fronts',
              after: null,
              pair: null,
              backsDecision: null,
              rotate180: false,
              pages: pages(2),
            },
          ],
        },
      }),
      { stopPass: vi.fn(() => Promise.resolve(fail('sessionCloseFailed'))) },
    );
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Остановить' }));
    expect((await screen.findByText(/Не удалось убрать страницы/)).textContent).toContain(
      'Проход прерван',
    );
  });

  it('другой отказ «Остановить» — общий тост с причиной (B-17)', async () => {
    stubApi(
      makeSnapshot({
        pass: {
          phase: 'scanning',
          resumed: false,
          kind: 'fronts',
          expected: null,
          params: PARAMS,
          pages: 2,
        },
        session: {
          blankMode: 'keep',
          straighten: 'off',
          id: 'session.x',
          backsDeclined: false,
          saved: false,
          edits: EMPTY_EDITS,
          assembled: null,
          passes: [
            {
              number: 1,
              state: 'running',
              paramsKnown: true,
              scanner: null,
              kind: 'fronts',
              after: null,
              pair: null,
              backsDecision: null,
              rotate180: false,
              pages: pages(2),
            },
          ],
        },
      }),
      {
        stopPass: vi.fn(() =>
          Promise.resolve(fail('sessionConflict', { reason: 'noRunningPass' })),
        ),
      },
    );
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Остановить' }));
    expect((await screen.findByText(/Не удалось остановить/)).textContent).not.toContain(
      'Проход прерван',
    );
  });

  it('pagesLost с потерянной страницей в ленте — плашка видна', async () => {
    stubApi(
      makeSnapshot({
        notices: ['pagesLost'],
        session: {
          blankMode: 'keep',
          straighten: 'off',
          id: 'session.x',
          backsDeclined: false,
          saved: false,
          edits: EMPTY_EDITS,
          assembled: null,
          passes: [
            {
              number: 1,
              state: 'completed',
              paramsKnown: true,
              scanner: null,
              kind: 'fronts',
              after: null,
              pair: null,
              backsDecision: null,
              rotate180: false,
              pages: [
                { key: 'p01-s01-0001', number: 1, lost: false },
                { key: 'p01-s01-0002', number: 2, lost: true },
              ],
            },
          ],
        },
      }),
    );
    render(<App />);

    expect(await screen.findByText(/не нашлось файлов/)).toBeDefined();
  });

  it('отказ досканирования не переезжает плашкой на setup после «Нового сканирования»', async () => {
    const interrupted = makeSnapshot({
      scanner: READY,
      canResume: true,
      canAccept: true,
      session: {
        blankMode: 'keep',
        straighten: 'off',
        id: 'session.x',
        backsDeclined: false,
        saved: false,
        edits: EMPTY_EDITS,
        assembled: null,
        passes: [
          {
            number: 1,
            state: 'interrupted',
            paramsKnown: true,
            scanner: null,
            kind: 'fronts',
            after: null,
            pair: null,
            backsDecision: null,
            rotate180: false,
            pages: pages(3),
          },
        ],
      },
    });
    let current = interrupted;
    let notify: (payload: { seq: number }) => void = () => undefined;
    stubApi(interrupted, {
      getSnapshot: vi.fn(() => Promise.resolve(ok(current))),
      onSnapshotChanged: vi.fn((listener: (payload: { seq: number }) => void) => {
        notify = listener;
        return () => undefined;
      }),
      startPass: vi.fn(() => Promise.resolve(fail('scanNoPaper'))),
      closeSession: vi.fn(() => Promise.resolve(ok(undefined))),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Досканировать остаток' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Досканировать не удалось');

    const banner = screen.getByRole('region', { name: /Проход прервался/ });
    fireEvent.click(within(banner).getByRole('button', { name: 'Новый скан' }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Закрыть текущий и начать новое сканирование/ }),
    );

    // Сессия закрыта — приходит снимок без неё, экран уходит на `setup`.
    current = makeSnapshot({ seq: 2, scanner: READY });
    act(() => {
      notify({ seq: 2 });
    });

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Сканируем обе стороны в два прохода',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/В лотке нет бумаги/)).toBeNull();
  });

  it('после закрытия device, открытой из плашки отказа, фокус не теряется', async () => {
    stubApi(makeSnapshot({ scanner: READY }), {
      startPass: vi.fn(() => Promise.resolve(fail('scannerCertificateChanged'))),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Сканировать лицевые стороны' }));
    const reopen = await screen.findByRole('button', { name: 'Подключить заново' });
    reopen.focus();
    fireEvent.click(reopen);
    expect(await screen.findByRole('dialog')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Кнопка-опенер исчезла вместе с плашкой — фокус ушёл на первый элемент экрана, не на body.
    expect(document.activeElement).not.toBe(document.body);
  });

  it('двойной клик по запуску шлёт команду один раз', async () => {
    const startPass = vi.fn(() => new Promise(() => undefined));
    stubApi(makeSnapshot({ scanner: READY }), { startPass });
    render(<App />);

    const start = await screen.findByRole('button', { name: 'Сканировать лицевые стороны' });
    fireEvent.click(start);
    fireEvent.click(start);

    expect(startPass).toHaveBeenCalledTimes(1);
  });

  it('отказ досканирования возвращается строкой в плашку S17; ссылка открывает device', async () => {
    stubApi(
      makeSnapshot({
        scanner: READY,
        canResume: true,
        canAccept: true,
        session: {
          blankMode: 'keep',
          straighten: 'off',
          id: 'session.x',
          backsDeclined: false,
          saved: false,
          edits: EMPTY_EDITS,
          assembled: null,
          passes: [
            {
              number: 1,
              state: 'interrupted',
              paramsKnown: true,
              scanner: null,
              kind: 'fronts',
              after: null,
              pair: null,
              backsDecision: null,
              rotate180: false,
              pages: pages(3),
            },
          ],
        },
      }),
      { startPass: vi.fn(() => Promise.resolve(fail('scannerUnreachable'))) },
    );
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Досканировать остаток' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Досканировать не удалось');

    fireEvent.click(screen.getByRole('button', { name: 'подключите заново' }));
    expect(await screen.findByRole('dialog')).toBeDefined();
    // Открытие модалки снимает строку отказа.
    expect(screen.queryByText(/Досканировать не удалось/)).toBeNull();
  });

  it('KTD-5: пауза merge после прохода оборотов переживает StrictMode и уходит сама', async () => {
    const scanning = makeSnapshot({
      pass: {
        phase: 'scanning',
        resumed: false,
        kind: 'backs',
        expected: 3,
        params: PARAMS,
        pages: 3,
      },
      session: {
        blankMode: 'keep',
        straighten: 'off',
        id: 'session.x',
        backsDeclined: false,
        saved: false,
        edits: EMPTY_EDITS,
        assembled: null,
        passes: [
          {
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
          },
          {
            number: 2,
            state: 'running',
            paramsKnown: true,
            scanner: null,
            kind: 'backs',
            after: null,
            pair: null,
            backsDecision: null,
            rotate180: false,
            pages: pages(3, 1).map((page) => ({ ...page, key: `p02-s01-000${page.number}` })),
          },
        ],
      },
    });
    const done = makeSnapshot({
      seq: 2,
      session: {
        blankMode: 'keep',
        straighten: 'off',
        id: 'session.x',
        backsDeclined: false,
        saved: false,
        edits: EMPTY_EDITS,
        assembled: null,
        passes: [
          {
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
          },
          {
            number: 2,
            state: 'completed',
            paramsKnown: true,
            scanner: null,
            kind: 'backs',
            after: null,
            pair: null,
            backsDecision: null,
            rotate180: false,
            pages: pages(3, 1).map((page) => ({ ...page, key: `p02-s01-000${page.number}` })),
          },
        ],
      },
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
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect((await screen.findByRole('status')).textContent).toBe('Отсканировано 3 из 3');

    vi.useFakeTimers();
    try {
      current = done;
      await act(async () => {
        notify({ seq: 2 });
        // Снимок приходит микротаском — дождаться его, не трогая фейковые таймеры.
        await Promise.resolve();
      });
      // Пауза `merge`: без органов управления, статус — фактический результат.
      expect(document.querySelector('.merge-screen')).not.toBeNull();
      expect(screen.getByText('совпало пар: 3')).toBeDefined();

      act(() => {
        vi.advanceTimersByTime(1599);
      });
      expect(document.querySelector('.merge-screen')).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(document.querySelector('.merge-screen')).toBeNull();
      expect(screen.getByText('1 из 6')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('B-5: «Обороты не нужны» — без паузы merge, сразу editor только с лицевыми', async () => {
    const flip = makeSnapshot({
      session: {
        blankMode: 'keep',
        straighten: 'off',
        id: 'session.x',
        backsDeclined: false,
        saved: false,
        edits: EMPTY_EDITS,
        assembled: null,
        passes: [
          {
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
          },
        ],
      },
    });
    const declined = makeSnapshot({
      seq: 2,
      session: {
        blankMode: 'keep',
        straighten: 'off',
        id: 'session.x',
        backsDeclined: true,
        saved: false,
        edits: EMPTY_EDITS,
        assembled: null,
        passes: flip.session?.passes ?? [],
      },
    });
    let current = flip;
    let notify: (payload: { seq: number }) => void = () => undefined;
    stubApi(flip, {
      getSnapshot: vi.fn(() => Promise.resolve(ok(current))),
      onSnapshotChanged: vi.fn((listener: (payload: { seq: number }) => void) => {
        notify = listener;
        return () => undefined;
      }),
      declineBacks: vi.fn(() => Promise.resolve(ok(undefined))),
    });
    render(<App />);
    await screen.findByRole('button', { name: 'Обороты не нужны' });

    current = declined;
    await act(async () => {
      notify({ seq: 2 });
      await Promise.resolve();
    });
    // Решение автора на приёмке B-5: сопоставлять нечего — экрана `merge` нет вовсе.
    expect(document.querySelector('.merge-screen')).toBeNull();
    expect(await screen.findByText('1 из 3')).toBeDefined();
  });

  it('KTD-5: пауза merge не теряется, когда кадр scan пропущен (снимки пришли пачкой)', async () => {
    const flip = makeSnapshot({
      session: {
        blankMode: 'keep',
        straighten: 'off',
        id: 'session.x',
        backsDeclined: false,
        saved: false,
        edits: EMPTY_EDITS,
        assembled: null,
        passes: [
          {
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
          },
        ],
      },
    });
    const done = makeSnapshot({
      seq: 2,
      session: {
        blankMode: 'keep',
        straighten: 'off',
        id: 'session.x',
        backsDeclined: false,
        saved: false,
        edits: EMPTY_EDITS,
        assembled: null,
        passes: [
          ...(flip.session?.passes ?? []),
          {
            number: 2,
            state: 'completed',
            paramsKnown: true,
            scanner: null,
            kind: 'backs',
            after: null,
            pair: null,
            backsDecision: null,
            rotate180: false,
            pages: pages(3, 1).map((page) => ({ ...page, key: `p02-s01-000${page.number}` })),
          },
        ],
      },
    });
    let current = flip;
    let notify: (payload: { seq: number }) => void = () => undefined;
    stubApi(flip, {
      getSnapshot: vi.fn(() => Promise.resolve(ok(current))),
      onSnapshotChanged: vi.fn((listener: (payload: { seq: number }) => void) => {
        notify = listener;
        return () => undefined;
      }),
    });
    render(<App />);
    await screen.findByRole('button', { name: 'Листы в лотке — сканировать обороты' });

    vi.useFakeTimers();
    try {
      // Проход оборотов прошёл так быстро, что интерфейс не увидел ни одного кадра `scan`.
      current = done;
      await act(async () => {
        notify({ seq: 2 });
        await Promise.resolve();
      });
      expect(document.querySelector('.merge-screen')).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(1601);
      });
      expect(document.querySelector('.merge-screen')).toBeNull();
      expect(screen.getByText('1 из 6')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('KTD-8/AE13: несовпадение показывается при входе в editor после перезапуска; закрытие подтверждает', async () => {
    // Свежий процесс открывается сразу в editor (паузы merge нет) — модалка не проглочена.
    stubApi(
      makeSnapshot({
        session: {
          blankMode: 'keep',
          straighten: 'off',
          id: 'session.x',
          backsDeclined: false,
          saved: false,
          edits: EMPTY_EDITS,
          assembled: null,
          passes: [
            {
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
            },
            {
              number: 2,
              state: 'completed',
              paramsKnown: true,
              scanner: null,
              kind: 'backs',
              after: null,
              pair: null,
              backsDecision: null,
              rotate180: false,
              pages: pages(2, 1).map((page) => ({ ...page, key: `p02-s01-000${page.number}` })),
            },
          ],
        },
      }),
    );
    render(<App />);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Лицевых сторон 3, оборотов — 2')).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Понятно' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Лента осталась в режиме наборов — модалка объясняет, не меняет (M3.6).
    expect(screen.getByRole('button', { name: 'Собрать документ' })).toBeDefined();
  });

  it('KTD-8: прерванный и не принятый проход оборотов модалку не зовёт — решение за плашкой', async () => {
    stubApi(
      makeSnapshot({
        canResume: true,
        canAccept: true,
        session: {
          blankMode: 'keep',
          straighten: 'off',
          id: 'session.x',
          backsDeclined: false,
          saved: false,
          edits: EMPTY_EDITS,
          assembled: null,
          passes: [
            {
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
            },
            {
              number: 2,
              state: 'interrupted',
              paramsKnown: true,
              scanner: null,
              kind: 'backs',
              after: null,
              pair: null,
              backsDecision: null,
              rotate180: false,
              pages: pages(2, 1).map((page) => ({ ...page, key: `p02-s01-000${page.number}` })),
            },
          ],
        },
      }),
    );
    render(<App />);

    expect(await screen.findByText(/Проход прервался/)).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('запуск без сканера открывает модалку device; подключение закрывает её тостом', async () => {
    stubApi(makeSnapshot({}), {
      startDiscovery: vi.fn(() => Promise.resolve(ok({ scanners: [FOUND], failure: null }))),
      getDiscovery: vi.fn(() => Promise.resolve(ok({ scanners: [FOUND], failure: null }))),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Сканировать лицевые стороны' }));
    expect(await screen.findByRole('dialog')).toBeDefined();

    fireEvent.click(await screen.findByText('ScanPro 200'));
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));

    expect((await screen.findByText(/Сканер подключён/)).textContent).toBe(
      'Сканер подключён: ScanPro 200',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
