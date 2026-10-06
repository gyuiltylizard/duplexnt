import { fail, ok } from '@shared';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import {
  applied,
  ctrlZ,
  edits,
  lastSent,
  makePass,
  makeSnapshot,
  pages,
  renderEditor,
  settle,
  stubApi,
  twoPass,
} from './editor-fixture';

// Экран `editor`: сохранение и новое сканирование (план M3, U9; handoff M3, S1, S16–S18) —
// проводка модалок `save` и `newscan`, тост с действием, «Сначала сохранить текущий» (AE11).
// Сами модалки — SaveModal.test.tsx и NewScanModal.test.tsx.

const button = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name });
/** Кнопка модалки: у тулбара и у окна `save` бывают одинаковые подписи. */
const inDialog = (name: string | RegExp): HTMLElement =>
  within(screen.getByRole('dialog')).getByRole('button', { name });

/** Двусторонняя фикстура с границей перед третьей страницей: два документа (имена — как
 * нормализует ядро: по одному на документ). */
function twoDocuments() {
  const snapshot = twoPass();
  return applied(snapshot, { edits: edits({ cuts: [2], names: ['', ''] }), rotate180: false });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('сохранение из редактора', () => {
  it('S1: кнопка — «Сохранить документ» при одном документе, «Сохранить N файлов» при нескольких', () => {
    stubApi();
    const { rerender } = renderEditor(twoPass());
    expect(button('Сохранить документ')).toBeDefined();

    rerender(twoDocuments());
    expect(button('Сохранить 2 файла')).toBeDefined();
  });

  it('AE10: пустая лента — сохранять нечего', () => {
    stubApi();
    const snapshot = twoPass();
    const keys = snapshot.assembly?.order.map((entry) => entry.key) ?? [];
    renderEditor(applied(snapshot, { edits: edits({ deleted: keys }), rotate180: false }));

    expect(button('Сохранить документ').hasAttribute('disabled')).toBe(true);
  });

  it('S18: полный успех — модалка закрыта, тост 6 с с кнопкой «Новое сканирование» → newscan', async () => {
    const api = stubApi();
    const { onToast } = renderEditor(twoDocuments());

    fireEvent.click(button('Сохранить 2 файла'));
    expect(screen.getByRole('dialog', { name: 'Сохранить 2 файла' })).toBeDefined();
    fireEvent.click(inDialog('Сохранить 2 файла'));
    await settle();
    await settle();

    expect(api.saveDocuments).toHaveBeenCalledExactlyOnceWith({
      mode: 'separate',
      names: ['Документ 1', 'Документ 2'],
      retry: false,
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onToast).toHaveBeenCalledExactlyOnceWith(
      'Сохранено 2 файла → C:\\Документы',
      6000,
      expect.objectContaining({ label: 'Новое сканирование' }),
    );
    // Кнопка тоста открывает `newscan`, а не закрывает сессию молча.
    const action = onToast.mock.calls[0]?.[2] as { onClick: () => void };
    await settle();
    action.onClick();
    await settle();
    expect(screen.getByRole('dialog', { name: 'Начать новое сканирование?' })).toBeDefined();
    expect(api.closeSession).not.toHaveBeenCalled();
  });

  it('один файл — тост называет файл и папку', async () => {
    stubApi();
    const { onToast } = renderEditor(makeSnapshot([makePass({})]));

    fireEvent.click(button('Сохранить документ'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Имя файла 1' }), {
      target: { value: 'Акт' },
    });
    fireEvent.click(button('Сохранить файл'));
    await settle();
    await settle();

    expect(onToast).toHaveBeenCalledWith(
      'Сохранено: Акт.pdf → C:\\Документы',
      6000,
      expect.anything(),
    );
  });

  it('имена из модалки — сначала в документы одним шагом undo, потом пакет', async () => {
    const api = stubApi();
    const snapshot = twoDocuments();
    const { rerender } = renderEditor(snapshot);

    fireEvent.click(button('Сохранить 2 файла'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Имя файла 2' }), {
      target: { value: 'Опись' },
    });
    fireEvent.click(inDialog('Сохранить 2 файла'));
    await settle();
    await settle();

    expect(lastSent(api).edits.names).toEqual(['', 'Опись']);
    expect(vi.mocked(api.setEdits).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.saveDocuments).mock.invocationCallOrder[0] ?? 0,
    );
    expect(api.saveDocuments).toHaveBeenCalledWith({
      mode: 'separate',
      names: ['Документ 1', 'Опись'],
      retry: false,
    });

    // Шаг undo — один: Ctrl+Z возвращает имена, как были.
    rerender(applied(snapshot, lastSent(api)));
    ctrlZ();
    expect(lastSent(api).edits.names).toEqual(['', '']);
    expect(api.setEdits).toHaveBeenCalledTimes(2);
  });

  it('правка имён не записалась — пакет не пишется, модалка ждёт', async () => {
    const api = stubApi({ setEdits: vi.fn(() => Promise.resolve(fail('storageFull'))) });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { onToast } = renderEditor(twoDocuments());

    fireEvent.click(button('Сохранить 2 файла'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Имя файла 1' }), {
      target: { value: 'Акт' },
    });
    fireEvent.click(inDialog('Сохранить 2 файла'));
    await settle();
    await settle();

    expect(api.saveDocuments).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith(
      expect.stringContaining('Не удалось записать правку'),
      6000,
    );
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('«Отдельные файлы» при одном документе — тост-подсказка про границы', () => {
    stubApi();
    const { onToast } = renderEditor(twoPass());

    fireEvent.click(button('Сохранить документ'));
    fireEvent.click(screen.getByRole('radio', { name: /Отдельные файлы/ }));

    expect(onToast).toHaveBeenCalledExactlyOnceWith('Сначала отметьте границы между документами');
  });

  it('пока модалка открыта, Ctrl+Z правки не откатывает', async () => {
    const api = stubApi();
    const snapshot = twoPass();
    const { rerender } = renderEditor(snapshot);
    fireEvent.click(button('Повернуть на 90° по часовой'));
    await settle();
    rerender(applied(snapshot, lastSent(api)));

    fireEvent.click(button('Сохранить документ'));
    ctrlZ();

    expect(api.setEdits).toHaveBeenCalledTimes(1);
  });
});

describe('новое сканирование из редактора', () => {
  it('«Остаться в документе» — ничего не шлёт', () => {
    const api = stubApi();
    renderEditor(makeSnapshot([makePass({ pages: pages(24) })]));

    fireEvent.click(button(/Новое сканирование/));
    expect(screen.getByText(/24 стр. будут удалены с диска/)).toBeDefined();
    fireEvent.click(button('Остаться в документе'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.closeSession).not.toHaveBeenCalled();
  });

  it('AE11: правки после сохранения — кикер несохранённого; «Сначала сохранить» → save → закрытие', async () => {
    const api = stubApi();
    const { onToast } = renderEditor(twoPass());

    fireEvent.click(button(/Новое сканирование/));
    expect(screen.getByText('ЕСТЬ НЕСОХРАНЁННЫЕ ИЗМЕНЕНИЯ')).toBeDefined();
    fireEvent.click(button(/Сначала сохранить текущий/));
    expect(screen.getByRole('dialog', { name: 'Сохранить документ' })).toBeDefined();
    fireEvent.click(button('Сохранить файл'));
    await settle();
    await settle();

    expect(api.closeSession).toHaveBeenCalledTimes(1);
    await settle();
    expect(onToast).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /^Сохранено: .+\.pdf → C:\\Документы — можно закладывать новые листы$/u,
      ),
      3600,
    );
  });

  it('«Закрыть» модалки save после «Сначала сохранить» — сессия не закрывается', async () => {
    const api = stubApi({
      saveDocuments: vi.fn(() =>
        Promise.resolve(
          ok({
            folder: 'C:\\Документы',
            written: [],
            failed: [{ index: 0, fileName: 'Скан.pdf', error: { code: 'saveWriteFailed' } }],
          }),
        ),
      ),
    });
    renderEditor(twoPass());

    fireEvent.click(button(/Новое сканирование/));
    fireEvent.click(button(/Сначала сохранить текущий/));
    fireEvent.click(button('Сохранить файл'));
    await settle();
    await settle();
    fireEvent.click(button('Закрыть'));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.closeSession).not.toHaveBeenCalled();
  });

  it('сессия без страниц и удалённых — закрывается без модалки', () => {
    const api = stubApi();
    renderEditor(makeSnapshot([makePass({ state: 'interrupted', pages: [] })]));

    // Тулбар, а не плашка прерванного прохода — у обеих «Новое сканирование».
    const [toolbar] = screen.getAllByRole('button', { name: /Новое сканирование/ });
    if (toolbar === undefined) {
      throw new Error('нет кнопки тулбара');
    }
    fireEvent.click(toolbar);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.closeSession).toHaveBeenCalledTimes(1);
  });

  it('AE10: все страницы удалены — «ДОКУМЕНТ ПУСТ» с числом возвращаемых', () => {
    stubApi();
    const snapshot = twoPass();
    const keys = snapshot.assembly?.order.map((entry) => entry.key) ?? [];
    renderEditor(applied(snapshot, { edits: edits({ deleted: keys }), rotate180: false }));

    fireEvent.click(button(/Новое сканирование/));

    expect(screen.getByText('ДОКУМЕНТ ПУСТ')).toBeDefined();
    expect(screen.getByText(/сотрёт их \(6 стр\.\)/)).toBeDefined();
  });
});
