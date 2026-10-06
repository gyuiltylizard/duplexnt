import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from 'electron';
import { join } from 'node:path';
import { createCommands, createThumbnails, layoutOf, openPassService } from '@core';
import ru from '@locales/ru/common.json';
import { APP_NAME, fail, ok, PAGE_IMAGE_SCHEME } from '@shared';
import { registerBridge } from './bridge';
import { resolveDataRoot } from './data-root';
import { createEventSender } from './events';
import { handlePageImageRequest, PAGE_SCHEME_REGISTRATION } from './page-protocol';
import { denyAllPermissions, installShellGuards } from './shell/guards';
import { installShortcutGuard } from './shell/shortcuts';
import { buildWebPreferences } from './shell/web-preferences';
import { acquireSingleInstance } from './single-instance';
import { installWindowClose } from './window-close';

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
const dataRoot = resolveDataRoot(app);

let mainWindow: BrowserWindow | null = null;

// Исключение при запуске оставило бы процесс без окна, но с блокировкой экземпляра: приложение
// не открылось бы и повторным запуском, пока процесс не снят вручную.
function startupFailed(error: unknown): void {
  console.error('[main] запуск не удался', error);
  app.exit(1);
}

// Сверка при запуске бросает только на неожиданной ошибке чтения каталога данных: файл занят
// другим процессом, на месте каталога — файл. Открывать хранилище без сверки нельзя — пользователь
// видит причину и запускает приложение снова.
function storageUnreadable(error: unknown): void {
  console.error('[main] каталог данных не прочитан', error);
  dialog.showErrorBox(ru.startup.storageUnreadableTitle, ru.startup.storageUnreadable);
  app.exit(1);
}

async function start(): Promise<void> {
  denyAllPermissions(session.defaultSession);

  // Мост регистрируется до загрузки страницы и получает окно: без него нечем проверить
  // отправителя. Обработчики зовут ядро с сырым входом — проверка входа живёт в ядре.
  const window = createWindow();
  mainWindow = window;
  const send = createEventSender(window);

  let service;
  try {
    service = await openPassService(dataRoot, {
      onChange: (seq) => {
        send('snapshotChanged', { seq });
      },
    });
  } catch (error) {
    storageUnreadable(error);
    return;
  }

  // Схема изображений: страницы и миниатюры текущей сессии по ключу (KTD-38).
  const thumbnails = createThumbnails(layoutOf(dataRoot).derivedDir, service);
  protocol.handle(PAGE_IMAGE_SCHEME, (request) =>
    handlePageImageRequest(request, {
      sessionId: () => service.snapshot().session?.id ?? null,
      readPage: (key) => service.readPage(key),
      readThumbnail: (key) => thumbnails.get(key),
    }),
  );

  const commands = createCommands({
    service,
    // `shell.openPath` не бросает: причину отказа он возвращает строкой.
    openDataFolder: async () => {
      const problem = await shell.openPath(dataRoot);
      if (problem === '') {
        return ok(undefined);
      }
      console.error('[main] каталог данных не открылся', problem);
      return fail('storageFailed', { reason: 'openPath' });
    },
    // «Сохранить как» (M2, KTD-3): файловые диалоги — обязанность main (ADR 0003); имя, папку
    // и подтверждение перезаписи даёт диалог ОС.
    askSavePdfPath: async () => {
      // Локальная дата, не UTC: ночью до смещения пояса toISOString() предлагал бы «вчера».
      const today = new Intl.DateTimeFormat('sv-SE').format(new Date());
      const picked = await dialog.showSaveDialog(window, {
        defaultPath: join(app.getPath('documents'), `Скан ${today}.pdf`),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      return picked.canceled || picked.filePath === '' ? null : picked.filePath;
    },
    // Папка пакета (M3, KTD-5): имена файлов задаёт модалка, папку — системный диалог.
    defaultSaveFolder: app.getPath('documents'),
    askSaveFolder: async (current) => {
      const picked = await dialog.showOpenDialog(window, {
        defaultPath: current,
        properties: ['openDirectory', 'createDirectory'],
      });
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
    onDiscoveryChanged: (seq) => {
      send('discoveryChanged', { seq });
    },
  });
  registerBridge(ipcMain, window, commands.handlers);
  installWindowClose(window, {
    isPassRunning: () => service.snapshot().pass !== null,
    interrupt: (deadlineMs) => service.interrupt(deadlineMs),
  });
  app.on('will-quit', () => {
    commands.dispose();
  });

  loadRenderer(window);
  // Запомненный сканер проверяется после открытия окна: интерфейс видит «проверяем…» в снимке.
  void service.checkRememberedScanner();
}

if (acquireSingleInstance(app, () => mainWindow)) {
  // Гварды ставятся до первого окна: событие `web-contents-created` не повторяется. Привилегии
  // схемы регистрируются только до `ready`.
  installShellGuards(app);
  // В упакованном приложении браузерных клавиш нет: ни перезагрузки, ни DevTools, ни масштаба.
  if (installShortcutGuard(app)) {
    Menu.setApplicationMenu(null);
  }
  protocol.registerSchemesAsPrivileged([PAGE_SCHEME_REGISTRATION]);

  app.whenReady().then(start).catch(startupFailed);

  app.on('window-all-closed', () => {
    app.quit();
  });
}
