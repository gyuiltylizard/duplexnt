import { BRIDGE_CHANNELS, type BridgeHandlers, type ProbeResult } from '@shared';
import { describe, expect, it, vi } from 'vitest';
import { isFromMainFrame, registerBridge, type BridgeIpcMain } from './bridge';

const RESULT: ProbeResult = {
  echo: 't',
  versions: { electron: null, chrome: null, node: '24.0.0', sharp: '0.35.0', libvips: '8.17.0' },
  image: { format: 'jpeg', width: 8, height: 8, bytes: 100 },
};

function setup() {
  const mainFrame = { name: 'main' };
  const webContents = { mainFrame };
  const window = { isDestroyed: () => false, webContents };

  type Listener = Parameters<BridgeIpcMain['handle']>[1];
  const listeners = new Map<string, Listener>();
  const ipcMain: BridgeIpcMain = {
    handle: (channel: string, listener: Listener) => {
      listeners.set(channel, listener);
    },
  };

  const handlers = { probe: vi.fn(() => Promise.resolve(RESULT)) } satisfies BridgeHandlers;
  registerBridge(ipcMain, window, handlers);

  const probe = listeners.get(BRIDGE_CHANNELS.probe);
  if (probe === undefined) {
    throw new Error('канал пробы не зарегистрирован');
  }
  return { mainFrame, webContents, window, handlers, probe, listeners };
}

describe('isFromMainFrame', () => {
  it('принимает только главный фрейм окна приложения', () => {
    const { mainFrame, webContents, window } = setup();

    expect(isFromMainFrame({ sender: webContents, senderFrame: mainFrame }, window)).toBe(true);
    expect(isFromMainFrame({ sender: webContents, senderFrame: { name: 'iframe' } }, window)).toBe(
      false,
    );
    expect(isFromMainFrame({ sender: webContents, senderFrame: null }, window)).toBe(false);
    expect(isFromMainFrame({ sender: { mainFrame }, senderFrame: mainFrame }, window)).toBe(false);
  });

  it('отклоняет всё, если окно уже уничтожено', () => {
    const { mainFrame, webContents } = setup();
    const destroyed = { isDestroyed: () => true, webContents };

    expect(isFromMainFrame({ sender: webContents, senderFrame: mainFrame }, destroyed)).toBe(false);
  });
});

describe('registerBridge', () => {
  it('регистрирует ровно каналы контракта', () => {
    const { listeners } = setup();
    expect([...listeners.keys()].sort()).toEqual(Object.values(BRIDGE_CHANNELS).sort());
  });

  it('вызов из главного фрейма доходит до обработчика с сырым входом', async () => {
    const { mainFrame, webContents, handlers, probe } = setup();

    const result = await probe({ sender: webContents, senderFrame: mainFrame }, { token: 't' });

    expect(result).toBe(RESULT);
    expect(handlers.probe).toHaveBeenCalledExactlyOnceWith({ token: 't' });
  });

  it('чужой отправитель получает отказ, обработчик ядра не вызван', async () => {
    const { webContents, handlers, probe } = setup();

    await expect(
      probe({ sender: webContents, senderFrame: { name: 'iframe' } }, { token: 't' }),
    ).rejects.toThrow(/отправитель/);
    await expect(probe({ sender: {}, senderFrame: null }, { token: 't' })).rejects.toThrow();
    expect(handlers.probe).not.toHaveBeenCalled();
  });
});
