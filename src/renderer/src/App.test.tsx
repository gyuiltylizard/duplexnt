import {
  fail,
  ok,
  type Api,
  type DiscoveredScanner,
  type ScannerState,
  type Snapshot,
} from '@shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './i18n';
import { App } from './App';

function makeSnapshot(overrides: Partial<Snapshot>): Snapshot {
  return {
    seq: 1,
    scanner: { kind: 'none' },
    session: null,
    pass: null,
    canResume: false,
    canAccept: false,
    storage: { incompatible: false, unsaved: false },
    notices: [],
    ...overrides,
  };
}

const PARAMS = { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' } as const;

const READY: ScannerState = {
  kind: 'ready',
  scanner: { name: 'ScanPro 200', scheme: 'https', host: '192.0.2.10', port: 443 },
  options: { colorModes: ['Grayscale8'], resolutions: [300], paperSizes: ['A4'] },
  params: PARAMS,
};

const FOUND: DiscoveredScanner = {
  id: 'abcdef01-1',
  name: 'ScanPro 200',
  address: '192.0.2.10',
  port: 443,
  hasAdf: true,
};

function pages(count: number, from = 1): { key: string; number: number; lost: boolean }[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `p01-s01-${String(from + index).padStart(4, '0')}`,
    number: from + index,
    lost: false,
  }));
}

function stubApi(snapshot: Snapshot, overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const unsubscribe = vi.fn();
  const api = {
    getSnapshot: vi.fn(() => Promise.resolve(ok(snapshot))),
    onSnapshotChanged: vi.fn(() => unsubscribe),
    onDiscoveryChanged: vi.fn(() => () => undefined),
    startDiscovery: vi.fn(() => Promise.resolve(ok({ scanners: [], failure: null }))),
    getDiscovery: vi.fn(() => Promise.resolve(ok({ scanners: [], failure: null }))),
    stopDiscovery: vi.fn(() => Promise.resolve(ok(undefined))),
    cancelConnect: vi.fn(() => Promise.resolve(ok(undefined))),
    connectScanner: vi.fn(() => Promise.resolve(ok(undefined))),
    setScanParams: vi.fn(() => Promise.resolve(ok(undefined))),
    recheckScanner: vi.fn(() => Promise.resolve(ok(undefined))),
    startPass: vi.fn(() => new Promise(() => undefined)),
    stopPass: vi.fn(() => Promise.resolve(ok(undefined))),
    acceptPass: vi.fn(() => Promise.resolve(ok(undefined))),
    closeSession: vi.fn(() => Promise.resolve(ok(undefined))),
    ...overrides,
  } as unknown as Api;
  vi.stubGlobal('api', api);
  return { unsubscribe };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('каркас приложения', () => {
  it('нет сессии — окно открывается на setup', async () => {
    stubApi(makeSnapshot({}));
    render(<App />);

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Сканируем листы из автоподатчика',
    );
  });

  it('идущий проход — экран scan со счётчиком принятых страниц', async () => {
    stubApi(
      makeSnapshot({
        pass: { phase: 'scanning', resumed: false, params: PARAMS, pages: 7 },
        session: {
          id: 'session.x',
          passes: [
            { number: 1, state: 'running', paramsKnown: true, scanner: null, pages: pages(7) },
          ],
        },
      }),
    );
    render(<App />);

    expect((await screen.findByRole('status')).textContent).toBe('Отсканировано 7');
    expect(screen.getByText('ПРОХОД 1')).toBeDefined();
  });

  it('сессия со страницами без прохода — editor со счётчиком страниц', async () => {
    stubApi(
      makeSnapshot({
        session: {
          id: 'session.x',
          passes: [
            { number: 1, state: 'interrupted', paramsKnown: true, scanner: null, pages: pages(5) },
          ],
        },
      }),
    );
    render(<App />);

    expect(await screen.findByText('5 страниц')).toBeDefined();
  });

  it('несовместимые данные — свой экран вместо любого другого', async () => {
    stubApi(makeSnapshot({ storage: { incompatible: true, unsaved: false } }));
    render(<App />);

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Эти сканы сохранила более новая версия приложения',
    );
    expect(screen.queryByText('Сканируем листы из автоподатчика')).toBeNull();
  });

  it('StrictMode (двойное монтирование dev) не оставляет окно пустым', async () => {
    stubApi(makeSnapshot({}));
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Сканируем листы из автоподатчика',
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

    fireEvent.click(await screen.findByRole('button', { name: 'Сканировать листы' }));
    expect((await screen.findByRole('alert')).textContent).toContain('В лотке нет бумаги');
  });

  it('после отказа запуск доступен снова, плашка снимается следующим нажатием', async () => {
    const startPass = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(fail('scanNoPaper')))
      .mockImplementation(() => new Promise(() => undefined));
    stubApi(makeSnapshot({ scanner: READY }), { startPass });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Сканировать листы' }));
    expect((await screen.findByRole('alert')).textContent).toContain('В лотке нет бумаги');

    fireEvent.click(screen.getByRole('button', { name: 'Сканировать листы' }));
    expect(startPass).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('S15: отказ закрытия сегмента после «Остановить» — тостом', async () => {
    stubApi(
      makeSnapshot({
        pass: { phase: 'scanning', resumed: false, params: PARAMS, pages: 2 },
        session: {
          id: 'session.x',
          passes: [
            { number: 1, state: 'running', paramsKnown: true, scanner: null, pages: pages(2) },
          ],
        },
      }),
      { stopPass: vi.fn(() => Promise.resolve(fail('sessionCloseFailed'))) },
    );
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Остановить' }));
    expect((await screen.findByText(/Не удалось убрать страницы/)).textContent).toContain(
      'Проход оставлен прерванным',
    );
  });

  it('другой отказ «Остановить» тоста не даёт', async () => {
    stubApi(
      makeSnapshot({
        pass: { phase: 'scanning', resumed: false, params: PARAMS, pages: 2 },
        session: {
          id: 'session.x',
          passes: [
            { number: 1, state: 'running', paramsKnown: true, scanner: null, pages: pages(2) },
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
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(screen.queryByText(/Не удалось убрать страницы/)).toBeNull();
  });

  it('pagesLost с потерянной страницей в ленте — плашка видна', async () => {
    stubApi(
      makeSnapshot({
        notices: ['pagesLost'],
        session: {
          id: 'session.x',
          passes: [
            {
              number: 1,
              state: 'completed',
              paramsKnown: true,
              scanner: null,
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
        id: 'session.x',
        passes: [
          { number: 1, state: 'interrupted', paramsKnown: true, scanner: null, pages: pages(3) },
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
    fireEvent.click(within(banner).getByRole('button', { name: 'Новое сканирование' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить и начать заново' }));

    // Сессия закрыта — приходит снимок без неё, экран уходит на `setup`.
    current = makeSnapshot({ seq: 2, scanner: READY });
    act(() => {
      notify({ seq: 2 });
    });

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe(
      'Сканируем листы из автоподатчика',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/В лотке нет бумаги/)).toBeNull();
  });

  it('после закрытия device, открытой из плашки отказа, фокус не теряется', async () => {
    stubApi(makeSnapshot({ scanner: READY }), {
      startPass: vi.fn(() => Promise.resolve(fail('scannerCertificateChanged'))),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Сканировать листы' }));
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

    const start = await screen.findByRole('button', { name: 'Сканировать листы' });
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
          id: 'session.x',
          passes: [
            { number: 1, state: 'interrupted', paramsKnown: true, scanner: null, pages: pages(3) },
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

  it('запуск без сканера открывает модалку device; подключение закрывает её тостом', async () => {
    stubApi(makeSnapshot({}), {
      startDiscovery: vi.fn(() => Promise.resolve(ok({ scanners: [FOUND], failure: null }))),
      getDiscovery: vi.fn(() => Promise.resolve(ok({ scanners: [FOUND], failure: null }))),
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Сканировать листы' }));
    expect(await screen.findByRole('dialog')).toBeDefined();

    fireEvent.click(await screen.findByText('ScanPro 200'));
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));

    expect((await screen.findByText(/Сканер подключён/)).textContent).toBe(
      'Сканер подключён: ScanPro 200',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
