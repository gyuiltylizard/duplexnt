import type { PassProgress, Snapshot } from '@shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { ScanScreen, STRIP_SIZE } from './ScanScreen';

const PARAMS = { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' } as const;

function pages(count: number, from = 1): { key: string; number: number; lost: boolean }[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `p01-s01-${String(from + index).padStart(4, '0')}`,
    number: from + index,
    lost: false,
  }));
}

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

function running(pageCount: number, passPages: number, phase: PassProgress['phase'] = 'scanning') {
  const pass: PassProgress = { phase, resumed: false, params: PARAMS, pages: passPages };
  const snapshot = makeSnapshot({
    pass,
    session: {
      id: 'session.x',
      passes: [
        { number: 1, state: 'running', paramsKnown: true, scanner: null, pages: pages(pageCount) },
      ],
    },
  });
  return { snapshot, pass };
}

afterEach(cleanup);

describe('экран scan', () => {
  it('счётчик следует за снимком, строка параметров — параметры прохода', () => {
    const { snapshot, pass } = running(7, 7);
    render(<ScanScreen snapshot={snapshot} pass={pass} onStop={vi.fn()} />);

    expect(screen.getByRole('status').textContent).toBe('Отсканировано 7');
    expect(screen.getByText('300 dpi · оттенки серого · A4')).toBeDefined();
    expect(screen.getByText('ПРОХОД 1')).toBeDefined();
  });

  it('фаза starting без страниц — «Начинаем проход…»', () => {
    const pass: PassProgress = { phase: 'starting', resumed: false, params: PARAMS, pages: 0 };
    render(<ScanScreen snapshot={makeSnapshot({ pass })} pass={pass} onStop={vi.fn()} />);

    expect(screen.getByRole('status').textContent).toBe('Начинаем проход…');
  });

  it('лента показывает не больше пяти последних страниц', () => {
    const { snapshot, pass } = running(8, 8);
    render(<ScanScreen snapshot={snapshot} pass={pass} onStop={vi.fn()} />);

    const cards = screen.getByRole('list', { name: 'Последние страницы' }).children;
    expect(cards.length).toBe(STRIP_SIZE);
    // Последняя карточка — самая новая страница.
    expect(screen.getByAltText('Страница 8')).toBeDefined();
    expect(screen.queryByAltText('Страница 3')).toBeNull();
  });

  it('миниатюра строится — заглушка; не построилась — плашка с номером', () => {
    const { snapshot, pass } = running(2, 2);
    render(<ScanScreen snapshot={snapshot} pass={pass} onStop={vi.fn()} />);

    // Обе грузятся: карточки с aria-busy.
    const first = screen.getByAltText('Страница 1');
    const second = screen.getByAltText('Страница 2');
    expect(first.closest('[aria-busy="true"]')).not.toBeNull();

    fireEvent.load(first);
    expect(first.closest('[aria-busy="true"]')).toBeNull();

    fireEvent.error(second);
    const failed = screen.getByTitle('Миниатюру построить не удалось — сама страница на месте');
    expect(failed.textContent).toBe('2');
  });

  it('ожидание занятости показывает текст и оставляет «Остановить»', () => {
    const { snapshot, pass } = running(3, 3, 'busy');
    render(<ScanScreen snapshot={snapshot} pass={pass} onStop={vi.fn()} />);

    expect(screen.getByRole('status').textContent).toBe('Сканер занят — ждём, пока освободится');
    expect(screen.getByText('обычно это другое задание на сканере · ждём до минуты')).toBeDefined();
    const stop = screen.getByRole('button', { name: 'Остановить' });
    expect(stop.hasAttribute('disabled')).toBe(false);
  });

  it('досканирование с 17 страниц показывает 18 на первой новой', () => {
    const pass: PassProgress = { phase: 'scanning', resumed: true, params: PARAMS, pages: 1 };
    const snapshot = makeSnapshot({
      pass,
      session: {
        id: 'session.x',
        passes: [
          { number: 1, state: 'running', paramsKnown: true, scanner: null, pages: pages(18) },
        ],
      },
    });
    render(<ScanScreen snapshot={snapshot} pass={pass} onStop={vi.fn()} />);

    expect(screen.getByRole('status').textContent).toBe('Отсканировано 18');
    expect(
      screen.getByText('досканируем проход 1 · до обрыва было 17 · 300 dpi · оттенки серого · A4'),
    ).toBeDefined();
  });

  it('до досканирования лента начинается с прежних страниц прерванного прохода', () => {
    const pass: PassProgress = { phase: 'starting', resumed: true, params: PARAMS, pages: 0 };
    const snapshot = makeSnapshot({
      pass,
      session: {
        id: 'session.x',
        passes: [
          { number: 1, state: 'interrupted', paramsKnown: true, scanner: null, pages: pages(17) },
        ],
      },
    });
    render(<ScanScreen snapshot={snapshot} pass={pass} onStop={vi.fn()} />);

    expect(screen.getByAltText('Страница 17')).toBeDefined();
    expect(screen.getByAltText('Страница 13')).toBeDefined();
  });

  it('«Остановить» отправляет команду один раз и блокируется до ответа', () => {
    const onStop = vi.fn();
    const { snapshot, pass } = running(3, 3);
    render(<ScanScreen snapshot={snapshot} pass={pass} onStop={onStop} />);

    const stop = screen.getByRole('button', { name: 'Остановить' });
    fireEvent.click(stop);
    fireEvent.click(stop);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Останавливаем…' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('фаза stopping блокирует кнопку и уводит фокус на экран', () => {
    const { snapshot, pass } = running(3, 3, 'stopping');
    render(<ScanScreen snapshot={snapshot} pass={pass} onStop={vi.fn()} />);

    const stop = screen.getByRole('button', { name: 'Останавливаем…' });
    expect(stop.hasAttribute('disabled')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('потерянная прежняя страница в ленте — номер со своей подписью', () => {
    const pass: PassProgress = { phase: 'scanning', resumed: true, params: PARAMS, pages: 1 };
    const snapshot = makeSnapshot({
      pass,
      session: {
        id: 'session.x',
        passes: [
          {
            number: 1,
            state: 'running',
            paramsKnown: true,
            scanner: null,
            pages: [{ key: 'p01-s01-0001', number: 1, lost: true }, ...pages(2, 2)],
          },
        ],
      },
    });
    render(<ScanScreen snapshot={snapshot} pass={pass} onStop={vi.fn()} />);

    expect(screen.getByTitle('Страница 1, файл потерян').textContent).toBe('1');
  });
});
