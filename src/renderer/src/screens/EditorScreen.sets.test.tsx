import { fail, ok, type Snapshot } from '@shared';
import { act, cleanup, createEvent, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import {
  applied,
  B1,
  B2,
  dataTransfer,
  deferredSetEdits,
  dragOver,
  edits,
  F1,
  F2,
  F3,
  lastSent,
  makePass,
  makeSnapshot,
  option,
  pages,
  renderEditor,
  selectedKeys,
  settle,
  stubApi,
  twoPass,
} from './editor-fixture';

// Экран `editor` в режиме раздельных наборов (план M3.6, U6; handoff M3.6, S1–S5, S8–S9, S12–S13;
// R17–R26): лента из двух групп с разделителем, тулбар режима с «Собрать документ», перенос через
// границу, «Проверка» и «Детали» до сборки, подписи миниатюр, сборка и тост. Лента с правками —
// из фикстуры `applied` (зеркало ядра, KTD-2).

const button = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name });
const assembleButton = (): HTMLElement => button('Собрать документ');
const separator = (): HTMLElement => screen.getByRole('separator');
const statusText = (): string =>
  document.querySelector('.editor-screen__sets-text')?.textContent ?? '';
const groupHeading = (name: string): HTMLElement => screen.getByRole('heading', { name, level: 2 });
/** Группа набора по заголовку. */
const setGroup = (name: string): HTMLElement => {
  const section = groupHeading(name).closest('section');
  if (section === null) {
    throw new Error(`группа «${name}» вне секции`);
  }
  return section;
};

/** `dragover` над разделителем наборов: верхняя (`fronts`) или нижняя (`backs`) половина. */
function dragOverDivider(side: 'fronts' | 'backs', transfer: DataTransfer): void {
  const target = separator();
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: 300,
    top: 200,
    bottom: 240,
    width: 300,
    height: 40,
    x: 0,
    y: 200,
    toJSON: () => ({}),
  });
  const event = createEvent.dragOver(target, { dataTransfer: transfer });
  Object.defineProperty(event, 'clientY', { value: side === 'fronts' ? 205 : 235 });
  fireEvent(target, event);
}

/** Лица 2, обороты 3 (6, 5, 4 подачей): лишний оборот. */
const extraBack = (): Snapshot =>
  makeSnapshot([
    makePass({ pages: pages(2) }),
    makePass({ number: 2, kind: 'backs', pages: pages(3, 1, 'p02-s01') }),
  ]);

/** 3/2 плюс добавленный набор из одной страницы за оборотом 1 — наборы уравнены 3/3. */
const equalized = (): Snapshot =>
  makeSnapshot([
    makePass({ pages: pages(3) }),
    makePass({ number: 2, kind: 'backs', pages: pages(2, 1, 'p02-s01') }),
    makePass({ number: 3, kind: 'added', after: B1, pages: pages(1, 1, 'p03-s01') }),
  ]);
const A1 = 'p03-s01-0001';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('лента в режиме наборов (S1–S3, R17)', () => {
  it('AE1: две группы с заголовками и счётчиками, разделитель с подсказкой; ни имён, ни split-бара, ни «Выделить в документ»', () => {
    stubApi();
    renderEditor(twoPass(2));

    // Лента 1л 2л 3л | 2о 1о: обороты обратным порядком подачи.
    expect(screen.getAllByRole('option').map((item) => item.getAttribute('data-key'))).toEqual([
      F1,
      F2,
      F3,
      B2,
      B1,
    ]);
    const fronts = setGroup('Лицевые стороны');
    const backs = setGroup('Оборотные стороны');
    expect(fronts.className).toBe('set-group set-group--fronts');
    expect(within(fronts).getByLabelText('3 страницы').textContent).toBe('· 3');
    expect(within(backs).getByLabelText('2 страницы').textContent).toBe('· 2');
    expect(screen.getByRole('listbox', { name: 'Страницы набора лиц' })).toBeDefined();
    expect(screen.getByRole('listbox', { name: 'Страницы набора оборотов' })).toBeDefined();
    expect(separator().getAttribute('aria-label')).toBe(
      'Граница наборов: выше — лицевые стороны, ниже — оборотные. Перенос страницы через границу меняет её набор',
    );
    expect(separator().textContent).toBe('перенос через границу меняет набор');
    expect(separator().getAttribute('tabindex')).toBeNull();

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('.thumb__split')).toBeNull();
    expect(document.querySelector('.doc-group')).toBeNull();
    expect(screen.queryByRole('button', { name: /Новый документ/ })).toBeNull();
    fireEvent.click(option(0));
    fireEvent.click(option(1), { shiftKey: true });
    expect(screen.queryByRole('button', { name: 'Выделить в документ' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Выделение' }).textContent).toBe('Выделено 2 стр.');
  });

  it('S9: подпись миниатюры по группе и месту; тег «об» — по происхождению', () => {
    stubApi();
    renderEditor(twoPass(2));

    expect(option(0).getAttribute('aria-label')).toBe('Страница 1, лицевая, 1-я в наборе лиц');
    expect(option(3).getAttribute('aria-label')).toBe(
      'Страница 4, оборотная, 1-я в наборе оборотов',
    );
    expect(option(3).textContent).toContain('об');
    expect(option(0).textContent).not.toContain('об');
    // Страница добавленного набора в группе оборотов — набор и группа, тег «Д1».
    cleanup();
    stubApi();
    renderEditor(equalized());
    expect(option(5).getAttribute('aria-label')).toBe(
      'Страница 6, добавленный набор 1, в наборе оборотов',
    );
    expect(option(5).textContent).toContain('Д1');
    expect(option(5).textContent).not.toContain('об');
  });

  it('R26: стрелки и Shift-диапазон ходят сквозь границу как по одной ленте; Home/End — по всей', () => {
    stubApi();
    renderEditor(twoPass(2));

    fireEvent.click(option(2));
    fireEvent.keyDown(option(2), { key: 'ArrowRight' });
    expect(selectedKeys()).toEqual([B2]);
    expect(document.activeElement).toBe(option(3));
    fireEvent.keyDown(option(3), { key: 'ArrowLeft', shiftKey: true });
    expect(selectedKeys()).toEqual([F3, B2]);
    fireEvent.keyDown(option(2), { key: 'End' });
    expect(selectedKeys()).toEqual([B1]);
    fireEvent.keyDown(option(4), { key: 'Home' });
    expect(selectedKeys()).toEqual([F1]);
  });

  it('AE10: проходы совпали — обычный редактор: группы документов, «Сохранить», галочка о листах', () => {
    stubApi();
    renderEditor(twoPass());

    expect(document.querySelector('.doc-group')).not.toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Собрать документ' })).toBeNull();
    expect(button('Сохранить документ')).toBeDefined();
    const check = screen.getByText('Лица и обороты собраны: 3 листа').closest('li');
    expect(check?.className).toBe('check');
  });
});

describe('перенос через границу (S2–S3, R18; KTD8)', () => {
  it('AE3: лицо на оборот — порядок и граница одним setEdits; счётчики обновились', async () => {
    const api = stubApi();
    const snapshot = twoPass(2);
    const { rerender } = renderEditor(snapshot);

    const transfer = dataTransfer();
    fireEvent.dragStart(option(2), { dataTransfer: transfer });
    dragOver(option(4), 'after', transfer);
    fireEvent.drop(option(4), { dataTransfer: transfer });
    fireEvent.dragEnd(option(2), { dataTransfer: transfer });
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ order: [F1, F2, B2, B1, F3], divider: 2 }),
      rotate180: {},
    });

    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(statusText()).toBe('Проходы не сошлись: лицевых 2, оборотных 3');
    expect(screen.getByLabelText('2 страницы').textContent).toBe('· 2');
    expect(screen.getByLabelText('3 страницы').textContent).toBe('· 3');
    expect(option(4).getAttribute('aria-label')).toBe(
      'Страница 5, оборотная, 3-я в наборе оборотов',
    );
    expect(option(4).textContent).not.toContain('об');
    expect(selectedKeys()).toEqual([F3]);
    expect(screen.getByText('Есть ручные правки')).toBeDefined();
  });

  it('последнее лицо «перед первым оборотом» — порядок тот же, уходит одна граница', () => {
    const api = stubApi();
    renderEditor(twoPass(2));

    const transfer = dataTransfer();
    fireEvent.dragStart(option(2), { dataTransfer: transfer });
    dragOver(option(3), 'before', transfer);
    fireEvent.drop(option(3), { dataTransfer: transfer });
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ divider: 2 }),
      rotate180: {},
    });
  });

  it('разделитель — цель дропа: верхняя половина в конец лиц, нижняя — в начало оборотов', () => {
    const api = stubApi();
    renderEditor(twoPass(2));

    // Оборот 2 (первый в группе оборотов) → верх разделителя: в конец лиц, порядок прежний.
    const transfer = dataTransfer();
    fireEvent.dragStart(option(3), { dataTransfer: transfer });
    dragOverDivider('fronts', transfer);
    expect(separator().className).toBe('set-divider set-divider--drop-above');
    dragOverDivider('backs', transfer);
    expect(separator().className).toBe('set-divider set-divider--drop-below');
    // Оборот 2 и так первый за границей — «в начало оборотов» ничего не меняет.
    fireEvent.drop(separator(), { dataTransfer: transfer });
    fireEvent.dragEnd(option(3), { dataTransfer: transfer });
    expect(api.setEdits).not.toHaveBeenCalled();
    expect(separator().className).toBe('set-divider');

    dragOverDivider('fronts', transfer);
    fireEvent.dragStart(option(4), { dataTransfer: transfer });
    dragOverDivider('fronts', transfer);
    fireEvent.drop(separator(), { dataTransfer: transfer });
    // Оборот 1 — последний: встаёт к границе, граница +1.
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ order: [F1, F2, F3, B1, B2], divider: 4 }),
      rotate180: {},
    });
  });

  it('AE16: смешанное выделение переносится целиком и берёт группу цели', () => {
    const api = stubApi();
    renderEditor(twoPass(2));

    fireEvent.click(option(0));
    fireEvent.click(option(4), { ctrlKey: true });
    const transfer = dataTransfer();
    fireEvent.dragStart(option(4), { dataTransfer: transfer });
    dragOver(option(1), 'after', transfer);
    fireEvent.drop(option(1), { dataTransfer: transfer });
    // Цель — лицо 2: обе в лицах; граница = 3 − 1 (из лиц) + 2.
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ order: [F2, F1, B1, F3, B2], divider: 4 }),
      rotate180: {},
    });
  });

  it('S3: пустая группа — заголовок «· 0» и зона дропа; бросок в неё переносит страницу', async () => {
    const api = stubApi();
    const snapshot = twoPass(2);
    const { rerender } = renderEditor(snapshot);
    rerender(applied(snapshot, { edits: edits({ deleted: [B2, B1] }), rotate180: false }));

    expect(statusText()).toBe('Проходы не сошлись: лицевых 3, оборотных 0');
    expect(screen.getByLabelText('0 страниц').textContent).toBe('· 0');
    const zone = screen.getByRole('listbox', { name: 'Страницы набора оборотов' });
    expect(zone.textContent).toBe('Перетащите сюда страницы оборотов');
    expect(screen.getAllByRole('option').length).toBe(3);

    const transfer = dataTransfer();
    fireEvent.dragStart(option(0), { dataTransfer: transfer });
    fireEvent.dragOver(zone, { dataTransfer: transfer });
    expect(zone.className).toBe('set-group__drop set-group__drop--active');
    fireEvent.drop(zone, { dataTransfer: transfer });
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ deleted: [B2, B1], order: [F2, F3, F1], divider: 2 }),
      rotate180: {},
    });
    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(statusText()).toBe('Проходы не сошлись: лицевых 2, оборотных 1');
    expect(zone.isConnected).toBe(false);
  });

  it('R25: тумблер 180° крутит страницу прохода оборотов в любой группе и не крутит «Д1» в оборотах', () => {
    stubApi();
    const snapshot = equalized();
    const { rerender } = renderEditor(snapshot);
    // Оборот 2 перенесён в лица, тумблер включён.
    rerender(
      applied(snapshot, {
        edits: edits({ order: [F1, F2, F3, B2, B1, A1], divider: 4 }),
        rotate180: true,
      }),
    );

    expect(option(3).getAttribute('data-key')).toBe(B2);
    expect(option(3).className).toContain('thumb--angle-180');
    expect(option(3).textContent).toContain('об');
    expect(option(5).getAttribute('data-key')).toBe(A1);
    expect(option(5).className).not.toContain('thumb--angle-');
    expect(option(0).className).not.toContain('thumb--angle-');
  });
});

describe('тулбар режима и «Собрать документ» (S4–S5, R19)', () => {
  it('AE1: не сошлись — янтарная точка и счётчики; кнопка недоступна с причиной; «Сохранить» нет', () => {
    stubApi();
    renderEditor(twoPass(2));

    expect(statusText()).toBe('Проходы не сошлись: лицевых 3, оборотных 2');
    expect(document.querySelector('.editor-screen__toolbar-center--sets .dot')?.className).toBe(
      'dot dot--warning',
    );
    expect(assembleButton().hasAttribute('disabled')).toBe(true);
    expect(assembleButton().getAttribute('title')).toBe('Не хватает 1 оборота');
    expect(screen.queryByRole('button', { name: /Сохранить/ })).toBeNull();
    // Точка несохранённого остаётся: документ правда не сохранён.
    expect(screen.getByTitle('Есть несохранённые изменения')).toBeDefined();
  });

  it('AE9: лиц меньше — «Не хватает 1 лица»; после удаления лишнего оборота кнопка доступна', async () => {
    const api = stubApi();
    const snapshot = extraBack();
    const { rerender } = renderEditor(snapshot);
    expect(assembleButton().getAttribute('title')).toBe('Не хватает 1 лица');

    fireEvent.click(option(4));
    fireEvent.keyDown(option(4), { key: 'Delete' });
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: edits({ deleted: ['p02-s01-0001'] }),
      rotate180: {},
    });
    await settle();
    rerender(applied(snapshot, lastSent(api)));

    expect(statusText()).toBe('Наборы уравнены — соберите документ');
    expect(document.querySelector('.editor-screen__toolbar-center--sets .dot')?.className).toBe(
      'dot dot--accent',
    );
    expect(assembleButton().hasAttribute('disabled')).toBe(false);
    expect(assembleButton().getAttribute('title')).toBeNull();
    // Точка в ПРОВЕРКЕ остаётся: документ ещё не собран.
    const check = screen.getByText('Наборы уравнены: по 2 стр. — нажмите «Собрать документ»');
    expect(check.closest('li')?.className).toBe('check check--warning');
  });

  it('S5: пока правка в полёте — причина «секунду»; прерванный проход — своя причина у обеих кнопок (AE12)', () => {
    const { setEdits } = deferredSetEdits();
    stubApi({ setEdits });
    const { view } = renderEditor(equalized());
    expect(assembleButton().hasAttribute('disabled')).toBe(false);

    fireEvent.click(button('Повернуть на 90° по часовой'));
    expect(assembleButton().hasAttribute('disabled')).toBe(true);
    expect(assembleButton().getAttribute('title')).toBe('Правка ещё записывается — секунду');
    view.unmount();

    stubApi();
    renderEditor(
      makeSnapshot(
        [
          makePass({ pages: pages(3) }),
          makePass({
            number: 2,
            kind: 'backs',
            state: 'interrupted',
            pages: pages(1, 1, 'p02-s01'),
          }),
        ],
        { canAccept: true, canResume: true },
      ),
    );
    expect(screen.getByText('ПРОХОД ПРЕРВАН')).toBeDefined();
    expect(screen.getByRole('separator')).toBeDefined();
    const reason = 'Сначала досканируйте прерванный проход или оставьте его как есть';
    expect(assembleButton().getAttribute('title')).toBe(reason);
    expect(button('Добавить').getAttribute('title')).toBe(reason);
  });

  it('все страницы удалены — «В наборах нет страниц», ПРОВЕРКА про пустые наборы', () => {
    stubApi();
    const snapshot = twoPass(2);
    const { rerender } = renderEditor(snapshot);
    rerender(
      applied(snapshot, { edits: edits({ deleted: [F1, F2, F3, B2, B1] }), rotate180: false }),
    );

    expect(assembleButton().getAttribute('title')).toBe('В наборах нет страниц');
    expect(screen.getByText('Наборы пусты: все страницы удалены')).toBeDefined();
    expect(screen.getByText('Все страницы удалены')).toBeDefined();
  });

  it('AE2: клик зовёт api.assemble один раз; до ответа кнопка недоступна; успех — тост и обычный редактор, фокус на текущей', async () => {
    let resolve: (value: Awaited<ReturnType<typeof window.api.assemble>>) => void = () => undefined;
    const assemble = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof window.api.assemble>>>((done) => {
          resolve = done;
        }),
    );
    const api = stubApi({ assemble });
    const snapshot = equalized();
    const { rerender, onToast } = renderEditor(snapshot);
    fireEvent.click(option(1));

    fireEvent.click(assembleButton());
    fireEvent.click(assembleButton());
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(assembleButton().hasAttribute('disabled')).toBe(true);
    // Пока команда в полёте, правки заблокированы, как при записи (ревью #6): ни клавиши, ни
    // перетаскивания, ни «Вернуть».
    fireEvent.keyDown(document.body, { key: 'Delete' });
    fireEvent.click(button('Повернуть на 90° по часовой'));
    expect(api.setEdits).not.toHaveBeenCalled();
    expect(option(0).getAttribute('draggable')).toBe('false');

    // Снимок режима «собрано»: запись — чередование F1 B2 F2 B1 F3 A1.
    const assembled = {
      ...snapshot,
      seq: snapshot.seq + 1,
      session: { ...snapshot.session, assembled: [F1, B2, F2, B1, F3, A1] },
    } as Snapshot;
    rerender(
      makeSnapshot(
        [...(assembled.session?.passes ?? [])],
        {},
        { assembled: [F1, B2, F2, B1, F3, A1] },
      ),
    );
    await act(async () => {
      resolve(ok(undefined));
      await Promise.resolve();
    });

    expect(onToast).toHaveBeenCalledExactlyOnceWith('Документ собран: 3 листа');
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Собрать документ' })).toBeNull();
    expect(button('Сохранить документ')).toBeDefined();
    expect(screen.getAllByRole('option').map((item) => item.getAttribute('data-key'))).toEqual([
      F1,
      B2,
      F2,
      B1,
      F3,
      A1,
    ]);
    expect(option(1).getAttribute('aria-label')).toBe('Страница 2');
    expect(selectedKeys()).toEqual([F2]);
    expect(document.activeElement).toBe(option(2));
    // Три лица в записи — три листа, добавленный набор в счёт по позиции.
    expect(screen.getByText('Лица и обороты собраны: 3 листа')).toBeDefined();
  });

  it('мост не ответил — тост 6 с, кнопка снова доступна, экран прежний (ревью #7)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stubApi({ assemble: vi.fn(() => Promise.reject(new Error('нет ответа'))) });
    const { onToast } = renderEditor(equalized());

    fireEvent.click(assembleButton());
    await settle();

    expect(onToast).toHaveBeenCalledExactlyOnceWith(
      'Не удалось собрать документ: приложение не получило ответа. Проверьте ленту и повторите.',
      6000,
    );
    expect(assembleButton().hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('separator')).toBeDefined();
  });

  it('отказ ядра — тост с причиной, экран прежний', async () => {
    stubApi({
      assemble: vi.fn(() => Promise.resolve(fail('sessionConflict', { reason: 'setsUnequal' }))),
    });
    const { onToast } = renderEditor(equalized());

    fireEvent.click(assembleButton());
    await settle();

    expect(onToast).toHaveBeenCalledExactlyOnceWith(
      'Не удалось собрать документ: наборы не уравнены: число лиц и оборотов должно совпасть.',
      6000,
    );
    expect(assembleButton().hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('separator')).toBeDefined();
  });
});

describe('инспектор до сборки (S8–S9, R22–R23)', () => {
  it('ДОКУМЕНТЫ — «появятся после сборки» без счётчика; ПРОВЕРКА — точка со счётчиками и подсказкой', () => {
    stubApi();
    renderEditor(twoPass(2));

    const inspector = screen.getByRole('complementary', { name: 'Сведения о наборе' });
    expect(
      within(inspector).getByText(
        'Документы появятся после сборки: сейчас лица и обороты лежат отдельными наборами.',
      ),
    ).toBeDefined();
    expect(within(inspector).queryByText(/документ/u, { selector: '.inspector__meta' })).toBeNull();
    const check = within(inspector)
      .getByText('Наборы не уравнены: лицевых 3, оборотных 2 — не хватает 1 оборота')
      .closest('li');
    expect(check?.className).toBe('check check--warning');
    expect(within(check as HTMLElement).getByText(/Досканируйте недостающее/).className).toBe(
      'check__hint',
    );
  });

  it('ДЕТАЛИ: заголовок по группе и месту, факты «Набор», «Место», «Откуда», «Поворот» — без «Лист»', () => {
    stubApi();
    renderEditor(equalized());

    fireEvent.click(option(5));
    fireEvent.click(screen.getByRole('button', { name: /ДЕТАЛИ/ }));
    const facts = (): string[] =>
      screen
        .getAllByRole('term')
        .map((term) => `${term.textContent}: ${term.nextElementSibling?.textContent ?? ''}`);
    expect(
      screen.getByRole('heading', { name: 'Стр. 6 — добавленный набор 1, в наборе оборотов' }),
    ).toBeDefined();
    expect(facts()).toEqual([
      'Набор: оборотных сторон',
      'Место: 3-я из 3',
      'Откуда: добавленный набор 1',
      'Поворот: 0°',
    ]);
    expect(screen.getByText(/Страница добавленного набора: в каком наборе лежит/)).toBeDefined();

    fireEvent.click(option(3));
    expect(
      screen.getByRole('heading', { name: 'Стр. 4 — оборотная, 1-я в наборе оборотов' }),
    ).toBeDefined();
    expect(facts()).toEqual([
      'Набор: оборотных сторон',
      'Место: 1-я из 3',
      'Откуда: проход оборотов',
      'Поворот: 0°',
    ]);
    expect(screen.getByText(/станет оборотом листа 1\./)).toBeDefined();
    fireEvent.click(option(0));
    expect(facts()[2]).toBe('Откуда: проход лиц');
  });

  it('S10: «+ Добавить» — «В конец набора» и сводка с группой', () => {
    stubApi({ ...{} });
    renderEditor(
      makeSnapshot([...(twoPass(2).session?.passes ?? [])], { scanner: { kind: 'none' } }),
    );

    fireEvent.click(option(3));
    fireEvent.click(button('Добавить'));
    expect(screen.getByRole('radio', { name: 'В конец набора' })).toBeDefined();
    fireEvent.click(screen.getByRole('radio', { name: 'В конец набора' }));
    expect(document.querySelector('.add-modal__summary')?.textContent).toBe(
      'Одностороннее · в конец набора оборотов, после стр. 5',
    );
  });

  it('S11: «Новое сканирование» — «ДОКУМЕНТ НЕ СОБРАН» без «Сначала сохранить»', () => {
    stubApi();
    renderEditor(twoPass(2));

    fireEvent.click(button('Новое сканирование'));
    expect(screen.getByText('ДОКУМЕНТ НЕ СОБРАН')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Сначала сохранить/ })).toBeNull();
  });
});

describe('после сборки (S9, S13)', () => {
  it('режим «собрано»: лента по записи, подписи листов по позиции, галочка по числу лиц', () => {
    stubApi();
    renderEditor(
      makeSnapshot(
        [
          makePass({ pages: pages(3) }),
          makePass({ number: 2, kind: 'backs', pages: pages(2, 1, 'p02-s01') }),
        ],
        {},
        { assembled: [F1, B2, F2, B1, F3] },
      ),
    );

    expect(screen.getAllByRole('option').map((item) => item.getAttribute('data-key'))).toEqual([
      F1,
      B2,
      F2,
      B1,
      F3,
    ]);
    fireEvent.click(option(3));
    fireEvent.click(screen.getByRole('button', { name: /ДЕТАЛИ/ }));
    expect(screen.getByRole('heading', { name: 'Стр. 4 — оборот листа 2' })).toBeDefined();
    fireEvent.click(option(4));
    expect(screen.getByRole('heading', { name: 'Стр. 5 — лицо листа 3' })).toBeDefined();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Собрать документ' })).toBeNull();
    expect(screen.getByText('Лица и обороты собраны: 3 листа')).toBeDefined();
    expect(screen.queryByText('Есть ручные правки')).toBeNull();
  });
});
