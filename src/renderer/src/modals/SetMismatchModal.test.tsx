import { fail, ok, type AddedSetReport, type Api } from '@shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { SetMismatchModal } from './SetMismatchModal';

// Модалка несовпадения набора (план M4.5, U6; R15; handoff M4.5, S7): два действия, фокус на
// безопасном, занятость на время команды, отказ строкой, Esc и подложка не закрывают.

const SET: AddedSetReport = {
  set: 1,
  fronts: 3,
  backs: 2,
  backsState: 'completed',
  decision: 'none',
  mismatch: true,
  sides: 'two',
};

function stubApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const api = {
    keepSetBacks: vi.fn(() => Promise.resolve(ok(undefined))),
    rescanSetBacks: vi.fn(() => Promise.resolve(ok(undefined))),
    ...overrides,
  } as unknown as Api;
  vi.stubGlobal('api', api);
  return api;
}

const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SetMismatchModal', () => {
  it('заголовок с числами набора, текст называет число удаляемых оборотов, фокус — «Оставить как есть»', () => {
    stubApi();
    render(<SetMismatchModal set={SET} />);

    const dialog = screen.getByRole('dialog', { name: 'В наборе Д1 лиц 3, оборотов 2' });
    expect(dialog.className).toContain('modal--small');
    expect(screen.getByText('ОБОРОТЫ НАБОРА НЕ СОШЛИСЬ')).toBeDefined();
    expect(
      screen.getByText(/убрать 2 отсканированных оборота набора вместе с правками на них/),
    ).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Оставить как есть' }));
    expect(screen.getByRole('button', { name: 'Переснять обороты набора' }).className).toContain(
      'btn--tinted',
    );
  });

  it.each([
    [1, /убрать 1 отсканированный оборот набора/],
    [5, /убрать 5 отсканированных оборотов набора/],
  ])('плюрализация оборотов: %i', (backs, expected) => {
    stubApi();
    render(<SetMismatchModal set={{ ...SET, backs }} />);

    expect(screen.getByText(expected)).toBeDefined();
  });

  it('«Оставить как есть» шлёт keepSetBacks с номером набора; обе кнопки недоступны до ответа', async () => {
    const api = stubApi({ keepSetBacks: vi.fn(() => new Promise(() => undefined)) });
    render(<SetMismatchModal set={SET} />);

    const keep = screen.getByRole('button', { name: 'Оставить как есть' });
    fireEvent.click(keep);
    fireEvent.click(keep);
    expect(api.keepSetBacks).toHaveBeenCalledExactlyOnceWith({ set: 1 });
    expect(keep.hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Переснять обороты набора' }).hasAttribute('disabled'),
    ).toBe(true);
    await settle();
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
  });

  it('«Переснять обороты набора» шлёт rescanSetBacks; пока идёт отброс — «Убираем обороты…»', () => {
    const api = stubApi({ rescanSetBacks: vi.fn(() => new Promise(() => undefined)) });
    render(<SetMismatchModal set={SET} />);

    fireEvent.click(screen.getByRole('button', { name: 'Переснять обороты набора' }));
    expect(api.rescanSetBacks).toHaveBeenCalledExactlyOnceWith({ set: 1 });
    const busy = screen.getByRole('button', { name: 'Убираем обороты…' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.hasAttribute('disabled')).toBe(true);
  });

  it('отказ отброса — строкой под действиями, кнопки снова доступны; повтор уходит заново', async () => {
    const api = stubApi({
      rescanSetBacks: vi
        .fn()
        .mockResolvedValueOnce(fail('sessionConflict', { reason: 'setNotMismatched' }))
        .mockResolvedValue(ok(undefined)),
    });
    render(<SetMismatchModal set={SET} />);

    fireEvent.click(screen.getByRole('button', { name: 'Переснять обороты набора' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(
      'Не удалось убрать обороты: лица и обороты этого набора сошлись — решать нечего.',
    );
    const rescan = screen.getByRole('button', { name: 'Переснять обороты набора' });
    expect(rescan.hasAttribute('disabled')).toBe(false);
    fireEvent.click(rescan);
    expect(api.rescanSetBacks).toHaveBeenCalledTimes(2);
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('отказ записи решения — своим текстом', async () => {
    stubApi({ keepSetBacks: vi.fn(() => Promise.resolve(fail('storageFailed'))) });
    render(<SetMismatchModal set={SET} />);

    fireEvent.click(screen.getByRole('button', { name: 'Оставить как есть' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/^Не удалось записать решение: /);
  });

  it('мост не ответил — строка про отсутствие ответа, кнопки доступны', async () => {
    stubApi({ keepSetBacks: vi.fn(() => Promise.reject(new Error('ipc'))) });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SetMismatchModal set={SET} />);

    fireEvent.click(screen.getByRole('button', { name: 'Оставить как есть' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('приложение не получило ответа');
    expect(screen.getByRole('button', { name: 'Оставить как есть' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('Esc не закрывает; Tab ходит по кольцу из двух кнопок', () => {
    stubApi();
    render(<SetMismatchModal set={SET} />);

    const keep = screen.getByRole('button', { name: 'Оставить как есть' });
    const rescan = screen.getByRole('button', { name: 'Переснять обороты набора' });
    fireEvent.keyDown(keep, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeDefined();
    fireEvent.keyDown(keep, { key: 'Tab' });
    expect(document.activeElement).toBe(rescan);
    fireEvent.keyDown(rescan, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(keep);
  });
});
