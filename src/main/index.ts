import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { handleProbe } from '@core';
import { APP_NAME } from '@shared';
import { registerBridge } from './bridge';
import { denyAllPermissions, installShellGuards } from './shell/guards';
import { buildWebPreferences } from './shell/web-preferences';

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    title: APP_NAME,
    webPreferences: buildWebPreferences(join(__dirname, '../preload/index.js')),
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  // Сломанный preload иначе молчит: окно откроется, а моста в нём не будет.
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[main] preload не загрузился: ${preloadPath}`, error);
  });

  return window;
}

function loadRenderer(window: BrowserWindow): void {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServerUrl !== undefined) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// Гварды ставятся до первого окна: событие `web-contents-created` не повторяется.
installShellGuards(app);

void app.whenReady().then(() => {
  denyAllPermissions(session.defaultSession);

  // Мост регистрируется до загрузки страницы и получает окно: без него нечем проверить
  // отправителя. Обработчики зовут ядро с сырым входом — проверка входа живёт в ядре.
  const window = createWindow();
  registerBridge(ipcMain, window, {
    probe: (rawRequest) => handleProbe(rawRequest),
  });
  loadRenderer(window);
});

app.on('window-all-closed', () => {
  app.quit();
});
