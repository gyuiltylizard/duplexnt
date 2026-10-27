import { EMPTY_EDITS } from '@shared';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import {
  applied,
  ctrlZ,
  lastSent,
  makePass,
  makeSnapshot,
  option,
  pages,
  renderEditor,
  settle,
  stubApi,
} from './editor-fixture';

// Тумблер 180° по пачке текущей страницы (план M4.5, U7; R16; KTD4; handoff M4.5, S9): цель —
// обороты основного документа или набора «ДN» по текущей; карта флагов одним `setEdits`;
// недоступность с причиной; скрыт, когда оборотов нет нигде; Ctrl+Z и «Вернуть» — как прежде.

/**
 * Пары 3+3 (обороты уже повёрнуты), двусторонний набор «Д1» (3+3 после лица 2) и односторонний
 * «Д2» (1 стр. в конце). Лента: 1л 1о 2л [Д1 ×6] 2о 3л 3о [Д2].
 */
function withSets() {
  return makeSnapshot([
    makePass({ pages: pages(3) }),
    makePass({ number: 2, kind: 'backs', rotate180: true, pages: pages(3, 1, 'p02-s01') }),
    makePass({
      number: 3,
      kind: 'addedFronts',
      after: 'p01-s01-0002',
      backsDecision: 'none',
      pages: pages(3, 1, 'p03-s01'),
    }),
    makePass({ number: 4, kind: 'addedBacks', pair: 3, pages: pages(3, 1, 'p04-s01') }),
    makePass({ number: 5, kind: 'added', after: null, pages: pages(1, 1, 'p05-s01') }),
  ]);
}

const toggle = (): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('checkbox', { name: 'Обороты на 180°' });
const targetText = (): string | null =>
  document.getElementById('rotate-target')?.textContent ?? null;
const row = (): HTMLElement => {
  const label = toggle().closest('label');
  if (label === null) {
    throw new Error('нет строки тумблера');
  }
  return label;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('тумблер 180° по пачке текущей (S9)', () => {
  it('AE6: текущая на обороте «Д1» — цель набора, переключение шлёт карту с флагом набора; основной не меняется', () => {
    const api = stubApi();
    renderEditor(withSets());

    // Текущая — первая страница: основной документ, флаг включён.
    expect(targetText()).toBe('обороты основного документа');
    expect(toggle().checked).toBe(true);
    expect(row().getAttribute('title')).toContain('Если обороты вверх ногами');

    fireEvent.click(option(4));
    expect(option(4).getAttribute('data-key')).toBe('p04-s01-0003');
    expect(targetText()).toBe('обороты набора Д1');
    expect(toggle().checked).toBe(false);
    expect(toggle().getAttribute('aria-describedby')).toBe('rotate-target');

    fireEvent.click(toggle());
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({
      edits: EMPTY_EDITS,
      rotate180: { 2: true, 4: true },
    });
  });

  it('текущая на лице основного документа — цель `backs`; выключение снимает только его флаг', () => {
    const api = stubApi();
    renderEditor(
      applied(withSets(), {
        edits: EMPTY_EDITS,
        rotate180: new Map([
          [2, true],
          [4, true],
        ]),
      }),
    );

    fireEvent.click(option(2));
    expect(targetText()).toBe('обороты основного документа');
    fireEvent.click(toggle());
    expect(lastSent(api)).toEqual({ edits: EMPTY_EDITS, rotate180: { 4: true } });
  });

  it('AE15: текущая на одностороннем «Д2» — недоступен с причиной в описании и title', () => {
    stubApi();
    renderEditor(withSets());

    fireEvent.click(option(12));
    expect(option(12).getAttribute('data-key')).toBe('p05-s01-0001');
    expect(toggle().disabled).toBe(true);
    expect(toggle().checked).toBe(false);
    expect(targetText()).toBe('у набора Д2 нет оборотов');
    expect(row().className).toBe('toggle-row toggle-row--disabled');
    expect(row().getAttribute('title')).toBe('у набора Д2 нет оборотов — поворачивать нечего');

    fireEvent.click(option(3));
    expect(toggle().disabled).toBe(false);
    expect(targetText()).toBe('обороты набора Д1');
  });

  it('оборотов нет ни у одной пачки — тумблер скрыт; основной без оборотов + набор с оборотами — виден', () => {
    stubApi();
    const { rerender } = renderEditor(
      makeSnapshot(
        [
          makePass({ pages: pages(2) }),
          makePass({ number: 2, kind: 'added', after: null, pages: pages(1, 1, 'p02-s01') }),
        ],
        {},
        { backsDeclined: true },
      ),
    );
    expect(screen.queryByRole('checkbox', { name: 'Обороты на 180°' })).toBeNull();

    rerender(
      makeSnapshot(
        [
          makePass({ pages: pages(2) }),
          makePass({
            number: 2,
            kind: 'addedFronts',
            after: null,
            backsDecision: 'none',
            pages: pages(1, 1, 'p02-s01'),
          }),
          makePass({ number: 3, kind: 'addedBacks', pair: 2, pages: pages(1, 1, 'p03-s01') }),
        ],
        {},
        { backsDeclined: true },
      ),
    );
    // Текущая — лицо основного документа: тумблер виден, но недоступен с причиной.
    expect(toggle().disabled).toBe(true);
    expect(targetText()).toBe('у основного документа нет оборотов');
    fireEvent.click(option(2));
    expect(toggle().disabled).toBe(false);
    expect(targetText()).toBe('обороты набора Д1');
  });

  it('Ctrl+Z после переключения возвращает прежний флаг нужного прохода; смена текущей — не шаг', async () => {
    const api = stubApi();
    const snapshot = withSets();
    const { rerender } = renderEditor(snapshot);

    fireEvent.click(option(4));
    fireEvent.click(toggle());
    await settle();
    rerender(applied(snapshot, lastSent(api)));
    expect(toggle().checked).toBe(true);

    // Смена текущей не создаёт шага: один Ctrl+Z возвращает флаг набора, второй — пусто.
    fireEvent.click(option(0));
    ctrlZ();
    expect(api.setEdits).toHaveBeenCalledTimes(2);
    expect(lastSent(api)).toEqual({ edits: EMPTY_EDITS, rotate180: { 2: true } });
    await settle();
    rerender({ ...snapshot, seq: snapshot.seq + 2 });
    ctrlZ();
    expect(api.setEdits).toHaveBeenCalledTimes(2);
  });

  it('«Вернуть» — пустая карта одним setEdits: все флаги в false', async () => {
    const api = stubApi();
    renderEditor(
      applied(withSets(), {
        edits: EMPTY_EDITS,
        rotate180: new Map([
          [2, true],
          [4, true],
        ]),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Вернуть' }));
    fireEvent.click(screen.getByRole('button', { name: 'Вернуть всё' }));
    await settle();
    expect(api.setEdits).toHaveBeenCalledExactlyOnceWith({ edits: EMPTY_EDITS, rotate180: {} });
  });

  it('переключение на уже стоящий флаг — не шаг: setEdits не уходит', () => {
    const api = stubApi();
    renderEditor(withSets());

    // Основной уже повёрнут: «включить» ещё раз нечего — чекбокс стоит, клик снимает.
    expect(toggle().checked).toBe(true);
    fireEvent.click(toggle());
    expect(lastSent(api)).toEqual({ edits: EMPTY_EDITS, rotate180: {} });
  });
});
