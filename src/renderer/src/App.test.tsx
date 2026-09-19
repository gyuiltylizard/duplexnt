import type { Api, ProbeResult } from '@shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const RESULT: ProbeResult = {
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

function stubApi(api: Api): void {
  vi.stubGlobal('api', api);
}

// Глобалы vitest выключены, поэтому авто-очистка testing-library не срабатывает сама.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('монтируется в jsdom и показывает результат пробы', async () => {
    stubApi({ probe: vi.fn(() => Promise.resolve(RESULT)) });
    render(<App />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("Duplexn't");
    expect((await screen.findByText(/8\.17\.9/)).textContent).toContain('proof-shell');
  });

  it('отклонённая проба даёт строку об ошибке, а не необработанное исключение', async () => {
    stubApi({ probe: vi.fn(() => Promise.reject(new TypeError('поле token'))) });
    render(<App />);

    expect((await screen.findByRole('alert')).textContent).toContain('поле token');
  });
});
