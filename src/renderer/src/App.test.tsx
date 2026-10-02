import { fail, ok, type Api, type CommandResult, type ProbeResult } from '@shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './i18n';
import { App } from './App';

const VALUE: ProbeResult = {
  echo: 'proof-shell',
  versions: {
    electron: '44.0.0',
    chrome: '140.0.0',
    node: '24.0.0',
    sharp: '0.35.0',
    libvips: '8.17.9',
  },
  image: { format: 'jpeg', width: 8, height: 8, bytes: 100 },
};

const RESULT = ok(VALUE);

function stubApi(probe: Api['probe']): void {
  const api: Api = {
    probe,
    onSnapshotChanged: () => () => undefined,
    onDiscoveryChanged: () => () => undefined,
  };
  vi.stubGlobal('api', api);
}

// Глобалы vitest выключены, поэтому авто-очистка testing-library не срабатывает сама.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('proof-shell', () => {
  it('показывает название и версию libvips из ответа пробы', async () => {
    const probe = vi.fn(() => Promise.resolve(RESULT));
    stubApi(probe);
    render(<App />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("Duplexn't");
    const status = await screen.findByText('Обработка изображений работает — libvips 8.17.9');
    expect(status.getAttribute('role')).toBe('status');
    expect(screen.getByText('44.0.0')).toBeDefined();
    expect(probe).toHaveBeenCalledWith({ token: 'proof-shell' });
  });

  it('пока проба идёт — строка ожидания, без версий', () => {
    stubApi(vi.fn(() => new Promise<CommandResult<'probe'>>(() => undefined)));
    render(<App />);

    expect(screen.getByRole('status').textContent).toBe('Проверяю обработку изображений…');
    expect(screen.queryByText('Electron')).toBeNull();
  });

  it('ошибка программы — отказ invoke — даёт строку об ошибке через t(), без необработанного исключения', async () => {
    stubApi(vi.fn(() => Promise.reject(new TypeError('поле token'))));
    render(<App />);

    expect((await screen.findByRole('alert')).textContent).toBe('Проба не прошла: поле token');
  });

  it('доменный отказ в конверте даёт текст по коду ошибки из локали', async () => {
    stubApi(vi.fn(() => Promise.resolve(fail('invalidInput'))));
    render(<App />);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Проба не прошла: приложение отправило некорректный запрос',
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('preload не загрузился, window.api нет — строка об ошибке, а не вечное ожидание', async () => {
    render(<App />);

    expect((await screen.findByRole('alert')).textContent).toContain('Проба не прошла');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('счётчик для 1, 2 и 5 даёт три разные формы слова', () => {
    stubApi(vi.fn(() => Promise.resolve(RESULT)));
    render(<App />);

    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual(['1 лист', '2 листа', '5 листов']);
  });
});
