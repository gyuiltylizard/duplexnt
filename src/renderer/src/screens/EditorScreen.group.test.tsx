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
// вместо панели над лентой и «Выделить в документ» для любого выделения. С B-14 команда
// извлекает выделенные в отдельный документ в конце ленты (перенос + граница одним шагом),
// исходный документ остаётся одним. Случаи панели M3 из `EditorScreen.dnd.test.tsx` переехали
// сюда. Снимок с результатом команды тест подаёт сам (`applied`).

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
      'rail__toggles',
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

  it('режим «Скрывать», B-8: «Пустые» и «Обороты на 180°» одной строкой, без видимых подписей', () => {
    stubApi();
    renderEditor(hideSnapshot());
    const blankToggle = (): HTMLInputElement =>
      screen.getByRole<HTMLInputElement>('checkbox', {
        name: 'Показать скрытые пустые обороты в ленте — в файл они не попадут',
      });
    const rotateToggle = (): HTMLInputElement =>
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Обороты на 180°' });

    expect([...(footer()?.children ?? [])].map((child) => child.className)).toEqual([
      'rail__toggles',
    ]);
    const row = footer()?.querySelector('.rail__toggles');
    expect([...(row?.children ?? [])].map((child) => child.textContent)).toEqual([
      'Пустыескрыто: 2',
      'Обороты на 180°обороты основного документа',
    ]);
    // Счётчик и цель — скрытые описания чекбоксов, сведения — и в `title` строки.
    expect(blankToggle().getAttribute('aria-describedby')).toBe('blank-count');
    expect(document.getElementById('blank-count')?.className).toBe('visually-hidden');
    expect(document.getElementById('blank-count')?.textContent).toBe('скрыто: 2');
    expect(blankToggle().closest('.toggle-row')?.getAttribute('title')).toBe(
      'Скрыто 2 пустых оборота — в файл не попадут. Включите, чтобы увидеть их в ленте.',
    );
    expect(document.getElementById('rotate-target')?.className).toBe('visually-hidden');
    expect(rotateToggle().closest('.toggle-row')?.getAttribute('title')).toMatch(
      /^Действует на обороты основного документа\. Если обороты вверх ногами/u,
    );

    fireEvent.click(blankToggle());
    expect(document.getElementById('blank-count')?.textContent).toBe('показано: 2');
    expect(blankToggle().closest('.toggle-row')?.getAttribute('title')).toMatch(
      /^Показано 2 пустых оборота — в файл не попадут\./u,
    );

    fireEvent.click(option(0));
    fireEvent.click(option(1), { shiftKey: true });
    expect([...(footer()?.children ?? [])].map((child) => child.className)).toEqual([
      'rail__selection',
      'rail__toggles',
    ]);
  });

  it('`found = 0` и оценки идут: «Пустые» недоступен, описание и `title` — почему', () => {
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
    expect(document.getElementById('blank-count')?.textContent).toBe('не найдено');
    expect(toggle.closest('.toggle-row')?.getAttribute('title')).toBe('Пустых оборотов не найдено');

    cleanup();
    stubApi();
    renderEditor(hideSnapshot(new Map()));
    expect(document.getElementById('blank-count')?.textContent).toBe('оцениваются…');
    expect(
      document.getElementById('blank-count')?.closest('.toggle-row')?.getAttribute('title'),
    ).toBe('Пустые обороты ещё оцениваются');
  });

  it('режим наборов: в строке только тумблер 180°', () => {
    stubApi();
    renderEditor(twoPass(2));

    expect(footer()?.querySelector('.rail__toggles')?.querySelectorAll('.toggle-row').length).toBe(
      1,
    );
    expect(screen.queryByRole('checkbox', { name: /пустые/u })).toBeNull();
  });
});

describe('«Выделить в документ» (S6, KTD7, R19; B-14)', () => {
  it('подряд из середины: кусок уезжает в конец ленты, исходный документ остаётся одним; тост, фокус в имя нового; Ctrl+Z возвращает', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { onToast, rerender } = renderEditor(snapshot);

    fireEvent.click(option(1));
    fireEvent.click(option(2), { shiftKey: true });
    fireEvent.click(button('Выделить в документ'));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ order: [F1, B2, F3, B1, B3, F2], cuts: [4], names: ['', ''] }),
      rotate180: {},
    });
    await settle();
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Отдельный документ из 2 стр. создан');

    rerender(applied(snapshot, lastSent(api)));
    expect(screen.getAllByRole('option').map((item) => item.getAttribute('data-key'))).toEqual([
      F1,
      B2,
      F3,
      B1,
      B3,
      F2,
    ]);
    // Два документа, не три: исходный без извлечённых и новый в конце.
    expect(screen.getAllByRole('listbox').length).toBe(2);
    expect(document.activeElement).toBe(nameField(2));
    // Выделение — перенесённые; порядок стал ручным.
    expect(selectedKeys()).toEqual([B3, F2]);
    expect(screen.getByText('Есть ручные правки')).toBeDefined();

    ctrlZ();
    expect(api.setEdits).toHaveBeenLastCalledWith({ edits: EMPTY_EDITS, rotate180: {} });
    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(selectedKeys()).toEqual([B3, F2]);
  });

  it('не подряд: выделенные уезжают в конец ленточным порядком, остальные смыкаются — одним шагом', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { onToast, rerender } = renderEditor(snapshot);

    fireEvent.click(option(1));
    fireEvent.click(option(3), { ctrlKey: true });
    expect(selectedKeys()).toEqual([B3, B2]);
    fireEvent.click(button('Выделить в документ'));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ order: [F1, F2, F3, B1, B3, B2], cuts: [4], names: ['', ''] }),
      rotate180: {},
    });
    await settle();
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Отдельный документ из 2 стр. создан');

    rerender(applied(snapshot, lastSent(api)));
    expect(screen.getAllByRole('listbox').length).toBe(2);
    expect(document.activeElement).toBe(nameField(2));
    expect(selectedKeys()).toEqual([B3, B2]);
  });

  it('кусок уже в конце ленты: только граница, порядок не становится ручным, выделение не тронуто', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);

    fireEvent.click(option(4));
    fireEvent.click(option(5), { shiftKey: true });
    fireEvent.click(button('Выделить в документ'));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ cuts: [4], names: ['', ''] }),
      rotate180: {},
    });
    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(screen.getAllByRole('listbox').length).toBe(2);
    expect(document.activeElement).toBe(nameField(2));
    expect(selectedKeys()).toEqual([F3, B1]);

    // Повторно на уже отдельном документе в конце — жеста нет.
    fireEvent.click(button('Выделить в документ'));
    expect(api.setEdits).toHaveBeenCalledTimes(1);
  });

  it('AE10 плана M4 / B-13: склеенные обороты едут с выделенными лицами и при скрытых, и при показанных', async () => {
    const api = stubApi();
    const snapshot = hideSnapshot();
    const { onToast } = renderEditor(snapshot);

    // Показанная лента: F1, F2, B2, F3. Выделены F1 и F3 — с хвостами B3 и B1; исходный документ
    // остаётся из F2 и B2, извлечённые — за ними.
    fireEvent.click(option(0));
    fireEvent.click(option(3), { ctrlKey: true });
    fireEvent.click(button('Выделить в документ'));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ order: [F2, B2, F1, B3, F3, B1], cuts: [2], names: ['', ''] }),
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
    // Полная лента: F1, B3, F2, B2, F3, B1 — выделены F1 и F3, обороты B3 и B1 идут с ними (B-13).
    fireEvent.click(option(0));
    fireEvent.click(option(4), { ctrlKey: true });
    fireEvent.click(button('Выделить в документ'));
    expect(literal.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ order: [F2, B2, F1, B3, F3, B1], cuts: [2], names: ['', ''] }),
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
