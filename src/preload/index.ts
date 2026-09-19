import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_CHANNELS, type Api, type ProbeResult } from '@shared';

// По функции на команду, канал зашит. Наружу не уходят ни `ipcRenderer`, ни функция с
// произвольным каналом, ни объекты событий. Под sandbox это один CJS-файл с вбандленным shared.
const api: Api = {
  probe: (request) => ipcRenderer.invoke(BRIDGE_CHANNELS.probe, request) as Promise<ProbeResult>,
};

contextBridge.exposeInMainWorld('api', api);
