import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { handleProbe } from '@core';
import { APP_NAME } from '@shared';
import { registerBridge } from './bridge';
import { resolveDataRoot } from './data-root';
import { denyAllPermissions, installShellGuards } from './shell/guards';
import { buildWebPreferences } from './shell/web-preferences';
import { acquireSingleInstance } from './single-instance';

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

// Порядок запуска задан явно (план M1, KTD-21): каталог данных → блокировка экземпляра → всё
// остальное. Блокировка лежит в `userData`, поэтому каталог `dev` выбирается до неё.
//
// Корень данных пока никто не берёт: первым его получит хранилище сессии (U13).
resolveDataRoot(app);

let mainWindow: BrowserWindow | null = null;

// Исключение при запуске оставило бы процесс без окна, но с блокировкой экземпляра: приложение
// не открылось бы и повторным запуском, пока процесс не снят вручную.
function startupFailed(error: unknown): void {
  console.error('[main] запуск не удался', error);
  app.exit(1);
}

if (acquireSingleInstance(app, () => mainWindow)) {
  // Гварды ставятся до первого окна: событие `web-contents-created` не повторяется.
  installShellGuards(app);

  app
    .whenReady()
    .then(() => {
      denyAllPermissions(session.defaultSession);

      // Мост регистрируется до загрузки страницы и получает окно: без него нечем проверить
      // отправителя. Обработчики зовут ядро с сырым входом — проверка входа живёт в ядре.
      const window = createWindow();
      mainWindow = window;
      registerBridge(ipcMain, window, {
        probe: (rawRequest) => handleProbe(rawRequest),
      });
      loadRenderer(window);
    })
    .catch(startupFailed);

  app.on('window-all-closed', () => {
    app.quit();
  });
}
