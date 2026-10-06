import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSnapshot } from '@shared';
import {
  editStateOf,
  emptyHistory,
  recordEdit,
  redoEdit,
  sameState,
  syncHistory,
  tapeOf,
  undoEdit,
  type EditHistory,
  type EditState,
} from '../state/history';
import { NO_SELECTION, pruned, selectionOf, type Selection } from '../state/selection';

// Проводка правок редактора (план M3, U7; KTD-3, KTD-3a; журнал M3, сессия 3): undo-стек и
// выделение поверх снимка. Настоящее — правки последнего снимка; жест строится от него, уходит
// одним `setEdits`, и только успех ставит новую историю. Пока команда в полёте — до прихода
// снимка с её результатом — новые жесты и Ctrl+Z игнорируются: жест от устаревшего снимка молча
// откатил бы предыдущую правку.

/**
 * Сколько ждать снимка после успешного ответа. Правку, совпавшую с журналом после нормализации,
 * ядро не коммитит и снимка не шлёт: без срока редактор остался бы занятым навсегда (U8).
 */
export const SNAPSHOT_WAIT_MS = 1000;

/** Выделение после правки — по ленте пришедшего снимка; `null` — выделение не трогать. */
export type SelectAfter = (visible: readonly string[]) => Selection | null;

interface Pending {
  /** Метка команды: ответ и срок ожидания снимают только свою команду. */
  readonly id: symbol;
  /** Состояние снимка, от которого построен жест: снимок с другим — уже результат команды. */
  readonly base: EditState;
  readonly select: SelectAfter | null;
  /** Номер последнего снимка на момент успеха; `null` — ответа ещё нет. */
  readonly committedSeq: number | null;
}

export interface EditOptions {
  readonly select?: SelectAfter;
  /** После успеха команды — например, тост удаления. */
  readonly onSuccess?: () => void;
}

export interface EditorEdits {
  /** Правки последнего снимка — от них строится жест. */
  readonly current: EditState;
  readonly selection: Selection;
  readonly setSelection: (selection: Selection) => void;
  /** Команда в полёте: жесты и undo/redo игнорируются. */
  readonly busy: boolean;
  /**
   * Жест: новое состояние целиком и затронутые страницы (для выделения после Ctrl+Z). `false` —
   * команда не ушла: занято, заблокировано или жест ничего не меняет.
   */
  readonly edit: (next: EditState, keys: readonly string[], options?: EditOptions) => boolean;
  readonly undo: () => void;
  readonly redo: () => void;
}

export function useEditorEdits({
  seq,
  session,
  visible,
  locked,
}: {
  /** Номер снимка: снимок после успеха команды несёт её результат. */
  readonly seq: number;
  readonly session: SessionSnapshot;
  /** Видимая лента — ключи в порядке снимка. */
  readonly visible: readonly string[];
  /** Правки недоступны (идёт запись, KTD-9): жесты игнорируются. */
  readonly locked: boolean;
}): EditorEdits {
  const current = useMemo(() => editStateOf(session), [session]);

  // Лента изменилась не через правку — история очищается (решение автора, журнал M3).
  const tape = tapeOf(session);
  const [storedHistory, setHistory] = useState<EditHistory>(() => emptyHistory(tape));
  const history = syncHistory(storedHistory, tape);
  if (history !== storedHistory) {
    setHistory(history);
  }

  const [storedSelection, setSelection] = useState<Selection>(NO_SELECTION);
  const [pending, setPending] = useState<Pending | null>(null);

  // Пришёл снимок с результатом команды: выделение — по новой ленте (после удаления — сосед,
  // после Ctrl+Z — затронутые страницы). Корректировка при рендере, а не эффект: экран не
  // мелькает выделением, обрезанным по новой ленте.
  if (
    pending !== null &&
    pending.committedSeq !== null &&
    (seq > pending.committedSeq || !sameState(current, pending.base))
  ) {
    setPending(null);
    const chosen = pending.select?.(visible) ?? null;
    if (chosen !== null) {
      setSelection(chosen);
    }
  }

  const selection = useMemo(() => pruned(storedSelection, visible), [storedSelection, visible]);

  // Номер последнего показанного снимка — для ответа команды, который приходит вне рендера.
  const seqRef = useRef(seq);
  useEffect(() => {
    seqRef.current = seq;
  });

  // Сроки ожидания снимка снимаются вместе с экраном.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active) {
        clearTimeout(timer);
      }
      active.clear();
    };
  }, []);

  const send = (target: EditState, next: EditHistory, options: EditOptions = {}): void => {
    const id = Symbol('правка');
    setPending({ id, base: current, select: options.select ?? null, committedSeq: null });
    const settle = (): void => {
      setPending((previous) => (previous?.id === id ? null : previous));
    };
    window.api.setEdits({ edits: target.edits, rotate180: target.rotate180 }).then(
      (result) => {
        if (!result.ok) {
          // Отказ (`saving`, `passRunning`) — гонка: интерфейс эти состояния исключает. Шаг в
          // историю не попадает, снимок не меняется (handoff M3, гейтинг).
          console.error('[renderer] правка не принята', result.error);
          settle();
          return;
        }
        setHistory(next);
        setPending((previous) =>
          previous?.id === id ? { ...previous, committedSeq: seqRef.current } : previous,
        );
        // Снимок с результатом может не прийти вовсе — правка совпала с журналом после
        // нормализации, и ядро её не записало. Тогда «в полёте» снимается по сроку.
        const timer = setTimeout(() => {
          timers.current.delete(timer);
          settle();
        }, SNAPSHOT_WAIT_MS);
        timers.current.add(timer);
        options.onSuccess?.();
      },
      (error: unknown) => {
        console.error('[renderer] правка не отправлена', error);
        settle();
      },
    );
  };

  const idle = pending === null && !locked;

  return {
    current,
    selection,
    setSelection,
    busy: pending !== null,
    edit: (next, keys, options) => {
      const recorded = idle ? recordEdit(history, current, next, keys) : null;
      if (recorded === null) {
        return false;
      }
      send(next, recorded, options);
      return true;
    },
    undo: () => {
      const move = idle ? undoEdit(history, current) : null;
      if (move !== null) {
        send(move.target, move.history, { select: (after) => selectionOf(move.keys, after) });
      }
    },
    redo: () => {
      const move = idle ? redoEdit(history, current) : null;
      if (move !== null) {
        send(move.target, move.history, { select: (after) => selectionOf(move.keys, after) });
      }
    },
  };
}
