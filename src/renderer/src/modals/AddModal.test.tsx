import type { AssembledPage, ScannerState } from '@shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import { AddModal, anchorsOf, type AddModalProps } from './AddModal';

// Модалка `add` (план M3.5, U6; handoff M3.5, S2; M4.5, S1–S2): карточки сценариев, место,
// сводка с якорем, строка сканера, «Начать скан» с намерением и якорем из видимой ленты (KTD-8),
// клавиатура радиогрупп, выключенная карточка в режиме раздельных наборов.

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
      mode="pairs"
      current={CURRENT}
      end={DOC_END}
      endKind="document"
      onStart={onStart}
      onClose={onClose}
      {...props}
    />,
  );
  return { onStart, onClose };
}

const radio = (name: string | RegExp): HTMLElement => screen.getByRole('radio', { name });
const twoSided = (): HTMLElement => radio(/Двустороннее сканирование/u);
const oneSided = (): HTMLElement => radio(/Одностороннее сканирование/u);
const summary = (): string => document.querySelector('.add-modal__summary')?.textContent ?? '';
const start = (): HTMLElement => screen.getByRole('button', { name: 'Начать скан' });

afterEach(cleanup);

describe('модалка add: состояние по умолчанию', () => {
  it('S1: «Двустороннее сканирование» и «В конец документа» выбраны (решение автора на приёмке M4.5), сводка называет сценарий и якорь, фокус — «Отмена»', () => {
    renderModal();

    expect(screen.getByRole('dialog', { name: 'Добавить страницы к документу' })).toBeDefined();
    expect(twoSided().getAttribute('aria-checked')).toBe('true');
    expect(oneSided().getAttribute('aria-checked')).toBe('false');
    expect(radio('В конец документа').getAttribute('aria-checked')).toBe('true');
    expect(radio('После текущей страницы').getAttribute('aria-checked')).toBe('false');
    expect(summary()).toBe('Двустороннее · в конец документа «Акт приёма-передачи», после стр. 9');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Отмена' }));
  });

  it('тексты карточек: пара проходов с разворотом и один проход без оборотов; подсказки о ручном обороте нет', () => {
    renderModal();

    expect(
      screen.getByText('Два прохода с разворотом на 180°, как основной документ'),
    ).toBeDefined();
    expect(screen.getByText('Один или несколько листов, обороты не сканируем')).toBeDefined();
    expect(screen.queryByText(/разверните на 180°, как при проходе оборотов/)).toBeNull();
    expect(screen.queryByRole('radio', { name: /Один лист/ })).toBeNull();
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
    fireEvent.click(oneSided());
    fireEvent.click(radio('После текущей страницы'));
    expect(summary()).toBe('Одностороннее · после стр. 7 (оборот листа 4)');
  });
});

describe('модалка add: выбор и сводка', () => {
  it('карточка и место меняют сводку; «В конец документа» называет документ и его последнюю страницу', () => {
    renderModal();

    fireEvent.click(oneSided());
    expect(summary()).toBe('Одностороннее · в конец документа «Акт приёма-передачи», после стр. 9');
    fireEvent.click(radio('После текущей страницы'));
    expect(summary()).toBe('Одностороннее · после стр. 7 (оборот листа 4)');
  });

  it('пустая лента: «После текущей» недоступна с причиной, выбран конец, сводка — «в конец ленты»', () => {
    renderModal({ current: null, end: null });

    const after = radio('После текущей страницы');
    expect(after.getAttribute('aria-disabled')).toBe('true');
    expect(after.getAttribute('title')).toBe('Нет текущей страницы — лента пуста');
    expect(radio('В конец документа').getAttribute('aria-checked')).toBe('true');
    expect(summary()).toBe('Двустороннее · в конец ленты');
    fireEvent.click(after);
    expect(after.getAttribute('aria-checked')).toBe('false');
  });

  it('стрелки переводят выбор и фокус в радиогруппе; недоступный сегмент пропускается', () => {
    renderModal({ current: null, end: null });

    const two = twoSided();
    two.focus();
    fireEvent.keyDown(two, { key: 'ArrowDown' });
    expect(oneSided().getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(oneSided());
    fireEvent.keyDown(oneSided(), { key: 'ArrowUp' });
    expect(twoSided().getAttribute('aria-checked')).toBe('true');

    const end = radio('В конец документа');
    end.focus();
    fireEvent.keyDown(end, { key: 'ArrowRight' });
    expect(end.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(end);
  });

  it('в обходе Tab — только выбранный элемент каждой группы', () => {
    renderModal();

    expect(twoSided().tabIndex).toBe(0);
    expect(oneSided().tabIndex).toBe(-1);
    expect(radio('В конец документа').tabIndex).toBe(0);
    expect(radio('После текущей страницы').tabIndex).toBe(-1);
  });
});

describe('модалка add: запуск и отмена', () => {
  it('«Начать скан» закрывает модалку и зовёт запуск с намерением пары и якорем текущей', () => {
    const { onStart, onClose } = renderModal();

    fireEvent.click(radio('После текущей страницы'));
    fireEvent.click(start());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledExactlyOnceWith('addedFronts', 'p02-s01-0009');
  });

  it('одностороннее — намерение `added`; «В конец документа» — якорь последней страницы; пустая лента — null', () => {
    const first = renderModal();
    fireEvent.click(oneSided());
    fireEvent.click(radio('В конец документа'));
    fireEvent.click(start());
    expect(first.onStart).toHaveBeenCalledExactlyOnceWith('added', 'p01-s01-0005');
    cleanup();

    const second = renderModal({ current: null, end: null });
    fireEvent.click(start());
    expect(second.onStart).toHaveBeenCalledExactlyOnceWith('addedFronts', null);
  });

  it('«Отмена» закрывает без запуска', () => {
    const { onStart, onClose } = renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('фокус заперт: Tab с «Начать скан» — на выбранную карточку, Shift+Tab с неё — на «Начать скан»', () => {
    renderModal();
    // Выбрана вторая карточка: первая в DOM — с tabIndex −1, в кольцо она не входит.
    fireEvent.click(oneSided());

    const button = start();
    button.focus();
    fireEvent.keyDown(button, { key: 'Tab' });
    expect(document.activeElement).toBe(oneSided());
    fireEvent.keyDown(oneSided(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(button);
  });
});

describe('модалка add в режиме наборов (M3.6, KTD11; M4.5, R3; handoff S2, S10)', () => {
  const t = i18n.t.bind(i18n);
  const entry = (
    key: string,
    side: 'front' | 'back',
    sheet: number,
    addedSet: number | null = null,
  ) => ({
    key,
    side,
    sheet,
    angle: 0 as const,
    lost: false,
    addedSet,
    blank: null,
  });
  // Лента f1 f2 f3 | b2 a1 b1: граница 3, добавленный набор в группе оборотов.
  const visible = ['f1', 'f2', 'f3', 'b2', 'a1', 'b1'];
  const sets = { fronts: 3, backs: 3, divider: 3 };
  const document = { name: '', start: 0, count: 6 };

  it('anchorsOf: «В конец» — последняя видимая страница группы текущей, подпись — группа', () => {
    expect(
      anchorsOf(t, {
        entry: entry('f2', 'front', 2),
        index: 1,
        document,
        documentName: 'Скан',
        visible,
        mode: 'sets',
        sets,
      }),
    ).toEqual({
      current: { key: 'f2', page: 2, label: 'лицевая, 2-я в наборе лиц' },
      end: { key: 'f3', page: 3, label: 'лиц' },
      endKind: 'set',
    });
    expect(
      anchorsOf(t, {
        entry: entry('a1', 'back', 2, 1),
        index: 4,
        document,
        documentName: 'Скан',
        visible,
        mode: 'sets',
        sets,
      }),
    ).toEqual({
      current: { key: 'a1', page: 5, label: 'добавленный набор 1, в наборе оборотов' },
      end: { key: 'b1', page: 6, label: 'оборотов' },
      endKind: 'set',
    });
  });

  it('anchorsOf: пустая группа текущей невозможна, а пустая лента — оба якоря null', () => {
    expect(
      anchorsOf(t, {
        entry: undefined,
        index: -1,
        document: { name: '', start: 0, count: 0 },
        documentName: '',
        visible: [],
        mode: 'sets',
        sets: { fronts: 0, backs: 0, divider: 0 },
      }),
    ).toEqual({ current: null, end: null, endKind: 'set' });
  });

  it('anchorsOf: режим пар и собрано — конец документа, как в M3.5; страница пары — с листом набора', () => {
    expect(
      anchorsOf(t, {
        entry: entry('f2', 'front', 2),
        index: 1,
        document: { name: 'Акт', start: 0, count: 2 },
        documentName: 'Акт',
        visible: ['f1', 'f2', 'f3'],
        mode: 'assembled',
        sets: null,
      }),
    ).toEqual({
      current: { key: 'f2', page: 2, label: 'лицо листа 2' },
      end: { key: 'f2', page: 2, label: 'Акт' },
      endKind: 'document',
    });
    expect(
      anchorsOf(t, {
        entry: entry('a1', 'back', 2, 1),
        index: 1,
        document: { name: 'Акт', start: 0, count: 3 },
        documentName: 'Акт',
        visible: ['f1', 'a1', 'f3'],
        mode: 'pairs',
        sets: null,
        origin: 'addedBacks',
      }).current,
    ).toEqual({ key: 'a1', page: 2, label: 'оборот листа 2 набора Д1' });
  });

  it('сегмент «В конец набора», сводка называет группу и последнюю страницу; якорь — её ключ', () => {
    const { onStart } = renderModal({
      mode: 'sets',
      current: { key: 'b2', page: 4, label: 'оборотная, 1-я в наборе оборотов' },
      end: { key: 'b1', page: 6, label: 'оборотов' },
      endKind: 'set',
    });

    expect(screen.queryByRole('radio', { name: 'В конец документа' })).toBeNull();
    expect(radio('В конец набора').getAttribute('aria-checked')).toBe('true');
    expect(summary()).toBe('Одностороннее · в конец набора оборотов, после стр. 6');
    fireEvent.click(radio('После текущей страницы'));
    expect(summary()).toBe('Одностороннее · после стр. 4 (оборотная, 1-я в наборе оборотов)');
    fireEvent.click(radio('В конец набора'));
    fireEvent.click(start());
    expect(onStart).toHaveBeenCalledExactlyOnceWith('added', 'b1');
  });

  it('S2: двусторонняя карточка выключена с причиной, выбрана односторонняя; клик и стрелки её не выбирают', () => {
    renderModal({ mode: 'sets' });

    const two = twoSided();
    expect(two.getAttribute('aria-disabled')).toBe('true');
    expect(two.getAttribute('aria-checked')).toBe('false');
    expect(two.className).toBe('radio-card radio-card--disabled');
    expect(two.tabIndex).toBe(-1);
    const reason = screen.getByText(
      'Недоступно, пока документ не собран — сначала соберите документ',
    );
    expect(two.getAttribute('aria-describedby')).toBe(reason.id);
    expect(
      screen.queryByText('Два прохода с разворотом на 180°, как основной документ'),
    ).toBeNull();
    expect(oneSided().getAttribute('aria-checked')).toBe('true');
    expect(oneSided().tabIndex).toBe(0);

    fireEvent.click(two);
    expect(two.getAttribute('aria-checked')).toBe('false');
    expect(summary()).toMatch(/^Одностороннее · /);
    oneSided().focus();
    fireEvent.keyDown(oneSided(), { key: 'ArrowDown' });
    expect(oneSided().getAttribute('aria-checked')).toBe('true');
    expect(globalThis.document.activeElement).toBe(oneSided());
  });

  it('в режиме «собрано» двусторонняя доступна и выбрана (R3)', () => {
    renderModal({ mode: 'assembled' });

    expect(twoSided().getAttribute('aria-disabled')).toBeNull();
    expect(twoSided().getAttribute('aria-checked')).toBe('true');
  });
});

// M4 (R11–R12; handoff M4, S16): «После текущей» — за скрытым хвостом, номера — по показанной
// ленте.
describe('якоря add при скрытых пустых оборотах (M4)', () => {
  const t = i18n.t.bind(i18n);
  it('anchorsOf: after подменяет ключ якоря, numberOf — номера страниц', () => {
    const entry = (key: string, side: 'front' | 'back', sheet: number): AssembledPage => ({
      key,
      side,
      sheet,
      angle: 0,
      lost: false,
      addedSet: null,
      blank: null,
    });
    const visible = ['f1', 'b1', 'f2'];
    const shown = ['f1', 'f2'];
    expect(
      anchorsOf(t, {
        entry: entry('f1', 'front', 1),
        index: 0,
        document: { name: 'Скан', start: 0, count: 3 },
        documentName: 'Скан',
        visible,
        mode: 'pairs',
        sets: null,
        after: 'b1',
        numberOf: (key) => shown.indexOf(key) + 1,
      }),
    ).toEqual({
      current: { key: 'b1', page: 1, label: 'лицо листа 1' },
      end: { key: 'f2', page: 2, label: 'Скан' },
      endKind: 'document',
    });
  });
});
