import type { Api, Snapshot } from '@shared';

// Хранилище снимка (план M1, U20; KTD-23): единственный источник состояния для экрана.
// Событие моста — подсказка перечитать, не данные: по нему снимок запрашивается командой.
// Ответы применяются по номеру `seq` — устаревший, пришедший позже, отбрасывается.

export type SnapshotApi = Pick<Api, 'getSnapshot' | 'onSnapshotChanged'>;

export interface SnapshotStore {
  /** Последний применённый снимок; `null` — первый запрос ещё не ответил. */
  readonly get: () => Snapshot | null;
  readonly subscribe: (listener: () => void) => () => void;
  /** Запросить снимок ещё раз — после команды, меняющей состояние, не дожидаясь события. */
  readonly refresh: () => void;
  /** Отписка от события моста; поздние ответы после неё не применяются. */
  readonly dispose: () => void;
}

export function createSnapshotStore(api: SnapshotApi): SnapshotStore {
  let snapshot: Snapshot | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();

  const apply = (next: Snapshot): void => {
    if (disposed || (snapshot !== null && next.seq <= snapshot.seq)) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const refresh = (): void => {
    api.getSnapshot().then(
      (result) => {
        if (result.ok) {
          apply(result.value);
        } else {
          // Доменного отказа у снимка не бывает: это ошибка программы, экран остаётся на прежнем.
          console.error('[renderer] снимок не прочитан', result.error);
        }
      },
      (error: unknown) => {
        console.error('[renderer] снимок не прочитан', error);
      },
    );
  };

  const unsubscribe = api.onSnapshotChanged(() => {
    refresh();
  });
  refresh();

  return {
    get: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    dispose: () => {
      disposed = true;
      unsubscribe();
    },
  };
}
