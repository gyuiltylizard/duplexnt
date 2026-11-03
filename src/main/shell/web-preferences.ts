// Настройки окна — чистый модуль без импорта Electron, закрытый тестом: правка вроде
// `sandbox: false`, «чтобы preload заработал», иначе прошла бы молча. Литеральные типы делают
// ослабление ещё и ошибкой компиляции.
export interface ShellWebPreferences {
  readonly preload: string;
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInWorker: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly webviewTag: false;
  readonly experimentalFeatures: false;
  /** DevTools закрыты в установленном приложении (B-29, U3); из `out/` и под dev — открыты. */
  readonly devTools: boolean;
}

export function buildWebPreferences(preloadPath: string, isPackaged: boolean): ShellWebPreferences {
  return {
    preload: preloadPath,
    devTools: !isPackaged,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
  };
}
