import { EMPTY_EDITS, type PassSnapshot, type SessionEdits, type SessionSnapshot } from '@shared';
import { describe, expect, it } from 'vitest';
import { REVERTED, deleted, rotated } from './edits';
import {
  editStateOf,
  emptyHistory,
  recordEdit,
  redoEdit,
  syncHistory,
  tapeOf,
  undoEdit,
  type EditHistory,
  type EditState,
} from './history';

// Undo/redo редактора (план M3, U6): последовательности шагов, групповая операция и «Вернуть»
// как один шаг, перебазирование на снимок без роста стека, очистка при изменении ленты вне
// правок (решение автора, журнал M3).

const state = (edits: Partial<SessionEdits>, rotate180 = false): EditState => ({
  edits: { ...EMPTY_EDITS, ...edits },
  rotate180,
});

const S0 = state({});
const TAPE = ['a', 'b', 'c', 'd'];

/** Редактор в миниатюре: правки снимка + история, как их будет вести EditorScreen. */
class Editor {
  current: EditState;
  history: EditHistory;

  constructor(initial: EditState) {
    this.current = initial;
    this.history = emptyHistory('лента');
  }

  edit(next: EditState, keys: readonly string[]): void {
    const history = recordEdit(this.history, this.current, next, keys);
    if (history !== null) {
      this.history = history;
      this.current = next; // снимок принёс отправленное
    }
  }

  undo(): readonly string[] | null {
    const move = undoEdit(this.history, this.current);
    if (move === null) {
      return null;
    }
    this.history = move.history;
    this.current = move.target;
    return move.keys;
  }

  redo(): readonly string[] | null {
    const move = redoEdit(this.history, this.current);
    if (move === null) {
      return null;
    }
    this.history = move.history;
    this.current = move.target;
    return move.keys;
  }
}

describe('история правок', () => {
  it('правки отменяются и возвращаются по одной, в обратном порядке', () => {
    const editor = new Editor(S0);
    const turned = state(rotated(S0.edits, ['a']));
    const removed = state(deleted(turned.edits, TAPE, ['b']));
    editor.edit(turned, ['a']);
    editor.edit(removed, ['b']);

    expect(editor.undo()).toEqual(['b']);
    expect(editor.current).toEqual(turned);
    expect(editor.undo()).toEqual(['a']);
    expect(editor.current).toEqual(S0);
    expect(editor.undo()).toBeNull();
    expect(editor.current).toEqual(S0);

    expect(editor.redo()).toEqual(['a']);
    expect(editor.current).toEqual(turned);
    expect(editor.redo()).toEqual(['b']);
    expect(editor.current).toEqual(removed);
    expect(editor.redo()).toBeNull();
  });

  it('новая правка после отмены очищает redo (R6)', () => {
    const editor = new Editor(S0);
    editor.edit(state(rotated(S0.edits, ['a'])), ['a']);
    editor.undo();
    editor.edit(state(deleted(S0.edits, TAPE, ['c'])), ['c']);

    expect(editor.history.future).toEqual([]);
    expect(editor.redo()).toBeNull();
    expect(editor.history.past).toHaveLength(1);
  });

  it('правка без изменений — не шаг', () => {
    const history = emptyHistory('лента');

    expect(recordEdit(history, S0, state({}), ['a'])).toBeNull();
  });

  it('групповой поворот и удаление — по одному шагу; отмена выделяет всю группу (R7)', () => {
    const editor = new Editor(S0);
    editor.edit(state(rotated(S0.edits, ['a', 'b', 'c'])), ['a', 'b', 'c']);
    editor.edit(state(deleted(editor.current.edits, TAPE, ['b', 'd'])), ['b', 'd']);

    expect(editor.history.past).toHaveLength(2);
    expect(editor.undo()).toEqual(['b', 'd']);
    expect(editor.current.edits.deleted).toEqual([]);
    expect(editor.undo()).toEqual(['a', 'b', 'c']);
    expect(editor.current).toEqual(S0);
  });

  it('«Вернуть» с тумблером — один шаг; Ctrl+Z возвращает и правки, и тумблер (AE4)', () => {
    const edited = state({ cuts: [2], names: ['Акт', 'Счёт'], deleted: ['c'] }, true);
    const editor = new Editor(edited);
    editor.edit(REVERTED, []);

    expect(editor.current).toEqual(REVERTED);
    expect(editor.history.past).toHaveLength(1);
    expect(editor.undo()).toEqual([]);
    expect(editor.current).toEqual(edited);
    expect(editor.redo()).toEqual([]);
    expect(editor.current).toEqual(REVERTED);
  });

  it('тумблер 180° — правка, отменяемая как любая', () => {
    const editor = new Editor(S0);
    editor.edit(state({}, true), []);

    expect(editor.undo()).toEqual([]);
    expect(editor.current).toEqual(S0);
  });

  it('снимок принёс нормализованные правки: вершина — они, глубина стека не растёт (KTD-3a)', () => {
    const editor = new Editor(state({ cuts: [2], names: ['', ''] }));
    // Жест удалил второй документ целиком: ушло [2, 2], ядро схлопнуло до одного документа.
    editor.edit(state({ cuts: [2, 2], names: ['', '', ''], deleted: ['c', 'd'] }), ['c', 'd']);
    const normalized = state({ cuts: [], names: [''], deleted: ['c', 'd'] });
    editor.history = syncHistory(editor.history, 'лента');
    editor.current = normalized;

    expect(editor.history.past).toHaveLength(1);
    expect(editor.undo()).toEqual(['c', 'd']);
    expect(editor.current).toEqual(state({ cuts: [2], names: ['', ''] }));
    // В будущее ушло то, что пришло снимком, а не сырое состояние жеста.
    expect(editor.history.future.map((step) => step.state)).toEqual([normalized]);
  });

  it('лента изменилась не через правку — история очищается; правка её не очищает', () => {
    const editor = new Editor(S0);
    editor.edit(state(rotated(S0.edits, ['a'])), ['a']);
    editor.undo();
    editor.edit(state(rotated(S0.edits, ['b'])), ['b']);

    const same = syncHistory(editor.history, 'лента');
    expect(same).toBe(editor.history);

    const grown = syncHistory(editor.history, 'лента+досканировано');
    expect(grown).toEqual({ tape: 'лента+досканировано', past: [], future: [] });
    expect(syncHistory(null, 'лента')).toEqual(emptyHistory('лента'));
  });
});

describe('подпись ленты и состояние снимка', () => {
  const pass = (number: number, keys: readonly string[], extra: Partial<PassSnapshot> = {}) =>
    ({
      number,
      state: 'completed',
      paramsKnown: true,
      scanner: null,
      kind: number === 1 ? 'fronts' : 'backs',
      after: null,
      rotate180: false,
      pages: keys.map((key, index) => ({ key, number: index + 1, lost: false })),
      ...extra,
    }) satisfies PassSnapshot;

  const session = (extra: Partial<SessionSnapshot>): SessionSnapshot => ({
    id: 'session.20261006-120000-abcd',
    backsDeclined: false,
    saved: false,
    edits: EMPTY_EDITS,
    assembled: null,
    blankMode: 'keep',
    passes: [pass(1, ['f1', 'f2']), pass(2, ['b1', 'b2'])],
    ...extra,
  });

  const BASE = session({});

  it.each([
    ['правки', session({ edits: { ...EMPTY_EDITS, deleted: ['f1'], cuts: [1], names: ['', ''] } })],
    [
      'тумблер 180°',
      session({ passes: [pass(1, ['f1', 'f2']), pass(2, ['b1', 'b2'], { rotate180: true })] }),
    ],
    ['отметка «сохранено»', session({ saved: true })],
    // Граница наборов — правка, как разрез: историю не чистит (M3.6).
    ['граница наборов', session({ edits: { ...EMPTY_EDITS, divider: 1 } })],
    [
      'потеря файла страницы',
      session({
        passes: [
          pass(1, ['f1', 'f2']),
          {
            ...pass(2, ['b1', 'b2']),
            pages: [
              { key: 'b1', number: 1, lost: true },
              { key: 'b2', number: 2, lost: false },
            ],
          },
        ],
      }),
    ],
  ])('не меняется: %s', (_name, changed) => {
    expect(tapeOf(changed)).toBe(tapeOf(BASE));
  });

  it.each([
    [
      'досканирование дописало страницу',
      session({ passes: [pass(1, ['f1', 'f2']), pass(2, ['b1', 'b2', 'b3'])] }),
    ],
    ['«Остановить» убрал страницу', session({ passes: [pass(1, ['f1', 'f2']), pass(2, ['b1'])] })],
    [
      'прерванный проход принят',
      session({ passes: [pass(1, ['f1', 'f2']), pass(2, ['b1', 'b2'], { state: 'accepted' })] }),
    ],
    ['новая сессия', session({ id: 'session.20261006-130000-dcba' })],
    // M3.6 (R14, KTD5): «Собрать документ» пишет запись — стек после сборки пуст (AE4).
    ['документ собран', session({ assembled: ['f1', 'b2', 'f2', 'b1'] })],
  ])('меняется: %s', (_name, changed) => {
    expect(tapeOf(changed)).not.toBe(tapeOf(BASE));
  });

  it('тумблер — у прохода оборотов по kind, не по позиции (M3.5, KTD-4)', () => {
    const fronts = pass(1, ['f1']);
    const added = pass(2, ['a1'], { kind: 'added', after: 'f1' });
    const backs = pass(3, ['b1'], { kind: 'backs', rotate180: true });
    expect(editStateOf(session({ passes: [fronts, added, backs] })).rotate180).toBe(true);
    expect(editStateOf(session({ passes: [fronts, added] })).rotate180).toBe(false);
  });

  it('состояние стека — правки снимка и тумблер прохода оборотов', () => {
    const edits = { ...EMPTY_EDITS, deleted: ['f1'] };
    const rotatedBacks = session({
      edits,
      passes: [pass(1, ['f1', 'f2']), pass(2, ['b1', 'b2'], { rotate180: true })],
    });

    expect(editStateOf(rotatedBacks)).toEqual({ edits, rotate180: true });
    expect(editStateOf(session({ passes: [pass(1, ['f1'])] }))).toEqual({
      edits: EMPTY_EDITS,
      rotate180: false,
    });
  });
});
