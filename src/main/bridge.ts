import { BRIDGE_CHANNELS, type BridgeCommand, type BridgeHandlers } from '@shared';

// Регистрация моста в main — единственная точка входа для вызовов из интерфейса. Electron
// здесь не импортируется: `ipcMain` и окно приходят аргументами и описаны структурно, поэтому
// проверка отправителя тестируется подставным событием под обычным Node.

interface BridgeSenderEvent {
  readonly sender: unknown;
  readonly senderFrame: unknown;
}

interface BridgeWindow {
  isDestroyed(): boolean;
  readonly webContents: { readonly mainFrame: unknown };
}

export interface BridgeIpcMain {
  handle(
    channel: string,
    listener: (event: BridgeSenderEvent, rawRequest: unknown) => Promise<unknown>,
  ): void;
}

// Вызов принимается только из главного фрейма окна приложения: не из iframe, не из другого
// webContents и не после уничтожения окна.
export function isFromMainFrame(event: BridgeSenderEvent, window: BridgeWindow): boolean {
  if (window.isDestroyed()) {
    return false;
  }
  return (
    event.sender === window.webContents &&
    event.senderFrame !== null &&
    event.senderFrame === window.webContents.mainFrame
  );
}

export function registerBridge(
  ipcMain: BridgeIpcMain,
  window: BridgeWindow,
  handlers: BridgeHandlers,
): void {
  for (const command of Object.keys(BRIDGE_CHANNELS) as BridgeCommand[]) {
    ipcMain.handle(BRIDGE_CHANNELS[command], async (event, rawRequest) => {
      if (!isFromMainFrame(event, window)) {
        throw new Error(`мост: отправитель команды «${command}» — не главный фрейм окна`);
      }
      try {
        return await handlers[command](rawRequest);
      } catch (error) {
        // Доменный отказ приходит значением в конверте; исключение — ошибка программы. Его
        // сообщение Electron передал бы в окно дословно, а в нём бывают пути и адреса: полная
        // ошибка остаётся в журнале main, в окно уходит только имя команды (`cause` через
        // границу процессов не передаётся).
        console.error(`[main] мост: команда «${command}» упала`, error);
        throw new Error(`мост: команда «${command}» завершилась ошибкой программы`, {
          cause: error,
        });
      }
    });
  }
}
