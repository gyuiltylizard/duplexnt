import { EMPTY_EDITS } from '@shared';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import {
  applied,
  ctrlZ,
  dataTransfer,
  dragAndDrop,
  dragOver,
  edits,
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

// Экран `editor`, M3 U8 (handoff M3, S1–S3, S5–S7, S14; KTD-8): перетаскивание, границы
// документов, имена, плашка правок и полный откат. DnD — самодельный `dataTransfer` и
// `fireEvent`; решающая логика — жесты `state/edits.ts` под табличными тестами. Снимок с
// результатом команды тест подаёт сам (`applied`) — ленту считает ядро (KTD-2).

// Лента двусторонней фикстуры (AE1): 1л, 1о, 2л, 2о, 3л, 3о.
const F1 = 'p01-s01-0001';
const B3 = 'p02-s01-0003';
const F2 = 'p01-s01-0002';
const B2 = 'p02-s01-0002';
const F3 = 'p01-s01-0003';
const B1 = 'p02-s01-0001';

const button = (name: string): HTMLElement => screen.getByRole('button', { name });

/** Split-бар миниатюры: вне дерева доступности (`aria-hidden`) — по классу. */
const splitBar = (index: number): HTMLElement => {
  const bar = option(index).querySelector<HTMLElement>('.thumb__split');
  if (bar === null) {
    throw new Error(`нет split-бара у миниатюры ${String(index)}`);
  }
  return bar;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('editor M3: перетаскивание (S6)', () => {
  it('бросок после страницы: маркер по правой половине, один setEdits, выделение на перенесённой', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);

    expect(option(0).getAttribute('draggable')).toBe('true');
    const transfer = dataTransfer();
    fireEvent.dragStart(option(0), { dataTransfer: transfer });
    expect(option(0).className).toContain('thumb--dragging');
    expect(transfer.effectAllowed).toBe('move');

    dragOver(option(2), 'after', transfer);
    expect(option(2).querySelector('.thumb__drop--after')).not.toBeNull();
    expect(transfer.dropEffect).toBe('move');
    // Курсор перешёл в левую половину — маркер «перед».
    dragOver(option(2), 'before', transfer);
    expect(option(2).querySelector('.thumb__drop--before')).not.toBeNull();
    expect(option(2).querySelector('.thumb__drop--after')).toBeNull();

    dragOver(option(2), 'after', transfer);
    fireEvent.drop(option(2), { dataTransfer: transfer });
    fireEvent.dragEnd(option(0), { dataTransfer: transfer });
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ order: [B3, F2, F1, B2, F3, B1] }),
      rotate180: false,
    });
    expect(document.querySelector('.thumb--dragging')).toBeNull();
    expect(document.querySelector('.thumb__drop')).toBeNull();

    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(option(2).getAttribute('data-key')).toBe(F1);
    expect(selectedKeys()).toEqual([F1]);
    expect(screen.getByText('3 из 6')).toBeDefined();
  });

  it('группа едет целиком с внутренним порядком ленты; выделение — она же на новом месте', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);

    // Выделены 1о и 2о (не подряд), текущая — 2о.
    fireEvent.click(option(1));
    fireEvent.click(option(3), { ctrlKey: true });
    dragAndDrop(option(3), option(0), 'before');
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ order: [B3, B2, F1, F2, F3, B1] }),
      rotate180: false,
    });

    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(selectedKeys()).toEqual([B3, B2]);
    // Текущая осталась прежней — превью не прыгает на другую страницу группы.
    expect(screen.getByText('2 из 6')).toBeDefined();
  });

  it('тянут невыделенную — выделение переходит на неё, едет только она', () => {
    const api = stubApi();
    renderEditor(twoPass());

    fireEvent.click(option(0));
    fireEvent.click(option(1), { shiftKey: true });
    const transfer = dataTransfer();
    fireEvent.dragStart(option(4), { dataTransfer: transfer });
    expect(selectedKeys()).toEqual([F3]);
    expect(document.querySelectorAll('.thumb--dragging').length).toBe(1);

    dragOver(option(0), 'before', transfer);
    fireEvent.drop(option(0), { dataTransfer: transfer });
    expect(lastSent(api).edits.order).toEqual([F3, F1, B3, F2, B2, B1]);
  });

  it('бросок внутрь выделения и на исходное место — ни маркера, ни шага', () => {
    const api = stubApi();
    renderEditor(twoPass());

    fireEvent.click(option(1));
    fireEvent.click(option(2), { shiftKey: true });
    const transfer = dataTransfer();
    fireEvent.dragStart(option(1), { dataTransfer: transfer });
    expect(document.querySelectorAll('.thumb--dragging').length).toBe(2);
    dragOver(option(2), 'after', transfer);
    expect(document.querySelector('.thumb__drop')).toBeNull();
    fireEvent.drop(option(2), { dataTransfer: transfer });
    fireEvent.dragEnd(option(1), { dataTransfer: transfer });

    // Перед соседом справа — то же место.
    dragAndDrop(option(1), option(3), 'before');
    expect(api.setEdits).not.toHaveBeenCalled();
  });

  it('уход из ленты гасит маркер, отпускание без броска (Esc, вне ленты) — отмена', () => {
    const api = stubApi();
    renderEditor(twoPass());

    const transfer = dataTransfer();
    fireEvent.dragStart(option(0), { dataTransfer: transfer });
    dragOver(option(3), 'after', transfer);
    const scroll = option(3).closest('.rail__scroll');
    if (scroll === null) {
      throw new Error('нет ленты');
    }
    fireEvent.dragLeave(scroll, { dataTransfer: transfer, relatedTarget: document.body });
    expect(document.querySelector('.thumb__drop')).toBeNull();
    fireEvent.dragEnd(option(0), { dataTransfer: transfer });

    expect(document.querySelector('.thumb--dragging')).toBeNull();
    expect(api.setEdits).not.toHaveBeenCalled();
  });

  it('AE5: перенос через разрез — сторона броска решает документ, разрез на месте', () => {
    const api = stubApi();
    const cut = applied(twoPass(), {
      edits: edits({ cuts: [2], names: ['', ''] }),
      rotate180: false,
    });
    renderEditor(cut);

    // «После последней страницы документа 1» — 2о остаётся в нём: разрез сдвигается за неё.
    dragAndDrop(option(3), option(1), 'after');
    expect(lastSent(api).edits).toEqual(
      edits({ order: [F1, B3, B2, F2, F3, B1], cuts: [3], names: ['', ''] }),
    );
  });

  it('AE5: «перед первой страницей следующего» — страница уходит в следующий документ', () => {
    const api = stubApi();
    const cut = applied(twoPass(), {
      edits: edits({ cuts: [2], names: ['', ''] }),
      rotate180: false,
    });
    renderEditor(cut);

    dragAndDrop(option(0), option(2), 'before');
    expect(lastSent(api).edits).toEqual(
      edits({ order: [B3, F1, F2, B2, F3, B1], cuts: [1], names: ['', ''] }),
    );
  });

  it('перенос включает ручной порядок: плашка правок и пункт ПРОВЕРКИ', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);
    expect(screen.queryByText('Есть ручные правки')).toBeNull();

    dragAndDrop(option(0), option(5), 'after');
    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(screen.getByText('Есть ручные правки')).toBeDefined();
    expect(screen.getByText('Порядок правили вручную — автосортировка отключена')).toBeDefined();
  });

  it('AE3: только поворот — плашка есть, автосортировка не тронута', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);

    fireEvent.click(button('Повернуть на 90° по часовой'));
    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(screen.getByText('Есть ручные правки')).toBeDefined();
    expect(screen.getByText('Порядок соответствует сканированию')).toBeDefined();
    expect(lastSent(api).edits.order).toEqual([]);
  });

  it('пока команда в полёте, миниатюры не тянутся и split-баров нет', () => {
    stubApi();
    renderEditor(twoPass());

    expect(option(1).querySelector('.thumb__split')).not.toBeNull();
    fireEvent.click(button('Повернуть на 90° по часовой'));
    expect(option(0).getAttribute('draggable')).toBe('false');
    expect(document.querySelector('.thumb__split')).toBeNull();
  });
});

describe('editor M3: границы документов (S1, S2, S5, S7)', () => {
  it('split-бар: у всех, кроме первой; клик ставит границу без выбора страницы, фокус — в имя нового', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);

    expect(option(0).querySelector('.thumb__split')).toBeNull();
    const bar = splitBar(2);
    expect(bar.textContent).toBe('+ Новый документ');
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(bar.getAttribute('tabindex')).toBe('-1');

    fireEvent.click(bar);
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ cuts: [2], names: ['', ''] }),
      rotate180: false,
    });
    expect(selectedKeys()).toEqual([F1]);

    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(screen.getAllByRole('listbox').length).toBe(2);
    expect(document.activeElement).toBe(nameField(2));
    expect(nameField(2).placeholder).toBe('Документ 2');
  });

  it('split-бар «⤺ Убрать границу» у страницы с границей снимает её; Ctrl+Z ставит обратно', async () => {
    const api = stubApi();
    const cut = applied(twoPass(), {
      edits: edits({ cuts: [2], names: ['Акт', 'Опись'] }),
      rotate180: false,
    });
    const { rerender } = renderEditor(cut);

    const bar = splitBar(2);
    expect(bar.className).toContain('thumb__split--remove');
    expect(bar.textContent).toBe('⤺ Убрать границу');
    fireEvent.click(bar);
    // Имя документа уходит вместе с границей (R12).
    expect(lastSent(api).edits).toEqual(edits({ names: ['Акт'] }));

    await settle();
    const merged = applied(cut, lastSent(api));
    rerender(merged);
    expect(screen.getAllByRole('listbox').length).toBe(1);

    ctrlZ();
    expect(lastSent(api).edits).toEqual(edits({ cuts: [2], names: ['Акт', 'Опись'] }));
  });

  it('S1: кнопка тулбара — для текущей не первой страницы без границы перед ней', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);
    const toolbar = screen.getByRole('banner');
    const splitHere = () =>
      within(toolbar).queryByRole('button', { name: '+ Новый документ с этой страницы' });

    // Первая страница ленты — кнопки нет.
    expect(splitHere()).toBeNull();
    fireEvent.click(option(3));
    fireEvent.click(
      within(toolbar).getByRole('button', { name: '+ Новый документ с этой страницы' }),
    );
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ cuts: [3], names: ['', ''] }),
      rotate180: false,
    });

    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(document.activeElement).toBe(nameField(2));
    // Перед текущей граница уже стоит — кнопки нет.
    fireEvent.click(option(3));
    expect(splitHere()).toBeNull();
    expect(within(toolbar).getByText('документ 2 из 2 · стр. 1 из 3')).toBeDefined();
  });

  it('S2: «✕» в разделителе снимает границу вместе с именем документа', () => {
    const api = stubApi();
    renderEditor(
      applied(twoPass(), {
        edits: edits({ cuts: [2, 4], names: ['Акт', 'Опись', ''] }),
        rotate180: false,
      }),
    );

    expect(
      screen.getAllByTitle('Убрать границу — присоединить к предыдущему документу').length,
    ).toBe(
      2 + 2, // два «✕» и два split-бара «⤺» у первых страниц документов
    );
    fireEvent.click(button('Убрать границу перед документом 2'));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ cuts: [4], names: ['Акт', ''] }),
      rotate180: false,
    });
  });

  it('S5: «Выделить в документ» — подряд: две границы одним шагом, тост, фокус в имя нового', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { onToast, rerender } = renderEditor(snapshot);

    fireEvent.click(option(1));
    fireEvent.click(option(2), { shiftKey: true });
    fireEvent.click(button('Выделить в документ'));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ cuts: [1, 3], names: ['', '', ''] }),
      rotate180: false,
    });
    await settle();
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Отдельный документ из 2 стр. создан');

    rerender(applied(snapshot, lastSent(api)));
    expect(screen.getAllByRole('listbox').length).toBe(3);
    expect(document.activeElement).toBe(nameField(2));
    // Граница — не страницы: выделение не тронуто.
    expect(selectedKeys()).toEqual([B3, F2]);
  });

  it('S5: выделение не подряд — тост, ничего не меняется', () => {
    const api = stubApi();
    const { onToast } = renderEditor(twoPass());

    fireEvent.click(option(1));
    fireEvent.click(option(3), { ctrlKey: true });
    fireEvent.click(button('Выделить в документ'));
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Выделите подряд идущие страницы');
    expect(api.setEdits).not.toHaveBeenCalled();
  });
});

describe('editor M3: имя документа (S3)', () => {
  it('ввод по буквам локален; Enter — один setEdits; уход фокуса после него ничего не шлёт', async () => {
    const api = stubApi();
    const snapshot = makeSnapshot([makePass({ pages: pages(3) })]);
    const { rerender } = renderEditor(snapshot);
    const field = nameField(1);
    expect(field.placeholder).toMatch(/^Скан \d{4}-\d{2}-\d{2}$/u);

    field.focus();
    for (const value of ['А', 'Ак', 'Акт']) {
      fireEvent.change(field, { target: { value } });
    }
    expect(api.setEdits).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: 'Enter' });
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ names: ['Акт'] }),
      rotate180: false,
    });
    // До снимка поле показывает отправленное, а не прежнее.
    expect(field.value).toBe('Акт');
    expect(document.activeElement).toBe(field);
    fireEvent.blur(field);
    expect(api.setEdits).toHaveBeenCalledTimes(1);

    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(nameField(1).value).toBe('Акт');
    expect(within(screen.getByRole('banner')).getByText('Акт')).toBeDefined();
  });

  it('уход фокуса фиксирует; без изменений — ничего не шлётся', () => {
    const api = stubApi();
    renderEditor(twoPass());
    const field = nameField(1);

    field.focus();
    fireEvent.blur(field);
    fireEvent.change(field, { target: { value: 'Акт' } });
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.blur(field);
    expect(api.setEdits).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: 'Опись' } });
    fireEvent.blur(field);
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ names: ['Опись'] }),
      rotate180: false,
    });
  });

  it('Esc — прежнее значение, фокус в поле, выделение ленты не сжимается', () => {
    const api = stubApi();
    renderEditor(applied(twoPass(), { edits: edits({ names: ['Акт'] }), rotate180: false }));
    fireEvent.click(option(0));
    fireEvent.click(option(2), { shiftKey: true });
    const field = nameField(1);

    field.focus();
    fireEvent.change(field, { target: { value: 'Черновик' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field.value).toBe('Акт');
    expect(document.activeElement).toBe(field);
    expect(selectedKeys()).toEqual([F1, B3, F2]);
    fireEvent.blur(field);
    expect(api.setEdits).not.toHaveBeenCalled();
  });

  it('Ctrl+Z в поле — текстовый: ленточный undo не срабатывает', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);
    fireEvent.click(button('Повернуть на 90° по часовой'));
    await settle();
    rerender(applied(snapshot, lastSent(api)));

    nameField(1).focus();
    ctrlZ(nameField(1));
    expect(api.setEdits).toHaveBeenCalledTimes(1);
  });

  it('новый снимок с другим именем — поле не в фокусе показывает его', () => {
    stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);

    rerender(applied(snapshot, { edits: edits({ names: ['Договор'] }), rotate180: false }));
    expect(nameField(1).value).toBe('Договор');
  });
});

describe('editor M3: плашка правок и полный откат (S14)', () => {
  /** Снимок с правками и включённым тумблером 180°. */
  const editedState = {
    edits: edits({
      order: [B3, F1, F2, B2, F3, B1],
      rotations: { [F2]: 90 },
      cuts: [3],
      names: ['', 'Опись'],
    }),
    rotate180: true,
  } as const;

  it('без правок плашки нет', () => {
    stubApi();
    renderEditor(twoPass());
    expect(screen.queryByText('Есть ручные правки')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Вернуть' })).toBeNull();
  });

  it('тумблер 180° — тоже правка: плашка видна', () => {
    stubApi();
    renderEditor(applied(twoPass(), { edits: EMPTY_EDITS, rotate180: true }));
    expect(screen.getByText('Есть ручные правки')).toBeDefined();
  });

  it('«Вернуть» → подтверждение: «Отмена» ничего не шлёт, клавиши редактора не работают', () => {
    const api = stubApi();
    renderEditor(applied(twoPass(), editedState));

    const revert = button('Вернуть');
    expect(revert.getAttribute('title')).toBe('Вернуть всё как после сканирования');
    revert.focus();
    fireEvent.click(revert);
    const dialog = screen.getByRole('dialog', { name: 'Вернуть всё как после сканирования?' });
    expect(dialog.getAttribute('aria-describedby')).toBe('revert-text');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Отмена' }));

    ctrlZ(dialog);
    fireEvent.keyDown(dialog, { key: 'Delete' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.setEdits).not.toHaveBeenCalled();
  });

  it('AE4: «Вернуть всё» — пустые правки и выключенный тумблер одним шагом; Ctrl+Z возвращает всё', async () => {
    const api = stubApi();
    const edited = applied(twoPass(), editedState);
    const { onToast, rerender } = renderEditor(edited);

    fireEvent.click(button('Вернуть'));
    fireEvent.click(button('Вернуть всё'));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({ edits: EMPTY_EDITS, rotate180: false });
    expect(screen.queryByRole('dialog')).toBeNull();
    await settle();
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Всё возвращено как после сканирования');

    rerender(applied(edited, lastSent(api)));
    expect(screen.queryByText('Есть ручные правки')).toBeNull();
    // Плашка исчезла — фокус клавиатуры на текущей странице, а не на body.
    expect(document.activeElement?.getAttribute('role')).toBe('option');

    ctrlZ();
    expect(api.setEdits).toHaveBeenCalledTimes(2);
    expect(lastSent(api)).toEqual(editedState);
  });
});
