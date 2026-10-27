import { EMPTY_EDITS, type BlankVerdicts } from '@shared';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import {
  applied,
  B1,
  B2,
  B3,
  ctrlZ,
  edits,
  F1,
  F2,
  F3,
  lastSent,
  makePass,
  makeSnapshot,
  nameField,
  option,
  pages,
  renderEditor,
  selectedKeys,
  settle,
  stubApi,
  twoPass,
} from './editor-fixture';

// Экран `editor`, M4 U7 (handoff M4, S4–S6; KTD7; R18–R19): подвал ленты с панелью выделения
// вместо панели над лентой и «Выделить в документ» для любого выделения — подряд (как в M3 S5)
// и не подряд (перенос + границы одним шагом). Случаи панели M3 из `EditorScreen.dnd.test.tsx`
// переехали сюда. Снимок с результатом команды тест подаёт сам (`applied`).

const button = (name: string): HTMLElement => screen.getByRole('button', { name });
const rail = (): HTMLElement =>
  screen.getByRole('complementary', { name: 'Отсканированные страницы' });
const footer = (): HTMLElement | null => rail().querySelector<HTMLElement>('.rail__footer');
const panel = (): HTMLElement | null => screen.queryByRole('region', { name: 'Выделение' });

// Лента AE1: F1, B3, F2, B2, F3, B1. Пустые обороты — B3 (хвост F1) и B1 (хвост F3).
const VERDICTS: BlankVerdicts = new Map([
  [B1, true],
  [B2, false],
  [B3, true],
]);

const hideSnapshot = (blank: BlankVerdicts = VERDICTS) =>
  makeSnapshot(
    [
      makePass({ pages: pages(3) }),
      makePass({ number: 2, kind: 'backs', pages: pages(3, 1, 'p02-s01') }),
    ],
    {},
    { blankMode: 'hide' },
    blank,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('подвал ленты (S4–S6, R18)', () => {
  it('панель выделения — в подвале под лентой, панели над лентой нет; одна выделенная — панели нет', () => {
    stubApi();
    renderEditor(twoPass());

    expect(panel()).toBeNull();
    expect(rail().querySelector('.rail__top')).toBeNull();
    // Проход оборотов есть — подвал с тумблером 180° на месте и без выделения.
    expect(footer()?.querySelectorAll('.toggle-row').length).toBe(1);

    fireEvent.click(option(1));
    fireEvent.click(option(3), { shiftKey: true });
    const region = panel();
    expect(region).not.toBeNull();
    expect(region?.closest('.rail__footer')).toBe(footer());
    // Порядок строк: панель → тумблер; лента (`rail__scroll`) — над подвалом.
    const children = [...rail().children].map((child) => child.className);
    expect(children).toEqual(['rail__scroll', 'rail__footer']);
    expect([...(footer()?.children ?? [])].map((child) => child.className)).toEqual([
      'rail__selection',
      'toggle-row',
    ]);
    expect(within(region ?? document.body).getByText('Выделено 3 стр.')).toBeDefined();
  });

  it('без прохода оборотов подвала нет, пока нет выделения; с выделением — только панель', () => {
    stubApi();
    renderEditor(makeSnapshot([makePass({ pages: pages(3) })]));

    expect(footer()).toBeNull();
    fireEvent.click(option(0));
    fireEvent.click(option(1), { shiftKey: true });
    expect([...(footer()?.children ?? [])].map((child) => child.className)).toEqual([
      'rail__selection',
    ]);
    expect(screen.queryByRole('checkbox')).toBeNull();

    // B-8: «Снять» нет — Esc с кнопки панели сжимает выделение, фокус уходит на текущую, а не
    // пропадает вместе с панелью.
    expect(screen.queryByRole('button', { name: 'Снять' })).toBeNull();
    button('Выделить в документ').focus();
    fireEvent.keyDown(button('Выделить в документ'), { key: 'Escape' });
    expect(footer()).toBeNull();
    expect(selectedKeys()).toEqual([F2]);
    expect(document.activeElement).toBe(option(1));
  });

  it('режим «Скрывать»: панель → переключатель → тумблер; при `found = 0` переключатель недоступен с подписью', () => {
    stubApi();
    renderEditor(hideSnapshot());

    expect([...(footer()?.children ?? [])].map((child) => child.className)).toEqual([
      'toggle-row',
      'toggle-row',
    ]);
    fireEvent.click(option(0));
    fireEvent.click(option(1), { shiftKey: true });
    expect([...(footer()?.children ?? [])].map((child) => child.className)).toEqual([
      'rail__selection',
      'toggle-row',
      'toggle-row',
    ]);
    expect(screen.getByText('скрыто: 2')).toBeDefined();

    cleanup();
    stubApi();
    renderEditor(
      hideSnapshot(
        new Map([
          [B1, false],
          [B2, false],
          [B3, false],
        ]),
      ),
    );
    const toggle = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Показать скрытые пустые обороты в ленте — в файл они не попадут',
    });
    expect(toggle.disabled).toBe(true);
    expect(toggle.closest('.toggle-row')?.className).toContain('toggle-row--disabled');
    expect(screen.getByText('не найдено')).toBeDefined();
  });
});

describe('«Выделить в документ» (S6, KTD7, R19)', () => {
  it('подряд: две границы одним шагом, порядок не трогается, тост, фокус в имя нового (M3 S5)', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { onToast, rerender } = renderEditor(snapshot);

    fireEvent.click(option(1));
    fireEvent.click(option(2), { shiftKey: true });
    fireEvent.click(button('Выделить в документ'));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ cuts: [1, 3], names: ['', '', ''] }),
      rotate180: {},
    });
    await settle();
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Отдельный документ из 2 стр. создан');

    rerender(applied(snapshot, lastSent(api)));
    expect(screen.getAllByRole('listbox').length).toBe(3);
    expect(document.activeElement).toBe(nameField(2));
    // Граница — не страницы: выделение не тронуто.
    expect(selectedKeys()).toEqual([B3, F2]);
  });

  it('не подряд: выделенные встают на место первой, остальные вправо, границы до и после — одним шагом; Ctrl+Z выделяет перенесённые', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { onToast, rerender } = renderEditor(snapshot);

    fireEvent.click(option(1));
    fireEvent.click(option(3), { ctrlKey: true });
    expect(selectedKeys()).toEqual([B3, B2]);
    fireEvent.click(button('Выделить в документ'));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ order: [F1, B3, B2, F2, F3, B1], cuts: [1, 3], names: ['', '', ''] }),
      rotate180: {},
    });
    await settle();
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Отдельный документ из 2 стр. создан');

    rerender(applied(snapshot, lastSent(api)));
    expect(screen.getAllByRole('option').map((item) => item.getAttribute('data-key'))).toEqual([
      F1,
      B3,
      B2,
      F2,
      F3,
      B1,
    ]);
    expect(screen.getAllByRole('listbox').length).toBe(3);
    expect(document.activeElement).toBe(nameField(2));
    // Выделение — перенесённые; порядок стал ручным.
    expect(selectedKeys()).toEqual([B3, B2]);
    expect(screen.getByText('Есть ручные правки')).toBeDefined();

    ctrlZ();
    expect(api.setEdits).toHaveBeenLastCalledWith({ edits: EMPTY_EDITS, rotate180: {} });
    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(selectedKeys()).toEqual([B3, B2]);
  });

  it('AE10: скрытые хвосты едут с выделенными, пока переключатель выключен; включён — буквально', async () => {
    const api = stubApi();
    const snapshot = hideSnapshot();
    const { onToast } = renderEditor(snapshot);

    // Показанная лента: F1, F2, B2, F3. Выделены F1 и F3 — с хвостами B3 и B1.
    fireEvent.click(option(0));
    fireEvent.click(option(3), { ctrlKey: true });
    fireEvent.click(button('Выделить в документ'));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ order: [F1, B3, F3, B1, F2, B2], cuts: [4], names: ['', ''] }),
      rotate180: {},
    });
    await settle();
    // Число в тосте — по показанным.
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Отдельный документ из 2 стр. создан');

    cleanup();
    const literal = stubApi();
    renderEditor(hideSnapshot());
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Показать скрытые пустые обороты в ленте — в файл они не попадут',
      }),
    );
    // Полная лента: F1, B3, F2, B2, F3, B1 — выделены F1 и F3 без хвостов.
    fireEvent.click(option(0));
    fireEvent.click(option(4), { ctrlKey: true });
    fireEvent.click(button('Выделить в документ'));
    expect(literal.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ order: [F1, F3, B3, F2, B2, B1], cuts: [2], names: ['', ''] }),
      rotate180: {},
    });
  });

  it('режим наборов: панель — только текст, без кнопок и пустой обёртки кнопок', () => {
    stubApi();
    renderEditor(twoPass(2));

    fireEvent.click(option(0));
    fireEvent.click(option(1), { shiftKey: true });
    const region = screen.getByRole('region', { name: 'Выделение' });
    expect(within(region).queryAllByRole('button')).toEqual([]);
    expect([...region.children].map((child) => child.className)).toEqual(['rail__selection-text']);
  });
});
