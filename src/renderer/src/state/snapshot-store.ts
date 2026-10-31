import type { Api, Snapshot } from '@shared';

// Хранилище снимка (план M1, U20; KTD-23): единственный источник состояния для экрана.
// Событие моста — подсказка перечитать, не данные: по нему снимок запрашивается командой.
// Ответы применяются по номеру `seq` — устаревший, пришедший позже, отбрасывается.
//
// Запросы склеиваются (B-16): на страницу прохода ядро шлёт 3–5 событий (приём, вердикты,
// коррекция), а каждый запрос — полная сборка ленты в main и structured clone по IPC. Пока
// запрос в полёте, события лишь поднимают флаг `dirty`; по ответу делается ровно один повтор.
// Последний снимок доезжает всегда, промежуточные — нет, они и не нужны.
//
// Подписка на мост живёт от первого подписчика до последнего: React в StrictMode монтирует
// дважды (подписка → отписка → подписка), и хранилище обязано пережить этот цикл — повторная
// подписка снова слушает мост и перечитывает снимок.

export type SnapshotApi = Pick<Api, 'getSnapshot' | 'onSnapshotChanged'>;

export interface SnapshotStore {
  /** Последний применённый снимок; `null` — первый запрос ещё не ответил. */
  readonly get: () => Snapshot | null;
  /** Первый подписчик включает подписку на мост, уход последнего — выключает. */
  readonly subscribe: (listener: () => void) => () => void;
}

export function createSnapshotStore(api: SnapshotApi): SnapshotStore {
  let snapshot: Snapshot | null = null;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | null = null;

  const apply = (next: Snapshot): void => {
    if (snapshot !== null && next.seq <= snapshot.seq) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };

  let inFlight = false;
  let dirty = false;

  const refresh = (): void => {
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    dirty = false;
    api
      .getSnapshot()
      .then(
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
      )
      .finally(() => {
        inFlight = false;
        // Без подписчиков повтор некому показать; новая подписка перечитает сама.
        if (dirty && unsubscribe !== null) {
          refresh();
        }
      });
  };

  return {
    get: () => snapshot,
    subscribe: (listener) => {
      // `unsubscribe === null` ⇔ подписчиков нет: подписка на мост живёт с первым из них.
      if (unsubscribe === null) {
        unsubscribe = api.onSnapshotChanged(() => {
          refresh();
        });
        // Между отпиской и новой подпиской события могли пропасть — снимок перечитывается.
        refresh();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribe !== null) {
          unsubscribe();
          unsubscribe = null;
        }
      };
    },
  };
}
