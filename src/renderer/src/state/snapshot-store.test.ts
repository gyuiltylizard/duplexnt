import { fail, ok, type CommandResult, type Snapshot } from '@shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotStore, type SnapshotApi } from './snapshot-store';

function makeSnapshot(seq: number): Snapshot {
  return {
    blankMode: 'hide',
    straightenMode: 'auto',
    straightenProgress: null,
    seenHints: [],
    seq,
    scanner: { kind: 'none' },
    session: null,
    assembly: null,
    pass: null,
    canResume: false,
    canAccept: false,
    storage: { incompatible: false, unsaved: false },
    notices: [],
  };
}

// Ответы на запросы снимка отдаются вручную и в любом порядке — так проверяется гонка.
function makeApi() {
  const listeners: ((payload: { seq: number }) => void)[] = [];
  const pending: ((result: CommandResult<'getSnapshot'>) => void)[] = [];
  const rejecters: ((error: unknown) => void)[] = [];
  const unsubscribe = vi.fn();
  const api: SnapshotApi = {
    getSnapshot: vi.fn(
      () =>
        new Promise<CommandResult<'getSnapshot'>>((resolve, reject) => {
          pending.push(resolve);
          rejecters.push(reject);
        }),
    ),
    onSnapshotChanged: vi.fn((listener: (payload: { seq: number }) => void) => {
      listeners.push(listener);
      return unsubscribe;
    }),
  };
  return {
    api,
    unsubscribe,
    fireEvent: (seq: number): void => {
      for (const listener of listeners) {
        listener({ seq });
      }
    },
    respond: (index: number, result: CommandResult<'getSnapshot'>): void => {
      pending[index]?.(result);
    },
    reject: (index: number, error: unknown): void => {
      rejecters[index]?.(error);
    },
    requests: () => pending.length,
  };
}

const flush = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('snapshot-store', () => {
  it('первый подписчик включает подписку на мост; снимок запрашивается и применяется', async () => {
    const { api, respond, requests } = makeApi();
    const store = createSnapshotStore(api);

    // До подписчиков хранилище к мосту не ходит.
    expect(requests()).toBe(0);
    expect(api.onSnapshotChanged).not.toHaveBeenCalled();

    const listener = vi.fn();
    store.subscribe(listener);
    expect(api.onSnapshotChanged).toHaveBeenCalledTimes(1);

    expect(store.get()).toBeNull();
    respond(0, ok(makeSnapshot(1)));
    await flush();

    expect(store.get()?.seq).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('событие моста — подсказка перечитать: снимок берётся командой, не из события', async () => {
    const { api, respond, fireEvent, requests } = makeApi();
    const store = createSnapshotStore(api);
    store.subscribe(vi.fn());
    respond(0, ok(makeSnapshot(1)));
    await flush();

    fireEvent(2);
    expect(requests()).toBe(2);
    respond(1, ok(makeSnapshot(2)));
    await flush();

    expect(store.get()?.seq).toBe(2);
  });

  it('события во время запроса склеиваются: после ответа — ровно один повтор (B-16)', async () => {
    const { api, respond, fireEvent, requests } = makeApi();
    const store = createSnapshotStore(api);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(requests()).toBe(1);

    // Пять уведомлений ядра по одной странице — запрос в полёте, новых нет.
    for (let seq = 2; seq <= 6; seq += 1) {
      fireEvent(seq);
    }
    expect(requests()).toBe(1);

    respond(0, ok(makeSnapshot(1)));
    await flush();
    // Один повтор за все пять событий…
    expect(requests()).toBe(2);
    respond(1, ok(makeSnapshot(6)));
    await flush();
    // …и ни одного сверх него: флаг снят.
    expect(requests()).toBe(2);
    expect(store.get()?.seq).toBe(6);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('снимок с меньшим номером, пришедший на повтор, отбрасывается', async () => {
    const { api, respond, fireEvent } = makeApi();
    const store = createSnapshotStore(api);
    const listener = vi.fn();
    store.subscribe(listener);

    fireEvent(3);
    respond(0, ok(makeSnapshot(3)));
    await flush();
    // Повтор ответил снимком не новее уже применённого — экран не трогается.
    respond(1, ok(makeSnapshot(2)));
    await flush();

    expect(store.get()?.seq).toBe(3);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('отказ запроса при поднятом флаге тоже даёт один повтор', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api, respond, reject, fireEvent, requests } = makeApi();
    const store = createSnapshotStore(api);
    store.subscribe(vi.fn());

    fireEvent(2);
    reject(0, new Error('мост упал'));
    await flush();

    expect(error).toHaveBeenCalled();
    expect(requests()).toBe(2);
    respond(1, ok(makeSnapshot(2)));
    await flush();
    expect(store.get()?.seq).toBe(2);
    expect(requests()).toBe(2);
  });

  it('уход последнего подписчика во время запроса гасит повтор: показывать некому', async () => {
    const { api, respond, fireEvent, requests } = makeApi();
    const store = createSnapshotStore(api);
    const unsubscribe = store.subscribe(vi.fn());

    fireEvent(2);
    unsubscribe();
    respond(0, ok(makeSnapshot(1)));
    await flush();

    expect(requests()).toBe(1);
  });

  it('уход последнего подписчика отписывается от моста', () => {
    const { api, unsubscribe } = makeApi();
    const store = createSnapshotStore(api);

    const unsubscribeFirst = store.subscribe(vi.fn());
    const unsubscribeSecond = store.subscribe(vi.fn());
    unsubscribeFirst();
    expect(unsubscribe).not.toHaveBeenCalled();

    unsubscribeSecond();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('повторная подписка (StrictMode) снова слушает мост и перечитывает снимок', async () => {
    const { api, respond, requests, unsubscribe } = makeApi();
    const store = createSnapshotStore(api);

    // Монтирование → размонтирование → монтирование, как делает StrictMode в dev. Первый запрос
    // ещё в полёте — перечитывание ложится в тот же повтор, события между подписками не теряются.
    store.subscribe(vi.fn())();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(api.onSnapshotChanged).toHaveBeenCalledTimes(2);
    expect(requests()).toBe(1);
    respond(0, ok(makeSnapshot(1)));
    await flush();
    expect(requests()).toBe(2);
    respond(1, ok(makeSnapshot(2)));
    await flush();

    expect(store.get()?.seq).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('отказ конверта не меняет состояние и не роняет окно', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api, respond } = makeApi();
    const store = createSnapshotStore(api);
    store.subscribe(vi.fn());

    respond(0, fail('invalidInput'));
    await flush();

    expect(store.get()).toBeNull();
    expect(error).toHaveBeenCalled();
  });
});
