import { BRIDGE_EVENT_CHANNELS } from '@shared';
import { describe, expect, it, vi } from 'vitest';
import { createEventSender } from './events';

function setup(state = { window: false, webContents: false }) {
  const send = vi.fn<(channel: string, payload: unknown) => void>();
  const window = {
    isDestroyed: () => state.window,
    webContents: { isDestroyed: () => state.webContents, send },
  };
  return { send, state, emit: createEventSender(window) };
}

describe('createEventSender', () => {
  it('событие уходит в канал контракта с номером', () => {
    const { send, emit } = setup();

    emit('snapshotChanged', { seq: 7 });

    expect(send).toHaveBeenCalledExactlyOnceWith(BRIDGE_EVENT_CHANNELS.snapshotChanged, { seq: 7 });
  });

  it('отправка в разрушенное окно не бросает и ничего не шлёт', () => {
    const { send, state, emit } = setup();

    state.window = true;
    expect(() => {
      emit('snapshotChanged', { seq: 1 });
    }).not.toThrow();

    state.window = false;
    state.webContents = true;
    expect(() => {
      emit('snapshotChanged', { seq: 2 });
    }).not.toThrow();

    expect(send).not.toHaveBeenCalled();
  });

  it('окно, разрушенное после создания отправителя, проверяется при каждой отправке', () => {
    const { send, state, emit } = setup();

    emit('snapshotChanged', { seq: 1 });
    state.window = true;
    emit('snapshotChanged', { seq: 2 });

    expect(send).toHaveBeenCalledExactlyOnceWith(BRIDGE_EVENT_CHANNELS.snapshotChanged, { seq: 1 });
  });
});
