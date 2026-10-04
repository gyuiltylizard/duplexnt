import { BRIDGE_CHANNELS, ok, type BridgeHandlers, type ProbeResult } from '@shared';
import { describe, expect, it, vi } from 'vitest';
import { isFromMainFrame, registerBridge, type BridgeIpcMain } from './bridge';

const VALUE: ProbeResult = {
  echo: 't',
  versions: { electron: null, chrome: null, node: '24.0.0', sharp: '0.35.0', libvips: '8.17.0' },
  image: { format: 'jpeg', width: 8, height: 8, bytes: 100 },
};
const RESULT = ok(VALUE);

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

  // Проверяется обёртка регистрации, а не команды: всем, кроме пробы, — заглушка.
  const unused = (): Promise<never> => Promise.reject(new Error('команда не ожидалась'));
  const handlers = {
    ...(Object.fromEntries(
      Object.keys(BRIDGE_CHANNELS).map((command) => [command, unused]),
    ) as unknown as BridgeHandlers),
    probe: vi.fn(() => Promise.resolve(RESULT)),
  } satisfies BridgeHandlers;
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

  it('вызов из главного фрейма доходит до обработчика с сырым входом, ответ — конверт', async () => {
    const { mainFrame, webContents, handlers, probe } = setup();

    const result = await probe({ sender: webContents, senderFrame: mainFrame }, { token: 't' });

    expect(result).toBe(RESULT);
    expect(handlers.probe).toHaveBeenCalledExactlyOnceWith({ token: 't' });
  });

  it('исключение обработчика доходит до окна без своего сообщения: в нём бывают пути', async () => {
    const { mainFrame, webContents, handlers, probe } = setup();
    const secret = 'ENOSPC: no space left on device, open C:/Users/u/AppData/data/session.json';
    handlers.probe.mockRejectedValueOnce(new Error(secret));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const failure: unknown = await probe(
      { sender: webContents, senderFrame: mainFrame },
      { token: 't' },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('probe');
    expect((failure as Error).message).not.toContain('Users');
    expect((failure as Error).message).not.toContain('ENOSPC');
    // Полная ошибка не теряется: она в журнале main.
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0]?.[1])).toContain('ENOSPC');
    logged.mockRestore();
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
