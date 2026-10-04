import { contextBridge, ipcRenderer } from 'electron';
import { buildApi } from './api';

// Под sandbox это один CJS-файл с вбандленными shared и ./api. Состав `window.api` — в ./api.ts.
contextBridge.exposeInMainWorld('api', buildApi(ipcRenderer));
