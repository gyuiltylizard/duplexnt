import { useMemo, useState } from 'react';
import { hasPages, isBacksKind, type DomainError, type SessionSnapshot } from '@shared';
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
  type HistoryMove,
} from '../state/history';
import { rolesOf } from '../state/screen';
import { NO_SELECTION, pruned, selectionOf, single, type Selection } from '../state/selection';

// Проводка правок редактора (план M3, U7; KTD-3, KTD-3a; журнал M3, сессия 3): undo-стек и
// выделение поверх снимка. Настоящее — правки последнего снимка; жест строится от него, уходит
// одним `setEdits`, и только успех ставит новую историю. Пока команда в полёте — до снимка с
// номером из её ответа — новые жесты и Ctrl+Z игнорируются: жест от устаревшего снимка молча
// откатил бы предыдущую правку. Ядро шлёт снимок после каждой принятой команды, даже если
// правки совпали с журналом, и возвращает его номер (ревью сессий 3–4).

/** Выделение после правки — по ленте пришедшего снимка; `null` — выделение не трогать. */
export type SelectAfter = (visible: readonly string[]) => Selection | null;

/**
 * Отказы-гонки: интерфейс эти состояния исключает (запись PDF блокирует правки, проход уводит с
 * экрана) — человеку о них не сообщается, только в консоль.
 */
const RACE_REASONS: readonly unknown[] = ['saving', 'passRunning'];

interface Pending {
  /** Метка команды: ответ снимает только свою команду. */
  readonly id: symbol;
  readonly select: SelectAfter | null;
  /** Номер снимка с результатом — из ответа; `null` — ответа ещё нет. */
  readonly seq: number | null;
}

export interface EditOptions {
  readonly select?: SelectAfter;
  /** После успеха команды — например, тост удаления. */
  readonly onSuccess?: () => void;
  /** Команда отклонена или мост не ответил — например, модалка `save` не пишет пакет. */
  readonly onFailure?: () => void;
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
  /** Ctrl+Z; `false` — команда не ушла: занято, заблокировано или откатывать нечего. */
  readonly undo: () => boolean;
  readonly redo: () => boolean;
}

export function useEditorEdits({
  seq,
  session,
  visible,
  order,
  initialCurrent,
  locked,
  onFailed,
}: {
  /** Номер снимка: снимок с номером из ответа команды несёт её результат. */
  readonly seq: number;
  readonly session: SessionSnapshot;
  /** Показанная лента — ключи в порядке снимка без скрытых пустых оборотов (M4, R11). */
  readonly visible: readonly string[];
  /** Полная видимая лента: текущая, ставшая скрытой, переезжает по ней на ближайшую показанную. */
  readonly order: readonly string[];
  /** Текущая при монтировании; `null` — первая в ленте (M3.5, S9: первая добавленная). */
  readonly initialCurrent: string | null;
  /** Правки недоступны (идёт запись, KTD-9): жесты игнорируются. */
  readonly locked: boolean;
  /** Правка не записалась: доменный отказ или `null` — мост не ответил. Гонки сюда не идут. */
  readonly onFailed: (error: DomainError | null) => void;
}): EditorEdits {
  const current = useMemo(() => editStateOf(session), [session]);

  // Лента изменилась не через правку — история очищается (решение автора, журнал M3).
  const tape = useMemo(() => tapeOf(session), [session]);
  const [storedHistory, setHistory] = useState<EditHistory>(() => emptyHistory(tape));
  const history = syncHistory(storedHistory, tape);
  if (history !== storedHistory) {
    setHistory(history);
  }

  const [storedSelection, setSelection] = useState<Selection>(() =>
    initialCurrent === null ? NO_SELECTION : single(initialCurrent),
  );
  const [pending, setPending] = useState<Pending | null>(null);

  // Показан снимок с результатом команды (его номер — из ответа; снимок мог прийти и раньше
  // ответа): выделение — по новой ленте (после удаления — сосед, после Ctrl+Z — затронутые
  // страницы). Корректировка при рендере, а не эффект: экран не мелькает выделением, обрезанным
  // по новой ленте.
  if (pending !== null && pending.seq !== null && seq >= pending.seq) {
    setPending(null);
    const chosen = pending.select?.(visible) ?? null;
    if (chosen !== null) {
      setSelection(chosen);
    }
  }

  const selection = useMemo(
    () => pruned(storedSelection, visible, order),
    [storedSelection, visible, order],
  );

  const send = (target: EditState, next: EditHistory, options: EditOptions = {}): void => {
    const id = Symbol('правка');
    setPending({ id, select: options.select ?? null, seq: null });
    const settle = (): void => {
      setPending((previous) => (previous?.id === id ? null : previous));
    };
    // Мост несёт флаги 180° картой по проходам оборотов (M4.5, KTD4); история редактора до U7
    // держит один флаг — на обороты основной пачки, флаги оборотов наборов идут как есть
    // (не названный проход ядро считает выключенным).
    const backs = rolesOf(session.passes).backs;
    const rotate180: Record<number, boolean> = Object.fromEntries(
      session.passes
        .filter((pass) => isBacksKind(pass.kind) && hasPages(pass))
        .map((pass): [number, boolean] => [
          pass.number,
          pass === backs ? target.rotate180 : pass.rotate180,
        ])
        .filter(([, flag]) => flag),
    );
    window.api.setEdits({ edits: target.edits, rotate180 }).then(
      (result) => {
        if (!result.ok) {
          // Шаг в историю не попадает, снимок не меняется (handoff M3, гейтинг).
          console.error('[renderer] правка не принята', result.error);
          settle();
          const { code, details } = result.error;
          if (code !== 'sessionConflict' || !RACE_REASONS.includes(details?.reason)) {
            onFailed(result.error);
          }
          options.onFailure?.();
          return;
        }
        setHistory(next);
        // Ждём снимка с этим номером; если он уже показан — рендер снимет ожидание сразу.
        const awaited = result.value.seq;
        setPending((previous) => (previous?.id === id ? { ...previous, seq: awaited } : previous));
        options.onSuccess?.();
      },
      (error: unknown) => {
        console.error('[renderer] правка не отправлена', error);
        settle();
        onFailed(null);
        options.onFailure?.();
      },
    );
  };

  const idle = pending === null && !locked;

  const travel = (move: HistoryMove | null): boolean => {
    if (move === null) {
      return false;
    }
    send(move.target, move.history, { select: (after) => selectionOf(move.keys, after) });
    return true;
  };

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
    undo: () => travel(idle ? undoEdit(history, current) : null),
    redo: () => travel(idle ? redoEdit(history, current) : null),
  };
}
