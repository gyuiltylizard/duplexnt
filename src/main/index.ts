import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  screen,
  session,
  shell,
} from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createCommands,
  createThumbnails,
  layoutOf,
  limiterOf,
  openPassService,
  openWindowStateStore,
} from '@core';
import ru from '@locales/ru/common.json';
// Значок окна (B-7): заголовок, панель задач, Alt+Tab. Свой .ico, не значок exe: Electron берёт
// из него кадры системных размеров (на 100 % — 16 и 32), а панель ужимает 32 до 24 px. Поэтому все
// кадры — из оптически упрощённого мастера почти без полей (`WINDOW_ICON_SIZES`). `?asset` копирует
// файл в сборку и даёт путь — нужно для `dev`; упакованное окно иначе взяло бы значок exe.
import appIcon from '../../build/window-icon.ico?asset';
import { APP_NAME, fail, ok, PAGE_IMAGE_SCHEME, type Result } from '@shared';
import {
  APP_INDEX_URL,
  APP_SCHEME,
  APP_SCHEME_REGISTRATION,
  handleAppRequest,
} from './app-protocol';
import { registerBridge } from './bridge';
import { resolveDataRoot } from './data-root';
import { createEventSender } from './events';
import { handlePageImageRequest, PAGE_SCHEME_REGISTRATION } from './page-protocol';
import { installDebugGuard } from './shell/debug-guard';
import { denyAllPermissions, installShellGuards } from './shell/guards';
import { installShortcutGuard } from './shell/shortcuts';
import { buildWebPreferences } from './shell/web-preferences';
import { acquireSingleInstance } from './single-instance';
import {
  DEFAULT_WINDOW_SIZE,
  placeWindow,
  trackWindowState,
  type WindowPlacement,
} from './window-bounds';
import { installWindowClose } from './window-close';

/**
 * Страница проекта — ссылка в подвале инспектора (B-42). Адрес живёт только здесь: renderer
 * открыть произвольный URL не может. С открытием репозитория (B-40) сменится на страницу Pages.
 */
const PROJECT_PAGE_URL = 'https://github.com/gyuiltylizard/duplexnt';

function createWindow({ bounds, maximized }: WindowPlacement): BrowserWindow {
  const window = new BrowserWindow({
    ...(bounds ?? DEFAULT_WINDOW_SIZE),
    show: false,
    title: APP_NAME,
    icon: appIcon,
    webPreferences: buildWebPreferences(join(__dirname, '../preload/index.js'), app.isPackaged),
  });

  // Разворот показывает окно сам; границы до разворота остаются его «обычными» (B-3).
  window.once('ready-to-show', () => {
    if (maximized) {
      window.maximize();
    } else {
      window.show();
    }
  });

  // Сломанный preload иначе молчит: окно откроется, а моста в нём не будет.
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[main] preload не загрузился: ${preloadPath}`, error);
  });

  return window;
}

// Собранный renderer лежит рядом с main: в `out/` при запуске из исходников, внутри `app.asar`
// в установленном приложении — `fs` Electron читает из архива прозрачно.
const RENDERER_DIR = join(__dirname, '../renderer');

// Вне dev-сервера интерфейс грузится со своей схемы (B-29, U1): страниц по `file://` у
// приложения нет, и fuse `grantFileProtocolExtraPrivileges` можно выключить.
function loadRenderer(window: BrowserWindow): void {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServerUrl !== undefined) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadURL(APP_INDEX_URL);
  }
}

// Первое действие main (B-29, U3): установленное приложение с ключом отладки выходит, пока
// ничего не открыто — ни каталог данных, ни блокировка экземпляра, ни порт. `process.exit` не
// возвращается, поэтому дальше код идёт только без ключей (или из `out/` и под dev-сервером).
installDebugGuard(app, (code) => process.exit(code));

// Порядок запуска задан явно (план M1, KTD-21): каталог данных → блокировка экземпляра → всё
// остальное. Блокировка лежит в `userData`, поэтому каталог `dev` выбирается до неё.
const dataRoot = resolveDataRoot(app);

/** Задач над производным одновременно (KTD-4): два декода `sharp` рядом с приёмом страниц. */
const DERIVED_CONCURRENCY = 2;

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

  // Схема интерфейса — до первого окна: по ней грузится сам документ.
  protocol.handle(APP_SCHEME, (request) =>
    handleAppRequest(request, { rendererDir: RENDERER_DIR, readFile: (path) => readFile(path) }),
  );

  // Размер и место окна с прошлого запуска (B-3): мониторы известны только после `ready`.
  const windowState = await openWindowStateStore(dataRoot);
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);

  // Мост регистрируется до загрузки страницы и получает окно: без него нечем проверить
  // отправителя. Обработчики зовут ядро с сырым входом — проверка входа живёт в ядре.
  const window = createWindow(placeWindow(windowState.get(), workAreas));
  mainWindow = window;
  trackWindowState(window, (state) => {
    void windowState.save(state).then((saved) => {
      if (!saved.ok) {
        console.error('[main] состояние окна не записано', saved.error);
      }
    });
  });
  const send = createEventSender(window);

  // Один лимитер на всё производное в main (M6, KTD-4): миниатюры, оценки пустоты, измерение
  // перекоса — не больше двух декодов разом рядом с `fsync` приёма страницы.
  const derivedLimiter = limiterOf(DERIVED_CONCURRENCY);
  let service;
  try {
    service = await openPassService(dataRoot, {
      derivedLimiter,
      onChange: (seq) => {
        send('snapshotChanged', { seq });
      },
    });
  } catch (error) {
    storageUnreadable(error);
    return;
  }

  // Схема изображений: страницы и миниатюры текущей сессии по ключу (KTD-38); выправленные
  // виды — по записи о коррекции через службу (M6, KTD-7, KTD-11).
  const thumbnails = createThumbnails(layoutOf(dataRoot).derivedDir, service, {
    limiter: derivedLimiter,
    straightened: service.straightenedFiles(),
  });
  protocol.handle(PAGE_IMAGE_SCHEME, (request) =>
    handlePageImageRequest(request, {
      sessionId: () => service.sessionId(),
      readPage: (key) => service.readPage(key),
      readThumbnail: (key) => thumbnails.get(key),
      readStraight: (key) => service.readStraightened(key),
      readStraightThumbnail: (key) => thumbnails.getStraight(key),
    }),
  );

  // `shell.openPath` не бросает: причину отказа он возвращает строкой. Папка пакета (M3.5,
  // KTD-9) приходит из ядра, не от renderer.
  const openFolder = async (path: string): Promise<Result<void>> => {
    const problem = await shell.openPath(path);
    if (problem === '') {
      return ok(undefined);
    }
    console.error('[main] папка не открылась', problem);
    return fail('storageFailed', { reason: 'openPath' });
  };
  // `shell.openExternal` при отказе системы бросает — в конверт, причина в журнал main.
  const openProjectPage = async (): Promise<Result<void>> => {
    try {
      await shell.openExternal(PROJECT_PAGE_URL);
      return ok(undefined);
    } catch (error) {
      console.error('[main] страница проекта не открылась', error);
      return fail('storageFailed', { reason: 'openExternal' });
    }
  };
  const commands = createCommands({
    service,
    openDataFolder: () => openFolder(dataRoot),
    openFolder,
    openProjectPage,
    // Папка пакета (M3, KTD-5): файловые диалоги — обязанность main (ADR 0003); имена файлов
    // задаёт модалка, папку — системный диалог.
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
  // Стартовая проверка может искать сканер по сети: выход её прерывает — сокеты закрыты,
  // настройки после закрытия не пишутся (M5, R9).
  const startupCheck = new AbortController();
  app.on('will-quit', () => {
    startupCheck.abort();
    commands.dispose();
    // Измерения перекоса в полёте отменяются (M6, KTD-12): страница без вердикта дождётся
    // следующего запуска, кэш закрытой сессии не пересоздаётся.
    void service.settleDerived();
  });

  loadRenderer(window);
  // Запомненный сканер проверяется после открытия окна: интерфейс видит «проверяем…» в снимке.
  void service.checkRememberedScanner(startupCheck.signal);
}

if (acquireSingleInstance(app, () => mainWindow)) {
  // Гварды ставятся до первого окна: событие `web-contents-created` не повторяется. Привилегии
  // схем регистрируются только до `ready` и одним вызовом: повторный заменил бы первый.
  installShellGuards(app);
  // В упакованном приложении браузерных клавиш нет: ни перезагрузки, ни DevTools, ни масштаба.
  if (installShortcutGuard(app)) {
    Menu.setApplicationMenu(null);
  }
  protocol.registerSchemesAsPrivileged([PAGE_SCHEME_REGISTRATION, APP_SCHEME_REGISTRATION]);

  app.whenReady().then(start).catch(startupFailed);

  app.on('window-all-closed', () => {
    app.quit();
  });
}
