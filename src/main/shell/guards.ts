import type { App, Session, WebContents } from 'electron';

// Гварды оболочки. Импорт Electron — только типы: зависимости приходят аргументами, поэтому
// модуль тестируется под обычным Node подставными объектами.

// Перезагрузка той же страницы (HMR в dev) — не навигация; всё остальное запрещено.
export function isSameDocument(currentUrl: string, targetUrl: string): boolean {
  const strip = (url: string): string => url.split('#')[0] ?? url;
  return currentUrl !== '' && strip(currentUrl) === strip(targetUrl);
}

export function guardWebContents(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    if (!isSameDocument(contents.getURL(), url)) {
      event.preventDefault();
    }
  });
  contents.on('will-redirect', (event) => {
    event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// Вешается на каждое новое webContents — и на те, что появятся не из нашего кода.
export function installShellGuards(app: App): void {
  app.on('web-contents-created', (_event, contents) => {
    guardWebContents(contents);
  });
}

// Приложению не нужны ни камера, ни геолокация, ни уведомления — отказ на всё.
export function denyAllPermissions(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
}
