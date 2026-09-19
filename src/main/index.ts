import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { APP_NAME } from '@shared';

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    title: APP_NAME,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  // Сломанный preload иначе молчит: окно откроется, а моста в нём не будет.
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[main] preload не загрузился: ${preloadPath}`, error);
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devServerUrl !== undefined) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
