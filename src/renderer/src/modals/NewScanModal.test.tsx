import { fail, ok, type Api } from '@shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { NewScanModal } from './NewScanModal';

function stubApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const api = {
    closeSession: vi.fn(() => Promise.resolve(ok(undefined))),
    ...overrides,
  } as unknown as Api;
  vi.stubGlobal('api', api);
  return api;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('модалка newscan', () => {
  it('называет число удаляемых страниц; начальный фокус — на «Отмена»', () => {
    stubApi();
    render(<NewScanModal pageCount={21} onClose={vi.fn()} />);

    expect(
      screen.getByText(
        '21 отсканированная страница будет удалена с диска. Вернуть её будет нельзя.',
      ),
    ).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Отмена' }));
  });

  it('подтверждение шлёт закрытие сессии и блокирует обе кнопки до ответа', () => {
    const api = stubApi({ closeSession: vi.fn(() => new Promise(() => undefined)) });
    const onClose = vi.fn();
    render(<NewScanModal pageCount={3} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Удалить и начать заново' }));

    expect(api.closeSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Удаляем…')).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Удалить и начать заново' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Отмена' }).hasAttribute('disabled')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('успех закрывает модалку', async () => {
    stubApi();
    const onClose = vi.fn();
    render(<NewScanModal pageCount={3} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Удалить и начать заново' }));
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('отказ показан статусной строкой, кнопки снова доступны, сессия цела', async () => {
    stubApi({ closeSession: vi.fn(() => Promise.resolve(fail('sessionCloseFailed'))) });
    const onClose = vi.fn();
    render(<NewScanModal pageCount={3} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Удалить и начать заново' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Не удалось удалить страницы');
    expect(
      screen.getByRole('button', { name: 'Удалить и начать заново' }).hasAttribute('disabled'),
    ).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('отмена зовёт onClose и не шлёт команду', () => {
    const api = stubApi();
    const onClose = vi.fn();
    render(<NewScanModal pageCount={3} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.closeSession).not.toHaveBeenCalled();
  });
});
