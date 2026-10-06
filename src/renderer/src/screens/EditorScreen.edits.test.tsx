import {
  EMPTY_EDITS,
  fail,
  type AssembledPage,
  type SessionAssembly,
  type Snapshot,
} from '@shared';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { documentsOf } from '../state/assembly-fixture';
import {
  B2,
  B3,
  ctrlZ,
  edits,
  F1,
  F2,
  F3,
  makePass,
  makeSnapshot,
  nameField,
  nextSnapshot,
  option,
  pages,
  renderEditor,
  selectedKeys,
  settle,
  stubApi,
  twoPass,
} from './editor-fixture';
import { SNAPSHOT_WAIT_MS } from './useEditorEdits';

// Экран `editor`, M3 (план U7; handoff M3, S1–S15): документы, выделение, поворот и удаление,
// undo/redo, пустой редактор, инспектор. Ленту с правками тест задаёт снимком — renderer её
// не считает (KTD-2).

/** Сборка с документами по разрезам — как её отдало бы ядро. */
const withCuts =
  (cuts: readonly number[], names: readonly string[] = []) =>
  (assembly: SessionAssembly): SessionAssembly => ({
    ...assembly,
    documents: documentsOf(assembly.order.length, cuts, names),
  });

/** Сборка без удалённых страниц. */
const without =
  (keys: readonly string[]) =>
  (assembly: SessionAssembly): SessionAssembly => {
    const order = assembly.order.filter((entry) => !keys.includes(entry.key));
    return {
      ...assembly,
      order,
      documents: documentsOf(order.length),
      hasEdits: true,
      deleted: assembly.deleted + assembly.order.length - order.length,
    };
  };

/** Сборка с углами страниц из ядра. */
const angled =
  (angles: Readonly<Record<string, AssembledPage['angle']>>) =>
  (assembly: SessionAssembly): SessionAssembly => ({
    ...assembly,
    order: assembly.order.map((entry) => ({ ...entry, angle: angles[entry.key] ?? entry.angle })),
    hasEdits: true,
  });

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('editor M3: документы', () => {
  it('S2: лента группами по документам из снимка, номер миниатюры — сквозной', () => {
    stubApi();
    renderEditor(nextSnapshot(twoPass(), { assembly: withCuts([2, 4], ['Акт']) }));

    const lists = screen.getAllByRole('listbox');
    expect(lists.map((list) => list.getAttribute('aria-label'))).toEqual([
      'Страницы документа 1',
      'Страницы документа 2',
      'Страницы документа 3',
    ]);
    expect(lists.every((list) => list.getAttribute('aria-multiselectable') === 'true')).toBe(true);
    const second = within(screen.getByRole('listbox', { name: 'Страницы документа 2' }));
    expect(second.getAllByRole('option').length).toBe(2);
    // Номер первой страницы второго документа — 3, а не 1.
    expect(second.getAllByRole('option')[0]?.textContent).toContain('3');

    // Заголовки: поле имени — введённое имя, иначе плейсхолдер «Документ N»; группа подписана
    // полем; счётчик; разделитель — кроме первой группы.
    const first = nameField(1);
    expect(first.value).toBe('Акт');
    expect(nameField(2).value).toBe('');
    expect(nameField(2).placeholder).toBe('Документ 2');
    expect(first.maxLength).toBe(200);
    expect(screen.getByRole('region', { name: 'Название документа 2' })).toBeDefined();
    expect(screen.getAllByText('2 стр.').length).toBe(3);
    expect(screen.getAllByText('НОВЫЙ ДОКУМЕНТ').length).toBe(2);
  });

  it('S1: тулбар — тон, имя и позиция документа текущей страницы', () => {
    stubApi();
    renderEditor(nextSnapshot(twoPass(), { assembly: withCuts([2, 4], ['Акт']) }));

    const toolbar = screen.getByRole('banner');
    expect(within(toolbar).getByText('Акт')).toBeDefined();
    expect(within(toolbar).getByText('документ 1 из 3 · стр. 1 из 2')).toBeDefined();

    fireEvent.click(option(3));
    expect(within(toolbar).getByText('Документ 2')).toBeDefined();
    expect(within(toolbar).getByText('документ 2 из 3 · стр. 2 из 2')).toBeDefined();
    expect(
      toolbar.querySelector('.editor-screen__toolbar-center')?.classList.contains('doc-tone--2'),
    ).toBe(true);
    // Сохранение — как в M2 до модалки `save` (U9).
    expect(within(toolbar).getByRole('button', { name: 'Сохранить документ' })).toBeDefined();
  });

  it('S1/S3: один документ — имя по умолчанию «Скан ГГГГ-ММ-ДД», позиция без документа', () => {
    stubApi();
    renderEditor(makeSnapshot([makePass({ pages: pages(3) })]));

    const toolbar = screen.getByRole('banner');
    expect(within(toolbar).getByText(/^Скан \d{4}-\d{2}-\d{2}$/u)).toBeDefined();
    expect(within(toolbar).getByText('стр. 1 из 3')).toBeDefined();
    expect(screen.queryByText('НОВЫЙ ДОКУМЕНТ')).toBeNull();
  });

  it('S8: страница, с которой начинается документ, — кромка и метка «НАЧАЛО ДОКУМЕНТА N»', () => {
    stubApi();
    renderEditor(nextSnapshot(twoPass(), { assembly: withCuts([2, 4]) }));

    expect(screen.queryByText(/НАЧАЛО ДОКУМЕНТА/)).toBeNull();
    fireEvent.click(option(4));
    expect(screen.getByText('НАЧАЛО ДОКУМЕНТА 3')).toBeDefined();
    const paper = screen.getByAltText('Страница 5').parentElement;
    expect(paper?.className).toContain('preview__paper--doc-start');
    expect(paper?.className).toContain('doc-tone--3');

    fireEvent.click(option(5));
    expect(screen.queryByText(/НАЧАЛО ДОКУМЕНТА/)).toBeNull();
  });
});

describe('editor M3: выделение', () => {
  it('клик, Shift+клик и Ctrl+клик; панель выделения и «Снять»', () => {
    stubApi();
    renderEditor(twoPass());

    fireEvent.click(option(1));
    fireEvent.click(option(4), { shiftKey: true });
    expect(selectedKeys()).toEqual([B3, F2, B2, F3]);
    expect(option(2).className).toContain('thumb--in-selection');
    // Текущая — последняя нажатая: превью и единственная точка входа клавиатуры.
    expect(screen.getByText('5 из 6')).toBeDefined();
    expect(document.querySelectorAll('[role="option"][tabindex="0"]').length).toBe(1);
    expect(option(4).getAttribute('tabindex')).toBe('0');
    expect(screen.getByText('Выделено 4 стр. · Shift — диапазон, Ctrl — по одной')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Удалить 4 стр.' })).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'Повернуть 4 стр. на 90° по часовой' }),
    ).toBeDefined();

    fireEvent.click(option(2), { ctrlKey: true });
    expect(selectedKeys()).toEqual([B3, B2, F3]);

    fireEvent.click(screen.getByRole('button', { name: 'Снять' }));
    expect(selectedKeys()).toEqual([F3]);
    expect(screen.queryByRole('region', { name: 'Выделение' })).toBeNull();
    expect(option(4).className).not.toContain('thumb--in-selection');
    expect(screen.getByRole('button', { name: 'Удалить страницу' })).toBeDefined();
  });

  it('клавиатура: Shift+стрелки — диапазон от якоря, Ctrl+Space — переключение, Esc — сжатие', () => {
    stubApi();
    renderEditor(twoPass());

    fireEvent.keyDown(option(0), { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(option(1), { key: 'ArrowRight', shiftKey: true });
    expect(selectedKeys()).toEqual([F1, B3, F2]);
    expect(document.activeElement).toBe(option(2));

    // Ctrl+Space убирает текущую — текущей становится ближайшая из оставшихся.
    fireEvent.keyDown(option(2), { key: ' ', ctrlKey: true });
    expect(selectedKeys()).toEqual([F1, B3]);
    expect(document.activeElement).toBe(option(1));

    fireEvent.keyDown(option(1), { key: 'Escape' });
    expect(selectedKeys()).toEqual([B3]);

    // Стрелка без Shift сжимает выделение до соседней.
    fireEvent.click(option(4), { shiftKey: true });
    fireEvent.keyDown(option(4), { key: 'ArrowLeft' });
    expect(selectedKeys()).toEqual([B2]);
  });
});

describe('editor M3: правки', () => {
  it('групповое удаление — один setEdits, тост; выделение — на вставшей на место странице', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { onToast, rerender } = renderEditor(snapshot);

    fireEvent.click(option(1));
    fireEvent.click(option(2), { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Удалить 2 стр.' }));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ deleted: [B3, F2] }),
      rotate180: false,
    });
    await settle();
    // Тост — без длительности: обычные 2,6 с.
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Удалено 2 стр. — Ctrl+Z вернёт');

    rerender(
      nextSnapshot(snapshot, {
        session: { edits: edits({ deleted: [B3, F2] }) },
        assembly: without([B3, F2]),
      }),
    );
    expect(screen.getAllByRole('option').length).toBe(4);
    expect(selectedKeys()).toEqual([B2]);
    expect(screen.getByText('2 из 4')).toBeDefined();
  });

  it('Ctrl+Z после удаления шлёт прежнее состояние одним шагом и выделяет вернувшиеся', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);

    fireEvent.click(option(1));
    fireEvent.click(option(2), { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Удалить 2 стр.' }));
    await settle();
    const removed = nextSnapshot(snapshot, {
      session: { edits: edits({ deleted: [B3, F2] }) },
      assembly: without([B3, F2]),
    });
    rerender(removed);

    ctrlZ();
    expect(api.setEdits).toHaveBeenCalledTimes(2);
    expect(api.setEdits).toHaveBeenLastCalledWith({ edits: EMPTY_EDITS, rotate180: false });
    await settle();
    rerender({ ...snapshot, seq: removed.seq + 1 });
    expect(selectedKeys()).toEqual([B3, F2]);

    // Ctrl+Y (и Ctrl+Shift+Z) — вперёд: удаление снова.
    fireEvent.keyDown(document.body, { key: 'y', code: 'KeyY', ctrlKey: true });
    expect(api.setEdits).toHaveBeenLastCalledWith({
      edits: edits({ deleted: [B3, F2] }),
      rotate180: false,
    });
  });

  it('Delete удаляет текущую с тостом «Страница удалена»; зажатая клавиша — одно удаление', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { onToast, rerender } = renderEditor(snapshot);

    option(0).focus();
    fireEvent.keyDown(option(0), { key: 'Delete' });
    fireEvent.keyDown(option(0), { key: 'Delete', repeat: true });
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ deleted: [F1] }),
      rotate180: false,
    });
    await settle();
    expect(onToast).toHaveBeenCalledExactlyOnceWith('Страница удалена — Ctrl+Z вернёт');

    // Удаляли с клавиатуры из ленты — фокус переходит на вставшую на место страницу.
    rerender(
      nextSnapshot(snapshot, {
        session: { edits: edits({ deleted: [F1] }) },
        assembly: without([F1]),
      }),
    );
    expect(document.activeElement?.getAttribute('data-key')).toBe(B3);
  });

  it('↻ поворачивает текущую на 90° без тоста; угол из снимка — класс и подпись миниатюры, альбомное превью', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { onToast, rerender } = renderEditor(snapshot);

    fireEvent.click(screen.getByRole('button', { name: 'Повернуть на 90° по часовой' }));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ rotations: { [F1]: 90 } }),
      rotate180: false,
    });
    await settle();
    expect(onToast).not.toHaveBeenCalled();

    rerender(
      nextSnapshot(snapshot, {
        session: { edits: edits({ rotations: { [F1]: 90 } }) },
        assembly: angled({ [F1]: 90 }),
      }),
    );
    expect(option(0).className).toContain('thumb--angle-90');
    expect(option(0).getAttribute('aria-label')).toBe('Страница 1, повёрнута на 90°');
    const paper = screen.getByAltText('Страница 1').parentElement;
    expect(paper?.className).toContain('preview__paper--angle-90');
    expect(paper?.className).toContain('preview__paper--landscape');
  });

  it('Ctrl+Z шлёт предыдущее состояние; русская раскладка (Ctrl+Я) — тоже', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);

    fireEvent.click(screen.getByRole('button', { name: 'Повернуть на 90° по часовой' }));
    await settle();
    rerender(
      nextSnapshot(snapshot, {
        session: { edits: edits({ rotations: { [F1]: 90 } }) },
        assembly: angled({ [F1]: 90 }),
      }),
    );

    fireEvent.keyDown(document.body, { key: 'я', code: 'KeyZ', ctrlKey: true });
    expect(api.setEdits).toHaveBeenCalledTimes(2);
    expect(api.setEdits).toHaveBeenLastCalledWith({ edits: EMPTY_EDITS, rotate180: false });
  });

  it('пока команда в полёте — до снимка с её результатом — новые жесты игнорируются', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);
    const rotate = screen.getByRole('button', { name: 'Повернуть на 90° по часовой' });

    fireEvent.click(rotate);
    fireEvent.click(rotate);
    await settle();
    // Ответ пришёл, снимка ещё нет: жест от устаревшего снимка откатил бы первый поворот.
    fireEvent.click(rotate);
    ctrlZ();
    expect(api.setEdits).toHaveBeenCalledTimes(1);

    rerender(
      nextSnapshot(snapshot, {
        session: { edits: edits({ rotations: { [F1]: 90 } }) },
        assembly: angled({ [F1]: 90 }),
      }),
    );
    fireEvent.click(rotate);
    expect(api.setEdits).toHaveBeenCalledTimes(2);
    expect(api.setEdits).toHaveBeenLastCalledWith({
      edits: edits({ rotations: { [F1]: 180 } }),
      rotate180: false,
    });
  });

  it('снимок не пришёл (ядро не записало совпавшую правку) — по сроку жесты снова уходят', async () => {
    vi.useFakeTimers();
    const api = stubApi();
    renderEditor(twoPass());
    const rotate = screen.getByRole('button', { name: 'Повернуть на 90° по часовой' });

    fireEvent.click(rotate);
    await settle();
    // Ответ «успех», снимка нет: до срока редактор занят.
    act(() => {
      vi.advanceTimersByTime(SNAPSHOT_WAIT_MS - 1);
    });
    fireEvent.click(rotate);
    expect(api.setEdits).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    fireEvent.click(rotate);
    expect(api.setEdits).toHaveBeenCalledTimes(2);
  });

  it('отказ setEdits не меняет историю: Ctrl+Z после него ничего не шлёт', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = stubApi({
      setEdits: vi.fn(() => Promise.resolve(fail('sessionConflict', { reason: 'saving' }))),
    });
    renderEditor(twoPass());

    fireEvent.click(screen.getByRole('button', { name: 'Повернуть на 90° по часовой' }));
    await settle();
    expect(error).toHaveBeenCalledWith('[renderer] правка не принята', expect.anything());

    ctrlZ();
    expect(api.setEdits).toHaveBeenCalledTimes(1);
    // Отказ снял «в полёте»: следующий жест уходит.
    fireEvent.click(screen.getByRole('button', { name: 'Повернуть на 90° по часовой' }));
    expect(api.setEdits).toHaveBeenCalledTimes(2);
  });

  it('лента изменилась не через правку — история очищается', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);

    fireEvent.click(screen.getByRole('button', { name: 'Повернуть на 90° по часовой' }));
    await settle();
    // Досканирование добавило страницу в проход: подпись ленты другая.
    const session = snapshot.session;
    if (session === null) {
      throw new Error('нет сессии');
    }
    const grown: Snapshot = nextSnapshot(snapshot, {
      session: {
        edits: edits({ rotations: { [F1]: 90 } }),
        passes: [makePass({ pages: pages(4) }), ...session.passes.slice(1)],
      },
      assembly: angled({ [F1]: 90 }),
    });
    rerender(grown);

    ctrlZ();
    expect(api.setEdits).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Z в текстовом поле и при открытой модалке не перехватывается', () => {
    const api = stubApi();
    renderEditor(twoPass());
    fireEvent.click(screen.getByRole('button', { name: 'Повернуть на 90° по часовой' }));
    expect(api.setEdits).toHaveBeenCalledTimes(1);

    const field = document.createElement('input');
    document.body.append(field);
    ctrlZ(field);
    fireEvent.keyDown(field, { key: 'Delete' });
    field.remove();

    fireEvent.click(screen.getByRole('button', { name: /Новое сканирование/ }));
    ctrlZ(screen.getByRole('dialog'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Delete' });
    expect(api.setEdits).toHaveBeenCalledTimes(1);
  });

  it('S15: тумблер 180° — шаг undo: Ctrl+Z возвращает выключенный', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Повернуть обороты на 180°' }));
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({ edits: EMPTY_EDITS, rotate180: true });
    await settle();
    const session = snapshot.session;
    if (session === null) {
      throw new Error('нет сессии');
    }
    rerender(
      nextSnapshot(snapshot, {
        session: {
          passes: session.passes.map((pass, index) =>
            index === 1 ? { ...pass, rotate180: true } : pass,
          ),
        },
      }),
    );

    ctrlZ();
    expect(api.setEdits).toHaveBeenLastCalledWith({ edits: EMPTY_EDITS, rotate180: false });
  });
});

describe('editor M3: пустой редактор и инспектор', () => {
  it('AE10: все страницы удалены — подсказки, кнопки недоступны, счётчик «—»', () => {
    stubApi();
    const snapshot = twoPass();
    renderEditor(
      nextSnapshot(snapshot, {
        session: { edits: edits({ deleted: [F1, B3, F2, B2, F3, 'p02-s01-0001'] }) },
        assembly: without(snapshot.assembly?.order.map((entry) => entry.key) ?? []),
      }),
    );

    expect(screen.getByText('Все страницы удалены')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Страниц не осталось' })).toBeDefined();
    expect(screen.getByText(/Ctrl\+Z вернёт последнее удаление/)).toBeDefined();
    expect(screen.getByText('—')).toBeDefined();
    expect(screen.getByText('Нет страниц')).toBeDefined();
    for (const name of [
      'Предыдущая страница',
      'Следующая страница',
      'Повернуть на 90° по часовой',
      'Удалить страницу',
      'Сохранить документ',
    ]) {
      expect(screen.getByRole('button', { name }).hasAttribute('disabled'), name).toBe(true);
    }
    // Инспектор: ДЕТАЛИ скрыты, документов нет; тумблер остаётся.
    expect(screen.queryByText('ДЕТАЛИ')).toBeNull();
    expect(screen.getByText('документов нет')).toBeDefined();
    expect(screen.getByRole('checkbox', { name: 'Повернуть обороты на 180°' })).toBeDefined();
  });

  it('S11: ДЕТАЛИ свёрнуты по умолчанию; факты и пояснение о паре текущей страницы', () => {
    stubApi();
    renderEditor(twoPass(2));

    const toggle = screen.getByRole('button', { name: /ДЕТАЛИ/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Лист 1 — без оборота: обороты пришли от последнего листа.
    expect(screen.getByRole('heading', { name: 'Стр. 1 — лицо листа 1' })).toBeDefined();
    expect(screen.getByText('У этого листа нет оборота — проходы не сошлись.')).toBeDefined();

    // Состояние раскрытия переживает смену страницы.
    fireEvent.click(option(2));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Стр. 3 — оборот листа 2' })).toBeDefined();
    expect(screen.getByText('№2')).toBeDefined();
    expect(screen.getByText('оборот')).toBeDefined();
    expect(screen.getByText('0°')).toBeDefined();
    expect(
      screen.getByText('Оборот листа 2: сопоставлен с лицом по позиции в проходе оборотов.'),
    ).toBeDefined();
  });

  it('S12: ДОКУМЕНТЫ — список с текущим, клик переводит на первую страницу документа', () => {
    stubApi();
    renderEditor(nextSnapshot(twoPass(), { assembly: withCuts([2, 3], ['Акт']) }));

    const inspector = screen.getByRole('complementary', { name: 'Сведения о наборе' });
    expect(within(inspector).getByText('3 документа')).toBeDefined();
    expect(
      within(inspector).getByText(
        'При сохранении получится 3 отдельных файла — по отмеченным границам.',
      ),
    ).toBeDefined();
    expect(within(inspector).getByText('2 стр. · стр. 1–2 набора')).toBeDefined();
    expect(within(inspector).getByText('1 стр. · стр. 3 набора')).toBeDefined();
    const items = within(inspector).getAllByRole('button', { name: /набора/ });
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual(['true', null, null]);

    fireEvent.click(items[2] as Element);
    expect(screen.getByText('4 из 6')).toBeDefined();
    expect(selectedKeys()).toEqual([B2]);
    expect(items[2]?.getAttribute('aria-current')).toBe('true');
  });

  it('S12/S13: один документ без оборотов — подсказка о границах и «Обороты не сканировали»', () => {
    stubApi();
    renderEditor(makeSnapshot([makePass({ pages: pages(3) })]));

    const inspector = screen.getByRole('complementary', { name: 'Сведения о наборе' });
    expect(within(inspector).getByText('1 документ')).toBeDefined();
    expect(within(inspector).getByText(/^Границы не отмечены/)).toBeDefined();
    expect(within(inspector).getByText('Обороты не сканировали')).toBeDefined();
    expect(within(inspector).getByText('Порядок соответствует сканированию')).toBeDefined();
    expect(
      within(inspector).getByText('Обороты не сканировали — лист односторонний.'),
    ).toBeDefined();
  });

  it('S13: несовпадение пар и ручной порядок — янтарные пункты', () => {
    stubApi();
    renderEditor(
      nextSnapshot(twoPass(2), {
        assembly: (assembly) => ({ ...assembly, orderEdited: true, hasEdits: true }),
      }),
    );

    const pairs = screen.getByText('Пар «лицо + оборот»: 2 из 3').closest('li');
    expect(pairs?.className).toContain('check--warning');
    const order = screen.getByText('Порядок правили вручную — автосортировка отключена');
    expect(order.closest('li')?.className).toContain('check--warning');
  });

  it.each([
    [2, '2 документа', 'При сохранении получится 2 отдельных файла — по отмеченным границам.'],
    [5, '5 документов', 'При сохранении получится 5 отдельных файлов — по отмеченным границам.'],
  ])('плюрализация: %i документов', (count, meta, note) => {
    stubApi();
    const cuts = Array.from({ length: count - 1 }, (_, index) => index + 1);
    renderEditor(nextSnapshot(twoPass(), { assembly: withCuts(cuts) }));

    const inspector = screen.getByRole('complementary', { name: 'Сведения о наборе' });
    expect(within(inspector).getByText(meta)).toBeDefined();
    expect(within(inspector).getByText(note)).toBeDefined();
  });
});
