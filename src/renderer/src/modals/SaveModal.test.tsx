import {
  fail,
  NO_STRAIGHTEN,
  ok,
  type Api,
  type AssembledDocument,
  type CommandResult,
  type SaveDocumentsRequest,
  type StraightenSummary,
} from '@shared';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { NO_BLANK } from '../state/assembly-fixture';
import { SaveModal, type SaveModalProps } from './SaveModal';

// Модалка `save` (план M3, U9; handoff M3, S16): режим, имена, папка, сводка, запись пакета,
// ИТОГ частичного сбоя и повтор (AE7), имена, изменённые ядром.

const FOLDER = 'C:\\Users\\me\\Documents\\Сканы';

/** Пакет как у ядра: всё записано под запрошенными именами. */
const writtenAsAsked = (request: SaveDocumentsRequest) =>
  Promise.resolve(
    ok({
      folder: FOLDER,
      written: request.names.map((name, index) => ({ index, fileName: `${name}.pdf` })),
      failed: [],
    }),
  );

function stubApi(overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const api = {
    getSaveFolder: vi.fn(() => Promise.resolve(ok(FOLDER))),
    chooseSaveFolder: vi.fn(() => Promise.resolve(ok({ canceled: false, folder: 'D:\\Архив' }))),
    saveDocuments: vi.fn(writtenAsAsked),
    ...overrides,
  } as unknown as Api;
  vi.stubGlobal('api', api);
  return api;
}

const doc = (start: number, count: number, name = ''): AssembledDocument => ({
  name,
  start,
  count,
});

const THREE = [doc(0, 9, 'Акт приёма-передачи'), doc(9, 7), doc(16, 8)];
const THREE_DEFAULTS = ['Документ 1', 'Документ 2', 'Документ 3'];

function renderModal(props: Partial<SaveModalProps> = {}) {
  const handlers = {
    onRename: vi.fn<SaveModalProps['onRename']>(() => Promise.resolve(true)),
    onWriting: vi.fn(),
    onNeedCuts: vi.fn(),
    onSaved: vi.fn(),
    onClose: vi.fn(),
  };
  const element = (next: Partial<SaveModalProps>) => (
    <SaveModal
      documents={THREE}
      defaultNames={THREE_DEFAULTS}
      singleDefault="Скан 2026-10-06"
      total={24}
      blank={NO_BLANK}
      straighten={NO_STRAIGHTEN}
      editsBusy={false}
      {...handlers}
      {...next}
    />
  );
  const view = render(element(props));
  /** Новые пропсы в ту же модалку — как их доставил бы следующий снимок. */
  const rerender = (next: Partial<SaveModalProps>): void => {
    view.rerender(element({ ...props, ...next }));
  };
  return { ...handlers, rerender };
}

const mode = (name: RegExp): HTMLElement => screen.getByRole('radio', { name });
const file = (number: number): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('textbox', { name: `Имя файла ${String(number)}` });
const button = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name });
const fact = (key: string): string | null | undefined =>
  screen.getByText(key).nextElementSibling?.textContent;

/** Ответы моста — микротасками: дождаться, пока модалка их разберёт. */
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('модалка save: выбор', () => {
  it('несколько документов — «Отдельные файлы», строки по документам, сводка, папка', async () => {
    stubApi();
    renderModal();
    await settle();

    expect(screen.getByRole('heading', { name: 'Сохранить 3 файла' })).toBeDefined();
    expect(mode(/Отдельные файлы/).getAttribute('aria-checked')).toBe('true');
    expect(mode(/Отдельные файлы/).textContent).toContain('по границам: 3 файла');
    expect(mode(/Один файл/).textContent).toContain('все 24 стр. подряд');
    expect(file(1).value).toBe('Акт приёма-передачи');
    expect(file(2).value).toBe('');
    expect(file(2).placeholder).toBe('Документ 2');
    expect(screen.getByText('ФАЙЛЫ · 3')).toBeDefined();
    expect(fact('Файлов')).toBe('3');
    expect(fact('Страниц всего')).toBe('24');
    expect(fact('Формат')).toBe('PDF');
    expect(screen.getByTitle(FOLDER)).toBeDefined();
    expect(button('Сохранить 3 файла')).toBeDefined();
    // Начальный фокус — на первом элементе выбора режима.
    expect(document.activeElement).toBe(mode(/Отдельные файлы/));
  });

  it('один документ — «Отдельные файлы» недоступны: подсказка тостом, режим не меняется', () => {
    stubApi();
    const { onNeedCuts } = renderModal({
      documents: [doc(0, 24)],
      defaultNames: ['Скан 2026-10-06'],
    });

    const separate = mode(/Отдельные файлы/);
    expect(separate.getAttribute('aria-disabled')).toBe('true');
    expect(separate.textContent).toContain('границы ещё не отмечены');
    fireEvent.click(separate);

    expect(onNeedCuts).toHaveBeenCalledTimes(1);
    expect(mode(/Один файл/).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Сохранить документ' })).toBeDefined();
    expect(file(1).placeholder).toBe('Скан 2026-10-06');
  });

  it('больше десяти строк — список прокручивается', () => {
    stubApi();
    const documents = Array.from({ length: 11 }, (_, index) => doc(index, 1));
    renderModal({
      documents,
      defaultNames: documents.map((_, index) => `Документ ${String(index + 1)}`),
      total: 11,
    });

    expect(file(1).closest('ul')?.className).toContain('save-files--scroll');
  });

  it('«Выбрать…» меняет папку; отказ в диалоге оставляет прежнюю', async () => {
    const api = stubApi({
      chooseSaveFolder: vi
        .fn()
        .mockResolvedValueOnce(ok({ canceled: false, folder: 'D:\\Архив' }))
        .mockResolvedValueOnce(ok({ canceled: true, folder: 'D:\\Архив' })),
    });
    renderModal();
    await settle();

    fireEvent.click(button('Выбрать…'));
    await settle();
    expect(screen.getByTitle('D:\\Архив')).toBeDefined();
    fireEvent.click(button('Выбрать…'));
    await settle();
    expect(screen.getByTitle('D:\\Архив')).toBeDefined();
    expect(api.chooseSaveFolder).toHaveBeenCalledTimes(2);
  });
});

describe('модалка save: свежие данные', () => {
  it('выбор папки после отказа снимает прежнюю ошибку', async () => {
    stubApi({ saveDocuments: vi.fn(() => Promise.resolve(fail('saveWriteFailed'))) });
    renderModal();
    fireEvent.click(button('Сохранить 3 файла'));
    await settle();
    expect(screen.getByRole('alert')).toBeDefined();

    fireEvent.click(button('Выбрать…'));
    await settle();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('имя документа, пришедшее в снимке после открытия, видно в строке и не откатывается', async () => {
    const api = stubApi();
    const handlers = renderModal({ documents: [doc(0, 9), doc(9, 15)] });
    expect(file(1).value).toBe('');

    // Имя из ленты (фиксация по уходу фокуса) дописалось уже после открытия модалки.
    handlers.rerender({ documents: [doc(0, 9, 'Акт'), doc(9, 15)] });
    expect(file(1).value).toBe('Акт');
    fireEvent.change(file(2), { target: { value: 'Опись' } });
    fireEvent.click(button('Сохранить 2 файла'));
    await settle();

    // В правки уходят только имена, тронутые в модалке.
    expect(handlers.onRename).toHaveBeenCalledExactlyOnceWith(new Map([[1, 'Опись']]));
    expect(vi.mocked(api.saveDocuments).mock.calls[0]?.[0].names).toEqual(['Акт', 'Опись']);
  });

  it('пока правка в полёте — «Сохранить» недоступно', () => {
    stubApi();
    renderModal({ editsBusy: true });

    expect(button('Сохранить 3 файла').hasAttribute('disabled')).toBe(true);
  });
});

describe('модалка save: запись', () => {
  it('«Отдельные файлы»: имена — сначала в документы, потом пакет; пустое — по умолчанию', async () => {
    const api = stubApi();
    const { onRename, onSaved } = renderModal();

    fireEvent.change(file(2), { target: { value: '  Опись вложений ' } });
    fireEvent.click(button('Сохранить 3 файла'));
    await settle();

    // В документы — только тронутое в модалке и как введено (обрезка — у имени файла).
    expect(onRename).toHaveBeenCalledExactlyOnceWith(new Map([[1, '  Опись вложений ']]));
    expect(api.saveDocuments).toHaveBeenCalledExactlyOnceWith({
      mode: 'separate',
      names: ['Акт приёма-передачи', 'Опись вложений', 'Документ 3'],
      retry: false,
    });
    // Всё под запрошенными именами — модалку закрывает экран, тост — его же.
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({
      folder: FOLDER,
      written: [
        { index: 0, fileName: 'Акт приёма-передачи.pdf' },
        { index: 1, fileName: 'Опись вложений.pdf' },
        { index: 2, fileName: 'Документ 3.pdf' },
      ],
      failed: [],
    });
  });

  it('«Один файл» при нескольких документах: имя файла в журнал не пишется (R15)', async () => {
    const api = stubApi();
    const { onRename } = renderModal();

    fireEvent.click(mode(/Один файл/));
    expect(screen.getByRole('heading', { name: 'Сохранить документ' })).toBeDefined();
    expect(file(1).placeholder).toBe('Скан 2026-10-06');
    expect(screen.queryByRole('textbox', { name: 'Имя файла 2' })).toBeNull();
    expect(fact('Файлов')).toBe('1');
    fireEvent.click(button('Сохранить файл'));
    await settle();

    expect(onRename).not.toHaveBeenCalled();
    expect(api.saveDocuments).toHaveBeenCalledExactlyOnceWith({
      mode: 'single',
      names: ['Скан 2026-10-06'],
      retry: false,
    });
  });

  it('имена не записались — пакет не пишется, выбор снова доступен', async () => {
    const api = stubApi();
    renderModal({ onRename: vi.fn(() => Promise.resolve(false)) });

    fireEvent.click(button('Сохранить 3 файла'));
    await settle();

    expect(api.saveDocuments).not.toHaveBeenCalled();
    expect(file(1).disabled).toBe(false);
    expect(button('Сохранить 3 файла').hasAttribute('disabled')).toBe(false);
  });

  it('пока пишется — модалка занята, кнопки недоступны, правки заблокированы', async () => {
    let answer: (result: CommandResult<'saveDocuments'>) => void = () => undefined;
    stubApi({
      saveDocuments: vi.fn(
        () =>
          new Promise<CommandResult<'saveDocuments'>>((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const { onWriting, onSaved, onClose } = renderModal();

    fireEvent.click(button('Сохранить 3 файла'));
    await settle();

    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Записываем файлы…');
    expect(button('Сохраняем…').hasAttribute('disabled')).toBe(true);
    expect(button('Отмена').hasAttribute('disabled')).toBe(true);
    expect(onWriting).toHaveBeenLastCalledWith(true);
    // B-11: во время записи Esc без действия — как недоступная «Отмена».
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    answer(ok({ folder: FOLDER, written: [{ index: 0, fileName: 'x.pdf' }], failed: [] }));
    await settle();
    expect(onWriting).toHaveBeenLastCalledWith(false);
    // Имя изменено ядром — ИТОГ, а не закрытие.
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('отказ целиком — текст в статусе, выбор снова доступен', async () => {
    stubApi({ saveDocuments: vi.fn(() => Promise.resolve(fail('saveWriteFailed'))) });
    renderModal();

    fireEvent.click(button('Сохранить 3 файла'));
    await settle();

    expect(screen.getByRole('alert').textContent).toMatch(/^Не удалось сохранить: /u);
    expect(file(1).disabled).toBe(false);
    expect(document.activeElement).toBe(button('Сохранить 3 файла'));
  });

  it('мост не ответил — статус, модалка остаётся', async () => {
    stubApi({ saveDocuments: vi.fn(() => Promise.reject(new Error('нет ответа'))) });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { onSaved, onWriting } = renderModal();

    fireEvent.click(button('Сохранить 3 файла'));
    await settle();

    expect(screen.getByRole('alert').textContent).toContain('Часть файлов могла не записаться');
    expect(onWriting).toHaveBeenLastCalledWith(false);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('модалка save: ИТОГ', () => {
  // AE7: пять документов, имя второго занято, сбой на четвёртом.
  const FIVE = [doc(0, 2, 'Акт'), doc(2, 2, 'Опись'), doc(4, 2), doc(6, 2), doc(8, 2)];
  const FIVE_DEFAULTS = FIVE.map((_, index) => `Документ ${String(index + 1)}`);
  const WRITTEN = [
    { index: 0, fileName: 'Акт.pdf' },
    { index: 1, fileName: 'Опись (2).pdf' },
    { index: 2, fileName: 'Документ 3.pdf' },
    { index: 4, fileName: 'Документ 5.pdf' },
  ];
  const partial = ok({
    folder: FOLDER,
    written: WRITTEN,
    failed: [{ index: 3, fileName: 'Документ 4.pdf', error: { code: 'saveWriteFailed' as const } }],
  });

  it('AE7: частичный сбой — записанные с фактическими именами, неудавшийся с ошибкой', async () => {
    stubApi({ saveDocuments: vi.fn(() => Promise.resolve(partial)) });
    const { onSaved } = renderModal({ documents: FIVE, defaultNames: FIVE_DEFAULTS, total: 10 });

    fireEvent.click(button('Сохранить 5 файлов'));
    await settle();

    const rows = within(screen.getByRole('list', { name: 'ИТОГ' })).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent.split('.pdf')[0])).toEqual([
      '✓Акт',
      '✓Опись (2)',
      '✓Документ 3',
      '✕Документ 4',
      '✓Документ 5',
    ]);
    expect(rows[1]?.textContent).toContain('имя было занято — добавлен номер');
    expect(rows[3]?.className).toContain('save-result__row--failed');
    expect(rows[3]?.textContent).toContain('Не удалось записать');
    expect(screen.getByRole('status').textContent).toBe('Записано 4 из 5.');
    // Выбор, имена и папка недоступны: повтор — тот же пакет.
    expect(file(1).disabled).toBe(true);
    expect(mode(/Один файл/).getAttribute('aria-disabled')).toBe('true');
    expect(button('Выбрать…').hasAttribute('disabled')).toBe(true);
    expect(document.activeElement).toBe(button('Повторить неудавшиеся'));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('AE7: повтор шлёт те же имена с retry; успех с переименованием — «Готово»', async () => {
    const api = stubApi({
      saveDocuments: vi
        .fn()
        .mockResolvedValueOnce(partial)
        .mockResolvedValueOnce(
          ok({
            folder: FOLDER,
            written: [...WRITTEN, { index: 3, fileName: 'Документ 4.pdf' }].sort(
              (left, right) => left.index - right.index,
            ),
            failed: [],
          }),
        ),
    });
    const { onSaved } = renderModal({ documents: FIVE, defaultNames: FIVE_DEFAULTS, total: 10 });
    fireEvent.click(button('Сохранить 5 файлов'));
    await settle();

    fireEvent.click(button('Повторить неудавшиеся'));
    await settle();

    expect(vi.mocked(api.saveDocuments).mock.calls[1]?.[0]).toEqual({
      mode: 'separate',
      names: ['Акт', 'Опись', 'Документ 3', 'Документ 4', 'Документ 5'],
      retry: true,
    });
    expect(screen.getByRole('status').textContent).toBe('Записано 5 из 5.');
    expect(screen.queryByRole('button', { name: 'Повторить неудавшиеся' })).toBeNull();
    expect(document.activeElement).toBe(button('Готово'));
    fireEvent.click(button('Готово'));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('повтор отклонён batchStale — текст в статусе, снова выбор', async () => {
    stubApi({
      saveDocuments: vi
        .fn()
        .mockResolvedValueOnce(partial)
        .mockResolvedValueOnce(fail('sessionConflict', { reason: 'batchStale' })),
    });
    renderModal({ documents: FIVE, defaultNames: FIVE_DEFAULTS, total: 10 });
    fireEvent.click(button('Сохранить 5 файлов'));
    await settle();

    fireEvent.click(button('Повторить неудавшиеся'));
    await settle();

    expect(screen.getByRole('alert').textContent).toMatch(/^Не удалось сохранить: /u);
    expect(screen.queryByText('ИТОГ')).toBeNull();
    expect(file(1).disabled).toBe(false);
    expect(button('Сохранить 5 файлов')).toBeDefined();
  });

  it('иной отказ повтора — ИТОГ остаётся, повторить можно ещё раз', async () => {
    stubApi({
      saveDocuments: vi
        .fn()
        .mockResolvedValueOnce(partial)
        .mockResolvedValueOnce(fail('storageFull')),
    });
    renderModal({ documents: FIVE, defaultNames: FIVE_DEFAULTS, total: 10 });
    fireEvent.click(button('Сохранить 5 файлов'));
    await settle();

    fireEvent.click(button('Повторить неудавшиеся'));
    await settle();

    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText('ИТОГ')).toBeDefined();
    expect(button('Повторить неудавшиеся').hasAttribute('disabled')).toBe(false);
  });

  it('«Закрыть» после сбоя — пакет забыт, модалка закрывается', async () => {
    const api = stubApi({ saveDocuments: vi.fn(() => Promise.resolve(partial)) });
    const { onClose, onSaved } = renderModal({
      documents: FIVE,
      defaultNames: FIVE_DEFAULTS,
      total: 10,
    });
    fireEvent.click(button('Сохранить 5 файлов'));
    await settle();

    fireEvent.click(button('Закрыть'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(api.saveDocuments).toHaveBeenCalledTimes(1);
  });

  it('B-11: Esc — «Отмена» при выборе, «Закрыть» после сбоя, «Готово» после записи', async () => {
    stubApi({ saveDocuments: vi.fn(() => Promise.resolve(partial)) });
    const first = renderModal({ documents: FIVE, defaultNames: FIVE_DEFAULTS, total: 10 });
    fireEvent.keyDown(button('Сохранить 5 файлов'), { key: 'Escape' });
    expect(first.onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(button('Сохранить 5 файлов'));
    await settle();
    fireEvent.keyDown(button('Закрыть'), { key: 'Escape' });
    expect(first.onClose).toHaveBeenCalledTimes(2);
    expect(first.onSaved).not.toHaveBeenCalled();
    cleanup();

    stubApi({
      saveDocuments: vi.fn(() =>
        Promise.resolve(
          ok({ folder: FOLDER, written: [{ index: 0, fileName: 'Акт_.pdf' }], failed: [] }),
        ),
      ),
    });
    const second = renderModal({
      documents: [doc(0, 3, 'Акт?')],
      defaultNames: ['Скан'],
      total: 3,
    });
    fireEvent.click(button('Сохранить файл'));
    await settle();
    fireEvent.keyDown(button('Готово'), { key: 'Escape' });
    expect(second.onSaved).toHaveBeenCalledTimes(1);
    expect(second.onClose).not.toHaveBeenCalled();
  });

  it('санитизированное имя помечено «имя изменено»', async () => {
    stubApi({
      saveDocuments: vi.fn(() =>
        Promise.resolve(
          ok({ folder: FOLDER, written: [{ index: 0, fileName: 'Акт_.pdf' }], failed: [] }),
        ),
      ),
    });
    renderModal({ documents: [doc(0, 3, 'Акт?')], defaultNames: ['Скан'], total: 3 });

    fireEvent.click(button('Сохранить файл'));
    await settle();

    expect(screen.getByText('имя изменено: недопустимые для Windows символы убраны')).toBeDefined();
    expect(button('Готово')).toBeDefined();
  });
});

describe('модалка save: выравнивание (M6; handoff M6, `save`)', () => {
  const straightenOf = (overrides: Partial<StraightenSummary>): StraightenSummary => ({
    ...NO_STRAIGHTEN,
    mode: 'auto',
    ...overrides,
  });

  it('straightenPending: статус с остатком из порции, кнопка недоступна; снимок с нулём открывает её сам', () => {
    const api = stubApi();
    const { rerender } = renderModal({
      straighten: straightenOf({ pending: 5, straightened: 7, total: 12 }),
    });

    expect(screen.getByRole('status').textContent).toBe(
      'Выравнивание: ещё 5 стр. из 12 — кнопка станет доступна сама.',
    );
    expect(fact('Выровнено')).toBe('7 стр. · ещё 5 в обработке');
    expect(button('Сохранить 3 файла').hasAttribute('disabled')).toBe(true);
    fireEvent.click(button('Сохранить 3 файла'));
    expect(api.saveDocuments).not.toHaveBeenCalled();

    rerender({
      straighten: straightenOf({ straightened: 7, unmeasurable: 4, deferred: 2, total: 13 }),
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(button('Сохранить 3 файла').hasAttribute('disabled')).toBe(false);
    // Отложенные не блокируют: уйдут как есть.
    expect(fact('Выровнено')).toBe('7 стр. · не выровнено 6');
  });

  it('идут и оценка пустых, и выравнивание — один статус с суммой; documentBlank выше', () => {
    stubApi();
    const { rerender } = renderModal({
      blank: { mode: 'hide', found: 0, hidden: 0, pending: 2 },
      straighten: straightenOf({ pending: 3, total: 10 }),
    });
    expect(screen.getByRole('status').textContent).toBe(
      'Оценка пустых оборотов и выравнивание: ещё 5 стр. — кнопка станет доступна сама.',
    );

    rerender({
      documents: [doc(0, 9, 'Акт'), doc(9, 0, 'Приложение'), doc(9, 8)],
    });
    expect(screen.getByRole('alert').textContent).toContain('Документ «Приложение»');
  });

  it('ряд «Выровнено»: «нет» без выровненных; при «Не трогать» ряда нет', () => {
    stubApi();
    const { rerender } = renderModal({ straighten: straightenOf({ level: 12, total: 12 }) });
    expect(fact('Выровнено')).toBe('нет');

    rerender({ straighten: NO_STRAIGHTEN });
    expect(screen.queryByText('Выровнено')).toBeNull();
  });
});

describe('модалка save: пустые обороты (M4, S14)', () => {
  const HIDE = { mode: 'hide', found: 3, hidden: 3, pending: 0 } as const;

  it('режим «Скрывать»: ряд «Пустых оборотов» — скрыто N; страницы — те, что уйдут в файл', async () => {
    stubApi();
    renderModal({
      documents: [doc(0, 9, 'Акт'), doc(9, 7), doc(16, 5)],
      total: 21,
      blank: HIDE,
    });
    await settle();

    expect(fact('Страниц всего')).toBe('21');
    expect(fact('Пустых оборотов')).toBe('скрыто 3 — не попадут в файл');
    expect(mode(/Один файл/).textContent).toContain('все 21 стр. подряд');
    expect(file(3).closest('li')?.textContent).toContain('5 стр.');
    expect(button('Сохранить 3 файла').hasAttribute('disabled')).toBe(false);
  });

  it.each([
    [
      '«Помечать» — помечено N',
      { mode: 'mark', found: 1, hidden: 0, pending: 0 },
      'помечен 1 — останется в файле',
    ],
    [
      'один скрытый — единственное число',
      { mode: 'hide', found: 1, hidden: 1, pending: 0 },
      'скрыт 1 — не попадёт в файл',
    ],
    ['ничего не найдено', { mode: 'hide', found: 0, hidden: 0, pending: 0 }, 'не найдено'],
  ] as const)('ряд сводки: %s', (_name, blank, expected) => {
    stubApi();
    renderModal({ blank });

    expect(fact('Пустых оборотов')).toBe(expected);
  });

  it('«Оставлять» — ряда нет', () => {
    stubApi();
    renderModal();

    expect(screen.queryByText('Пустых оборотов')).toBeNull();
  });

  it('documentBlank: строка подсвечена, статус с именем, «Сохранить» недоступна; правка в снимке снимает блок', () => {
    const api = stubApi();
    const { rerender } = renderModal({
      documents: [doc(0, 9, 'Акт'), doc(9, 0, 'Приложение'), doc(9, 8)],
      total: 17,
      blank: { mode: 'hide', found: 7, hidden: 7, pending: 1 },
    });

    const row = file(2).closest('li');
    expect(row?.className).toContain('save-file--blank');
    expect(row?.textContent).toContain('только пустые — 0 стр.');
    // Документ из одних скрытых важнее незавершённой оценки: её ждать бесполезно.
    expect(screen.getByRole('alert').textContent).toBe(
      'Документ «Приложение» состоит из одних пустых оборотов — покажите их переключателем или уберите границу.',
    );
    expect(button('Сохранить 3 файла').hasAttribute('disabled')).toBe(true);
    fireEvent.click(button('Сохранить 3 файла'));
    expect(api.saveDocuments).not.toHaveBeenCalled();

    // Снимок после правки (граница убрана): два документа, блок снят.
    rerender({
      documents: [doc(0, 9, 'Акт'), doc(9, 8)],
      blank: { mode: 'hide', found: 7, hidden: 7, pending: 0 },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button('Сохранить 2 файла').hasAttribute('disabled')).toBe(false);
  });

  it('documentBlank: безымянный документ назван именем по умолчанию; «Один файл» пишется, пока есть хоть одна показанная', () => {
    stubApi();
    renderModal({
      documents: [doc(0, 9, 'Акт'), doc(9, 0), doc(9, 8)],
      total: 17,
      blank: HIDE,
    });

    expect(screen.getByRole('alert').textContent).toContain('Документ «Документ 2»');
    fireEvent.click(mode(/Один файл/));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button('Сохранить файл').hasAttribute('disabled')).toBe(false);
  });

  it('все документы из одних скрытых — не записать и одним файлом', () => {
    stubApi();
    renderModal({
      documents: [doc(0, 0, 'Акт'), doc(0, 0)],
      total: 0,
      blank: { mode: 'hide', found: 4, hidden: 4, pending: 0 },
    });

    fireEvent.click(mode(/Один файл/));
    expect(screen.getByRole('alert').textContent).toContain('Документ «Акт»');
    expect(button('Сохранить файл').hasAttribute('disabled')).toBe(true);
  });

  it('blankPending: статус, кнопка недоступна до снимка с pending = 0 — без действий человека', () => {
    const api = stubApi();
    const { rerender } = renderModal({
      blank: { mode: 'hide', found: 0, hidden: 0, pending: 2 },
    });

    expect(screen.getByRole('status').textContent).toBe(
      'Оценка пустых оборотов: ещё 2 стр. — кнопка станет доступна сама.',
    );
    expect(button('Сохранить 3 файла').hasAttribute('disabled')).toBe(true);
    fireEvent.click(button('Сохранить 3 файла'));
    expect(api.saveDocuments).not.toHaveBeenCalled();

    rerender({ blank: { mode: 'hide', found: 1, hidden: 1, pending: 0 } });
    expect(screen.queryByRole('status')).toBeNull();
    expect(button('Сохранить 3 файла').hasAttribute('disabled')).toBe(false);
    expect(fact('Пустых оборотов')).toBe('скрыт 1 — не попадёт в файл');
  });
});

describe('модалка save: папка не прочиталась (B-17)', () => {
  it('отказ getSaveFolder — подсказка в строке статуса, поле пустое, запись не блокируется', async () => {
    const api = stubApi({ getSaveFolder: vi.fn(() => Promise.reject(new Error('мост упал'))) });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderModal();
    await settle();

    expect(screen.getByRole('status').textContent).toContain('Папка не прочиталась');
    expect(error).toHaveBeenCalled();
    fireEvent.click(button(/^Сохранить/));
    await settle();
    expect(api.saveDocuments).toHaveBeenCalledTimes(1);
  });

  it('«Выбрать…» снимает подсказку и показывает путь — и при отказе в диалоге: ядро возвращает свою папку', async () => {
    stubApi({
      getSaveFolder: vi.fn(() => Promise.resolve(fail('storageFailed'))),
      chooseSaveFolder: vi.fn(() => Promise.resolve(ok({ canceled: true, folder: FOLDER }))),
    });
    renderModal();
    await settle();
    expect(screen.getByRole('status').textContent).toContain('Папка не прочиталась');

    fireEvent.click(button('Выбрать…'));
    await settle();
    expect(screen.queryByText(/Папка не прочиталась/)).toBeNull();
    expect(screen.getByTitle(FOLDER)).toBeDefined();
  });
});
