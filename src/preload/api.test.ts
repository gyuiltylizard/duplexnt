import { BRIDGE_CHANNELS, BRIDGE_EVENT_CHANNELS } from '@shared';
import { describe, expect, it, vi } from 'vitest';
import { buildApi, type PreloadIpcRenderer } from './api';

type Listener = Parameters<PreloadIpcRenderer['on']>[1];

function setup() {
  const listeners = new Map<string, Set<Listener>>();
  const invoke = vi.fn<PreloadIpcRenderer['invoke']>(() => Promise.resolve('ответ'));
  const ipcRenderer: PreloadIpcRenderer = {
    invoke,
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set<Listener>();
      listeners.set(channel, set.add(listener));
    },
    removeListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener);
    },
  };
  const emit = (channel: string, payload: unknown): void => {
    for (const listener of listeners.get(channel) ?? []) {
      listener({ sender: ipcRenderer }, payload);
    }
  };
  return { api: buildApi(ipcRenderer), invoke, emit, listeners };
}

describe('buildApi', () => {
  it('наружу — только функции команд и подписок, без ipcRenderer и сквозного канала', () => {
    const { api } = setup();

    expect(Object.keys(api).sort()).toEqual(['onDiscoveryChanged', 'onSnapshotChanged', 'probe']);
    expect(Object.values(api).every((member) => typeof member === 'function')).toBe(true);
  });

  it('команда уходит в свой канал с запросом как есть', async () => {
    const { api, invoke } = setup();

    await expect(api.probe({ token: 't' })).resolves.toBe('ответ');
    expect(invoke).toHaveBeenCalledExactlyOnceWith(BRIDGE_CHANNELS.probe, { token: 't' });
  });

  it('подписчик получает данные события с номером, а не объект события', () => {
    const { api, emit } = setup();
    const listener = vi.fn();

    api.onSnapshotChanged(listener);
    emit(BRIDGE_EVENT_CHANNELS.snapshotChanged, { seq: 3 });

    expect(listener).toHaveBeenCalledExactlyOnceWith({ seq: 3 });
  });

  it('после отписки обработчик не вызывается; второй подписчик продолжает получать', () => {
    const { api, emit, listeners } = setup();
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribe = api.onSnapshotChanged(first);
    api.onSnapshotChanged(second);
    unsubscribe();
    emit(BRIDGE_EVENT_CHANNELS.snapshotChanged, { seq: 4 });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith({ seq: 4 });
    expect(listeners.get(BRIDGE_EVENT_CHANNELS.snapshotChanged)?.size).toBe(1);
  });

  it('повторная отписка безвредна', () => {
    const { api } = setup();
    const unsubscribe = api.onSnapshotChanged(vi.fn());

    unsubscribe();
    expect(unsubscribe).not.toThrow();
  });
});
