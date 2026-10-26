// Ядро: всё, что работает без Electron, — сеть, файлы, изображения. Импортировать `electron`
// и вышележащие слои отсюда нельзя (ловит lint). Здесь — то, что берёт main.

export { createCommands, type CommandContext, type Commands } from './commands/handlers';
export { handleProbe } from './probe/handle-probe';
export { openPassService, type PassService, type PassServiceOptions } from './scan/pass-service';
export { isPageKey, isSessionId, layoutOf } from './storage/layout';
export { createThumbnails, type Thumbnails } from './storage/thumbnails';
export {
  openWindowStateStore,
  type WindowBounds,
  type WindowState,
  type WindowStateStore,
} from './storage/window-state';
