import { fail, ok, type CommandResult, type Snapshot } from '@shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotStore, type SnapshotApi } from './snapshot-store';

function makeSnapshot(seq: number): Snapshot {
  return {
    seq,
    scanner: { kind: 'none' },
    session: null,
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
  const unsubscribe = vi.fn();
  const api: SnapshotApi = {
    getSnapshot: vi.fn(
      () =>
        new Promise<CommandResult<'getSnapshot'>>((resolve) => {
          pending.push(resolve);
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
  it('первый снимок запрашивается сразу и применяется, подписчик уведомлён', async () => {
    const { api, respond } = makeApi();
    const store = createSnapshotStore(api);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.get()).toBeNull();
    respond(0, ok(makeSnapshot(1)));
    await flush();

    expect(store.get()?.seq).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('событие моста — подсказка перечитать: снимок берётся командой, не из события', async () => {
    const { api, respond, fireEvent, requests } = makeApi();
    const store = createSnapshotStore(api);
    respond(0, ok(makeSnapshot(1)));
    await flush();

    fireEvent(2);
    expect(requests()).toBe(2);
    respond(1, ok(makeSnapshot(2)));
    await flush();

    expect(store.get()?.seq).toBe(2);
  });

  it('снимок с меньшим номером, пришедший позже, отбрасывается', async () => {
    const { api, respond, fireEvent } = makeApi();
    const store = createSnapshotStore(api);
    const listener = vi.fn();
    store.subscribe(listener);

    fireEvent(3);
    // Ответ на второй запрос обгоняет ответ на первый.
    respond(1, ok(makeSnapshot(3)));
    await flush();
    respond(0, ok(makeSnapshot(2)));
    await flush();

    expect(store.get()?.seq).toBe(3);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispose отписывается от события, поздний ответ не применяется', async () => {
    const { api, respond, unsubscribe } = makeApi();
    const store = createSnapshotStore(api);

    store.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    respond(0, ok(makeSnapshot(1)));
    await flush();
    expect(store.get()).toBeNull();
  });

  it('отказ конверта не меняет состояние и не роняет окно', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { api, respond } = makeApi();
    const store = createSnapshotStore(api);

    respond(0, fail('invalidInput'));
    await flush();

    expect(store.get()).toBeNull();
    expect(error).toHaveBeenCalled();
  });
});
