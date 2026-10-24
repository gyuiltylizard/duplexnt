import { EMPTY_EDITS, ok } from '@shared';
import { cleanup, createEvent, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import {
  deferredSetEdits,
  applied,
  B1,
  B2,
  B3,
  ctrlZ,
  dataTransfer,
  dragAndDrop,
  dragOver,
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

// Экран `editor`, M3 U8 (handoff M3, S1–S3, S5–S7, S14; KTD-8): перетаскивание, границы
// документов, имена, плашка правок и полный откат. DnD — самодельный `dataTransfer` и
// `fireEvent`; решающая логика — жесты `state/edits.ts` под табличными тестами. Снимок с
// результатом команды тест подаёт сам (`applied`) — ленту считает ядро (KTD-2).

const button = (name: string): HTMLElement => screen.getByRole('button', { name });

/** Split-бар миниатюры: вне дерева доступности (`aria-hidden`) — по классу. */
const splitBar = (index: number): HTMLElement => {
  const bar = option(index).querySelector<HTMLElement>('.thumb__split');
  if (bar === null) {
    throw new Error(`нет split-бара у миниатюры ${String(index)}`);
  }
  return bar;
};

/** `dragleave` с ленты в сторону `next`. */
const leave = (scroll: Element, next: Element, transfer: DataTransfer): void => {
  const event = createEvent.dragLeave(scroll, { dataTransfer: transfer });
  Object.defineProperty(event, 'relatedTarget', { value: next });
  fireEvent(scroll, event);
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
    // Источник перетаскивания — карточка, а не картинка внутри неё.
    expect(option(0).querySelector('img')?.getAttribute('draggable')).toBe('false');
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
      rotate180: {},
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
      rotate180: {},
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
    // Переход на соседнюю миниатюру — ещё лента: маркер остаётся. `relatedTarget` jsdom
    // из инициализатора теряет — задаётся на событии.
    leave(scroll, option(4), transfer);
    expect(document.querySelector('.thumb__drop')).not.toBeNull();
    leave(scroll, document.body, transfer);
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

  it('KTD-9: пока пишется PDF — ни переноса, ни границ, ни имён, ни «Вернуть», ни клавиш', async () => {
    const api = stubApi({ saveDocuments: vi.fn(() => new Promise(() => undefined)) });
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);
    fireEvent.click(button('Повернуть на 90° по часовой'));
    await settle();
    rerender(applied(snapshot, lastSent(api)));

    // Модалка `save` пишет пакет: редактор под ней заблокирован (S16).
    fireEvent.click(button('Сохранить документ'));
    fireEvent.click(button('Сохранить файл'));
    await settle();
    expect(api.saveDocuments).toHaveBeenCalledTimes(1);
    expect(option(0).getAttribute('draggable')).toBe('false');
    expect(document.querySelector('.thumb__split')).toBeNull();
    expect(nameField(1).disabled).toBe(true);
    for (const name of ['Повернуть на 90° по часовой', 'Удалить страницу', 'Вернуть']) {
      expect(button(name).hasAttribute('disabled'), name).toBe(true);
    }
    ctrlZ();
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(api.setEdits).toHaveBeenCalledTimes(1);
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
      rotate180: {},
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

  it('Ctrl+Z границы с фокусом в ленте — после снимка фокус на текущей миниатюре, а не на body', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);

    fireEvent.click(splitBar(2));
    await settle();
    const cut = applied(snapshot, lastSent(api));
    rerender(cut);
    // Страница второго документа в фокусе: Ctrl+Z перенесёт её в первую группу.
    fireEvent.click(option(2));
    option(2).focus();
    ctrlZ(option(2));
    expect(lastSent(api).edits).toEqual(EMPTY_EDITS);

    await settle();
    rerender(applied(cut, lastSent(api)));
    expect(screen.getAllByRole('listbox').length).toBe(1);
    expect(document.activeElement?.getAttribute('data-key')).toBe(F2);
  });

  it('перенос с фокусом в ленте — после снимка фокус на текущей миниатюре', async () => {
    const api = stubApi();
    const cut = applied(twoPass(), {
      edits: edits({ cuts: [2], names: ['', ''] }),
      rotate180: false,
    });
    const { rerender } = renderEditor(cut);

    fireEvent.click(option(0));
    option(0).focus();
    // F1 уезжает во второй документ — миниатюра перемонтируется в другой группе.
    dragAndDrop(option(0), option(3), 'after');
    await settle();
    rerender(applied(cut, lastSent(api)));
    expect(
      within(screen.getByRole('listbox', { name: 'Страницы документа 2' }))
        .getAllByRole('option')
        .map((element) => element.getAttribute('data-key')),
    ).toContain(F1);
    expect(document.activeElement?.getAttribute('data-key')).toBe(F1);
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
      rotate180: {},
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
      rotate180: {},
    });
  });
});

describe('editor M3: имя документа (S3)', () => {
  it('ввод по буквам локален; Enter — один setEdits и уход фокуса на текущую (M3.5, S14); повторный blur ничего не шлёт', async () => {
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
      rotate180: {},
    });
    // До снимка поле показывает отправленное, а не прежнее; фокус — на карточке текущей.
    expect(field.value).toBe('Акт');
    expect(document.activeElement).toBe(option(0));
    fireEvent.blur(field);
    expect(api.setEdits).toHaveBeenCalledTimes(1);

    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(nameField(1).value).toBe('Акт');
    expect(within(screen.getByRole('banner')).getByText('Акт')).toBeDefined();
  });

  it('Enter при команде в полёте оставляет фокус и черновик в поле (код-ревью сессий 3–4)', async () => {
    const { setEdits, answer } = deferredSetEdits();
    const api = stubApi({ setEdits });
    const snapshot = makeSnapshot([makePass({ pages: pages(3) })]);
    const { rerender } = renderEditor(snapshot);

    fireEvent.click(screen.getByRole('button', { name: 'Повернуть на 90° по часовой' }));
    const field = nameField(1);
    field.focus();
    fireEvent.change(field, { target: { value: 'Акт' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('Акт');
    expect(api.setEdits).toHaveBeenCalledTimes(1);

    // Команда дошла, снимок показан — уход фокуса дожимает имя.
    answer(ok({ seq: 2 }));
    await settle();
    rerender(applied(snapshot, lastSent(api)));
    fireEvent.blur(nameField(1));
    expect(api.setEdits).toHaveBeenCalledTimes(2);
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
      rotate180: {},
    });
  });

  it('команда в полёте — черновик имени не теряется: остаётся в поле и уходит следующим blur', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);
    const field = nameField(1);

    fireEvent.click(button('Повернуть на 90° по часовой'));
    field.focus();
    fireEvent.change(field, { target: { value: 'Акт' } });
    fireEvent.blur(field);
    expect(api.setEdits).toHaveBeenCalledTimes(1);
    expect(field.value).toBe('Акт');

    await settle();
    const rotatedSnapshot = applied(snapshot, lastSent(api));
    rerender(rotatedSnapshot);
    expect(nameField(1).value).toBe('Акт');
    nameField(1).focus();
    fireEvent.blur(nameField(1));
    expect(api.setEdits).toHaveBeenCalledTimes(2);
    expect(lastSent(api).edits).toEqual(edits({ rotations: { [F1]: 90 }, names: ['Акт'] }));
  });

  it('черновик имени едет с документом: граница перед ним снята — поле ниже не наследует чужой текст', async () => {
    const api = stubApi();
    const cut = applied(twoPass(), {
      edits: edits({ cuts: [2, 4], names: ['', '', ''] }),
      rotate180: false,
    });
    const { rerender } = renderEditor(cut);

    // Черновик в третьем документе, пока команда снятия первой границы в полёте.
    fireEvent.click(button('Убрать границу перед документом 2'));
    fireEvent.change(nameField(3), { target: { value: 'Опись' } });
    await settle();
    rerender(applied(cut, lastSent(api)));
    // Третий документ стал вторым — черновик вместе с ним.
    expect(screen.getAllByRole('listbox').length).toBe(2);
    expect(nameField(2).value).toBe('Опись');
    expect(nameField(1).value).toBe('');
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
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({ edits: EMPTY_EDITS, rotate180: {} });
    expect(screen.queryByRole('dialog')).toBeNull();
    await settle();
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Всё возвращено как после сканирования');

    rerender(applied(edited, { edits: EMPTY_EDITS, rotate180: false }));
    expect(screen.queryByText('Есть ручные правки')).toBeNull();
    // Плашка исчезла — фокус клавиатуры на текущей странице, а не на body.
    expect(document.activeElement?.getAttribute('role')).toBe('option');

    ctrlZ();
    expect(api.setEdits).toHaveBeenCalledTimes(2);
    // Мост несёт флаг 180° картой по проходам оборотов (M4.5, KTD4): проход №2.
    expect(lastSent(api)).toEqual({ edits: editedState.edits, rotate180: { 2: true } });
  });
});

describe('editor M3.5: split-бар уступает выделению (U10, KTD-10; R20, R21)', () => {
  const bars = (): number => document.querySelectorAll('.thumb__split').length;
  const current = (): string | undefined =>
    document.querySelector<HTMLElement>('.thumb--selected')?.dataset.key;

  it('Ctrl-клик по верхнему краю миниатюры — страница в выделении, границы нет', async () => {
    const api = stubApi();
    renderEditor(twoPass());

    fireEvent.click(option(1));
    fireEvent.click(splitBar(2), { ctrlKey: true });
    await settle();

    expect(selectedKeys()).toEqual([B3, F2]);
    expect(api.setEdits).not.toHaveBeenCalled();
    // Выделение из двух — баров нет вовсе.
    expect(bars()).toBe(0);
  });

  it('Shift-клик по зоне бара — диапазон, не граница', async () => {
    const api = stubApi();
    renderEditor(twoPass());

    fireEvent.click(option(0));
    fireEvent.click(splitBar(2), { shiftKey: true });
    await settle();

    expect(selectedKeys()).toEqual([F1, B3, F2]);
    expect(api.setEdits).not.toHaveBeenCalled();
  });

  it('бар скрыт, пока зажат Shift или Ctrl; отпустили — бар снова есть', () => {
    stubApi();
    renderEditor(twoPass());
    expect(bars()).toBe(5);

    fireEvent.keyDown(window, { key: 'Shift', shiftKey: true });
    expect(bars()).toBe(0);
    fireEvent.keyUp(window, { key: 'Shift', shiftKey: false });
    expect(bars()).toBe(5);

    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    expect(bars()).toBe(0);
    // Окно потеряло фокус — отпускание клавиши оно не увидит: сброс по `blur`.
    fireEvent.blur(window);
    expect(bars()).toBe(5);
  });

  it('клик по превью при трёх выделенных — одна текущая; кнопки действий выделение не сжимают; Esc прежний', () => {
    stubApi();
    renderEditor(twoPass());
    const stage = document.querySelector('.stage');
    if (stage === null) {
      throw new Error('нет превью');
    }

    fireEvent.click(option(0));
    fireEvent.click(option(2), { shiftKey: true });
    expect(selectedKeys()).toHaveLength(3);
    // Нажатие на кнопку, действующую на выделение, — выделение целое.
    fireEvent.mouseDown(button('Удалить 3 стр.'));
    expect(selectedKeys()).toHaveLength(3);

    fireEvent.mouseDown(stage);
    expect(selectedKeys()).toEqual([F2]);
    expect(current()).toBe(F2);
    expect(bars()).toBe(5);

    // Esc — как раньше: сжатие до текущей из ленты.
    fireEvent.click(option(0));
    fireEvent.click(option(1), { shiftKey: true });
    expect(selectedKeys()).toHaveLength(2);
    fireEvent.keyDown(option(1), { key: 'Escape' });
    expect(selectedKeys()).toEqual([B3]);
  });

  it('клик по ленте мимо миниатюр и по инспектору: лента выделение держит, инспектор — сжимает', () => {
    stubApi();
    renderEditor(twoPass());

    fireEvent.click(option(0));
    fireEvent.click(option(1), { shiftKey: true });
    fireEvent.mouseDown(screen.getByRole('listbox'));
    expect(selectedKeys()).toHaveLength(2);

    const inspector = document.querySelector('.inspector');
    if (inspector === null) {
      throw new Error('нет инспектора');
    }
    fireEvent.mouseDown(inspector);
    expect(selectedKeys()).toEqual([B3]);
  });
});
