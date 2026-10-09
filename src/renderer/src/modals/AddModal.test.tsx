import type { ScannerState } from '@shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { AddModal, type AddModalProps } from './AddModal';

// Модалка `add` (план M3.5, U6; handoff M3.5, S2): карточки, место, сводка с якорем, строка
// сканера, «Начать скан» с якорем из видимой ленты (KTD-8), клавиатура радиогрупп.

const READY: ScannerState = {
  kind: 'ready',
  scanner: { name: 'ScanPro 200', scheme: 'https', host: '192.0.2.10', port: 443 },
  options: { colorModes: ['Grayscale8'], resolutions: [300], paperSizes: ['A4'] },
  params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
};

const CURRENT = { key: 'p02-s01-0009', page: 7, label: 'оборот листа 4' };
const DOC_END = { key: 'p01-s01-0005', page: 9, label: 'Акт приёма-передачи' };

function renderModal(props: Partial<AddModalProps> = {}) {
  const onStart = vi.fn();
  const onClose = vi.fn();
  render(
    <AddModal
      scanner={READY}
      current={CURRENT}
      documentEnd={DOC_END}
      onStart={onStart}
      onClose={onClose}
      {...props}
    />,
  );
  return { onStart, onClose };
}

const radio = (name: string | RegExp): HTMLElement => screen.getByRole('radio', { name });
const summary = (): string => document.querySelector('.add-modal__summary')?.textContent ?? '';
const start = (): HTMLElement => screen.getByRole('button', { name: 'Начать скан' });

afterEach(cleanup);

describe('модалка add: состояние по умолчанию', () => {
  it('карточка «Односторонние листы» и «После текущей» выбраны, сводка называет якорь, фокус — «Отмена»', () => {
    renderModal();

    expect(screen.getByRole('dialog', { name: 'Добавить страницы к документу' })).toBeDefined();
    expect(radio(/Односторонние листы/).getAttribute('aria-checked')).toBe('true');
    expect(radio(/Один лист/).getAttribute('aria-checked')).toBe('false');
    expect(radio('После текущей страницы').getAttribute('aria-checked')).toBe('true');
    expect(summary()).toBe('Один проход · после стр. 7 (оборот листа 4)');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Отмена' }));
  });

  it('строка сканера: имя и «готов · параметры»; «Начать скан» доступна', () => {
    renderModal();

    expect(screen.getByText('ScanPro 200')).toBeDefined();
    expect(screen.getByText('готов · 300 dpi · оттенки серого · A4')).toBeDefined();
    expect(start().hasAttribute('disabled')).toBe(false);
  });

  it('сканера нет: строка «не подключён», «Начать скан» недоступна, выбор остаётся активным', () => {
    renderModal({ scanner: { kind: 'none' } });

    expect(screen.getByText('Сканер не подключён — подключите его в настройках')).toBeDefined();
    expect(start().hasAttribute('disabled')).toBe(true);
    fireEvent.click(radio(/Один лист/));
    expect(summary()).toBe('Один лист · после стр. 7 (оборот листа 4)');
  });

  it('тексты карточек: «Один лист» объясняет, как положить лист оборотом', () => {
    renderModal();

    expect(screen.getByText('Один проход, обороты не сканируем')).toBeDefined();
    expect(screen.getByText(/положите его оборотом вверх и разверните на 180°/)).toBeDefined();
  });
});

describe('модалка add: выбор и сводка', () => {
  it('карточка и место меняют сводку; «В конец документа» называет документ и его последнюю страницу', () => {
    renderModal();

    fireEvent.click(radio(/Один лист/));
    expect(summary()).toBe('Один лист · после стр. 7 (оборот листа 4)');
    fireEvent.click(radio('В конец документа'));
    expect(summary()).toBe('Один лист · в конец документа «Акт приёма-передачи», после стр. 9');
  });

  it('пустая лента: «После текущей» недоступна с причиной, выбран конец, сводка — «в конец ленты»', () => {
    renderModal({ current: null, documentEnd: null });

    const after = radio('После текущей страницы');
    expect(after.getAttribute('aria-disabled')).toBe('true');
    expect(after.getAttribute('title')).toBe('Нет текущей страницы — лента пуста');
    expect(radio('В конец документа').getAttribute('aria-checked')).toBe('true');
    expect(summary()).toBe('Один проход · в конец ленты');
    fireEvent.click(after);
    expect(after.getAttribute('aria-checked')).toBe('false');
  });

  it('стрелки переводят выбор и фокус в радиогруппе; недоступный сегмент пропускается', () => {
    renderModal({ current: null, documentEnd: null });

    const sheets = radio(/Односторонние листы/);
    sheets.focus();
    fireEvent.keyDown(sheets, { key: 'ArrowDown' });
    expect(radio(/Один лист/).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radio(/Один лист/));
    fireEvent.keyDown(radio(/Один лист/), { key: 'ArrowUp' });
    expect(radio(/Односторонние листы/).getAttribute('aria-checked')).toBe('true');

    const end = radio('В конец документа');
    end.focus();
    fireEvent.keyDown(end, { key: 'ArrowRight' });
    expect(end.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(end);
  });

  it('в обходе Tab — только выбранный элемент каждой группы', () => {
    renderModal();

    expect(radio(/Односторонние листы/).tabIndex).toBe(0);
    expect(radio(/Один лист/).tabIndex).toBe(-1);
    expect(radio('После текущей страницы').tabIndex).toBe(0);
    expect(radio('В конец документа').tabIndex).toBe(-1);
  });
});

describe('модалка add: запуск и отмена', () => {
  it('«Начать скан» закрывает модалку и зовёт запуск с якорем текущей', () => {
    const { onStart, onClose } = renderModal();

    fireEvent.click(start());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledExactlyOnceWith('p02-s01-0009');
  });

  it('«В конец документа» — якорь: последняя страница документа; пустая лента — null', () => {
    const first = renderModal();
    fireEvent.click(radio('В конец документа'));
    fireEvent.click(start());
    expect(first.onStart).toHaveBeenCalledExactlyOnceWith('p01-s01-0005');
    cleanup();

    const second = renderModal({ current: null, documentEnd: null });
    fireEvent.click(start());
    expect(second.onStart).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('«Отмена» закрывает без запуска', () => {
    const { onStart, onClose } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('фокус заперт: Tab с «Начать скан» возвращается в окно', () => {
    renderModal();

    const button = start();
    button.focus();
    fireEvent.keyDown(button, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(button);
  });
});
