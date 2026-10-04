// Единственный экземпляр приложения (ADR 0004; план M1, KTD-21): сессия на диске одна, второй
// процесс писал бы в тот же журнал. Electron не импортируется: `app` и окно описаны структурно.

interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: 'second-instance', listener: () => void): unknown;
}

interface PrimaryWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

// Вызывается после выбора каталога `userData` (блокировка лежит в нём) и до всего остального.
// `false` — блокировка занята: приложение уже завершается, окно создавать нельзя. Окно берётся
// функцией: в момент вызова его ещё нет.
export function acquireSingleInstance(
  app: SingleInstanceApp,
  getWindow: () => PrimaryWindow | null,
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  app.on('second-instance', () => {
    const window = getWindow();
    if (window === null || window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
  });
  return true;
}
