import { fail, ok, type Api } from '@shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { NewScanModal, type NewScanModalProps } from './NewScanModal';

// Модалка `newscan` (план M3, U9; handoff M3, S17): кикер и текст по состоянию набора,
// карточки, закрытие сессии.

function stubApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const api = {
    closeSession: vi.fn(() => Promise.resolve(ok(undefined))),
    ...overrides,
  } as unknown as Api;
  vi.stubGlobal('api', api);
  return api;
}

function renderModal(props: Partial<NewScanModalProps> = {}) {
  const onClose = vi.fn();
  const onSaveFirst = vi.fn();
  render(
    <NewScanModal
      total={24}
      deleted={0}
      saved={false}
      onClose={onClose}
      onSaveFirst={onSaveFirst}
      {...props}
    />,
  );
  return { onClose, onSaveFirst };
}

const fresh = (): HTMLElement =>
  screen.getByRole('button', { name: /Закрыть текущий и начать новое сканирование/ });
const saveFirst = (): HTMLElement | null =>
  screen.queryByRole('button', { name: /Сначала сохранить текущий/ });
const subtitle = (): string => document.getElementById('newscan-text')?.textContent ?? '';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('модалка newscan: состояние набора', () => {
  it('несохранённое — янтарный кикер, число страниц, обе карточки; фокус — «Остаться»', () => {
    stubApi();
    renderModal();

    expect(screen.getByText('ЕСТЬ НЕСОХРАНЁННЫЕ ИЗМЕНЕНИЯ').className).toContain('kicker--warning');
    expect(subtitle()).toBe(
      'Последние изменения не сохранены в файл. Если начать новое сканирование, 24 стр. будут удалены с диска.',
    );
    expect(fresh().textContent).toContain('Текущие 24 стр. будут удалены без сохранения');
    expect(saveFirst()).not.toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Остаться в документе' }),
    );
  });

  it('сохранённый — акцентный кикер, без «Сначала сохранить»', () => {
    stubApi();
    renderModal({ saved: true });

    expect(screen.getByText('ТЕКУЩИЙ ДОКУМЕНТ СОХРАНЁН').className).toContain('kicker--accent');
    expect(subtitle()).toContain('сохранённые PDF останутся');
    expect(fresh().textContent).toContain('Вернёмся к настройке сканирования');
    expect(saveFirst()).toBeNull();
  });

  it('удалённые пометкой называются числом — их тоже сотрёт', () => {
    stubApi();
    renderModal({ saved: true, deleted: 3 });

    expect(subtitle()).toContain(
      'Удалённые из ленты страницы (3 стр.) тоже будут стёрты — вернуть их будет нельзя.',
    );
  });

  it('AE10: лента пуста — «ДОКУМЕНТ ПУСТ», про возвращаемые Ctrl+Z страницы, без сохранения', () => {
    stubApi();
    renderModal({ total: 0, deleted: 5 });

    expect(screen.getByText('ДОКУМЕНТ ПУСТ')).toBeDefined();
    expect(subtitle()).toContain('их ещё можно вернуть — Ctrl+Z или «Вернуть»');
    expect(subtitle()).toContain('(5 стр.)');
    expect(saveFirst()).toBeNull();
  });
});

describe('модалка newscan: действия', () => {
  it('«Закрыть текущий…» шлёт закрытие сессии и блокирует карточки до ответа', () => {
    const api = stubApi({ closeSession: vi.fn(() => new Promise(() => undefined)) });
    const { onClose } = renderModal();

    fireEvent.click(fresh());

    expect(api.closeSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Удаляем…')).toBeDefined();
    expect(fresh().hasAttribute('disabled')).toBe(true);
    expect(saveFirst()?.hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Остаться в документе' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('успех закрывает модалку', async () => {
    stubApi();
    const { onClose } = renderModal();

    fireEvent.click(fresh());
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('отказ показан статусной строкой, карточки снова доступны, сессия цела', async () => {
    stubApi({ closeSession: vi.fn(() => Promise.resolve(fail('sessionCloseFailed'))) });
    const { onClose } = renderModal();

    fireEvent.click(fresh());

    expect((await screen.findByRole('alert')).textContent).toContain('Не удалось удалить страницы');
    expect(fresh().hasAttribute('disabled')).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('«Сначала сохранить текущий» отдаёт выбор экрану и ничего не шлёт', () => {
    const api = stubApi();
    const { onSaveFirst } = renderModal();

    const button = saveFirst();
    if (button === null) {
      throw new Error('нет карточки');
    }
    fireEvent.click(button);

    expect(onSaveFirst).toHaveBeenCalledTimes(1);
    expect(api.closeSession).not.toHaveBeenCalled();
  });

  it('«Остаться в документе» зовёт onClose и не шлёт команду', () => {
    const api = stubApi();
    const { onClose } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Остаться в документе' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.closeSession).not.toHaveBeenCalled();
  });
});
