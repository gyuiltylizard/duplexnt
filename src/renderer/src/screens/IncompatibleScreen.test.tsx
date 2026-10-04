import { fail, ok, type Api } from '@shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { IncompatibleScreen } from './IncompatibleScreen';

function stubApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const api = {
    openDataFolder: vi.fn(() => Promise.resolve(ok(undefined))),
    ...overrides,
  } as unknown as Api;
  vi.stubGlobal('api', api);
  return api;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('экран несовместимых данных (S22)', () => {
  it('фокус при открытии — на «Открыть папку с данными»; клик шлёт команду', () => {
    const api = stubApi();
    render(<IncompatibleScreen />);

    const open = screen.getByRole('button', { name: 'Открыть папку с данными' });
    expect(document.activeElement).toBe(open);

    fireEvent.click(open);
    expect(api.openDataFolder).toHaveBeenCalledTimes(1);
  });

  it('отказ открытия каталога показан строкой под действиями', async () => {
    stubApi({
      openDataFolder: vi.fn(() => Promise.resolve(fail('storageFailed', { reason: 'openPath' }))),
    });
    render(<IncompatibleScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Открыть папку с данными' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Не удалось записать данные на диск',
    );
  });

  it('«Выйти» закрывает окно', () => {
    stubApi();
    const close = vi.fn();
    vi.stubGlobal('close', close);
    render(<IncompatibleScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
