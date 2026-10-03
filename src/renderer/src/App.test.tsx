import { ok, type Api, type Snapshot } from '@shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function pages(count: number, from = 1): { key: string; number: number; lost: boolean }[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `p01-s01-${String(from + index).padStart(4, '0')}`,
    number: from + index,
    lost: false,
  }));
}

// Каркас зовёт только снимок и его событие; остальные команды приходят с экранами U21–U24.
function stubApi(snapshot: Snapshot): { unsubscribe: ReturnType<typeof vi.fn> } {
  const unsubscribe = vi.fn();
  const api = {
    getSnapshot: vi.fn(() => Promise.resolve(ok(snapshot))),
    onSnapshotChanged: vi.fn(() => unsubscribe),
    onDiscoveryChanged: vi.fn(() => () => undefined),
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
        pass: { phase: 'scanning', resumed: false, pages: 7 },
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

    const text = await screen.findByText(/восстановлен по файлам/);
    expect(text).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Понятно' }));
    expect(screen.queryByText(/восстановлен по файлам/)).toBeNull();
  });

  it('pagesLost без потерянных страниц в ленте не показывается', async () => {
    stubApi(makeSnapshot({ notices: ['pagesLost'] }));
    render(<App />);

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/не нашлось файлов/)).toBeNull();
  });
});
