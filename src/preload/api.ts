import {
  BRIDGE_CHANNELS,
  BRIDGE_EVENT_CHANNELS,
  type Api,
  type BridgeCommand,
  type BridgeEvent,
  type BridgeEvents,
  type CommandsApi,
  type Unsubscribe,
} from '@shared';

// Сборка `window.api`. `ipcRenderer` приходит аргументом и описан структурно: модуль не
// импортирует Electron и проверяется подставным объектом под обычным Node.

type IpcListener = (event: unknown, payload: unknown) => void;

export interface PreloadIpcRenderer {
  invoke(channel: string, request: unknown): Promise<unknown>;
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
}

// По функции на команду, канал зашит. Наружу не уходят ни `ipcRenderer`, ни функция с
// произвольным каналом, ни объекты событий.
function command<K extends BridgeCommand>(
  ipcRenderer: PreloadIpcRenderer,
  name: K,
): CommandsApi[K] {
  return ((request: unknown) =>
    ipcRenderer.invoke(BRIDGE_CHANNELS[name], request)) as CommandsApi[K];
}

// По функции-подписке на событие. Обработчик интерфейса получает только данные события: объект
// события Electron несёт `sender` — через него в окно утёк бы `ipcRenderer`.
function subscription<K extends BridgeEvent>(ipcRenderer: PreloadIpcRenderer, name: K) {
  return (listener: (payload: BridgeEvents[K]) => void): Unsubscribe => {
    const channel = BRIDGE_EVENT_CHANNELS[name];
    const forward: IpcListener = (_event, payload) => {
      listener(payload as BridgeEvents[K]);
    };

    ipcRenderer.on(channel, forward);
    return () => {
      ipcRenderer.removeListener(channel, forward);
    };
  };
}

export function buildApi(ipcRenderer: PreloadIpcRenderer): Api {
  return {
    probe: command(ipcRenderer, 'probe'),
    getSnapshot: command(ipcRenderer, 'getSnapshot'),
    startDiscovery: command(ipcRenderer, 'startDiscovery'),
    getDiscovery: command(ipcRenderer, 'getDiscovery'),
    stopDiscovery: command(ipcRenderer, 'stopDiscovery'),
    connectScanner: command(ipcRenderer, 'connectScanner'),
    cancelConnect: command(ipcRenderer, 'cancelConnect'),
    recheckScanner: command(ipcRenderer, 'recheckScanner'),
    setScanParams: command(ipcRenderer, 'setScanParams'),
    setBlankMode: command(ipcRenderer, 'setBlankMode'),
    markHintSeen: command(ipcRenderer, 'markHintSeen'),
    startPass: command(ipcRenderer, 'startPass'),
    stopPass: command(ipcRenderer, 'stopPass'),
    acceptPass: command(ipcRenderer, 'acceptPass'),
    declineBacks: command(ipcRenderer, 'declineBacks'),
    assemble: command(ipcRenderer, 'assemble'),
    setEdits: command(ipcRenderer, 'setEdits'),
    keepSetBacks: command(ipcRenderer, 'keepSetBacks'),
    rescanSetBacks: command(ipcRenderer, 'rescanSetBacks'),
    getSaveFolder: command(ipcRenderer, 'getSaveFolder'),
    chooseSaveFolder: command(ipcRenderer, 'chooseSaveFolder'),
    saveDocuments: command(ipcRenderer, 'saveDocuments'),
    closeSession: command(ipcRenderer, 'closeSession'),
    openDataFolder: command(ipcRenderer, 'openDataFolder'),
    openSaveFolder: command(ipcRenderer, 'openSaveFolder'),
    onSnapshotChanged: subscription(ipcRenderer, 'snapshotChanged'),
    onDiscoveryChanged: subscription(ipcRenderer, 'discoveryChanged'),
  };
}
