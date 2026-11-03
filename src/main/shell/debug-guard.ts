// Отладка в упакованном приложении закрыта (B-29, U3; решение автора 2026-11-02). Fuse для
// `--remote-debugging-port` нет (сопровождающие `electron/fuses`, issue 6), поэтому ключи
// проверяются первым действием main: до каталога данных, блокировки экземпляра и `ready`.
// Выход — немедленный `process.exit`, а не `app.exit`: главный скрипт выполняется раньше, чем
// Chromium поднимает обработчик DevTools, и немедленный выход не даёт порту открыться вовсе
// (замер — журнал 0035). Из `out/` и под dev-сервером всё остаётся: CDP нужен агентским смоукам.
// Electron не импортируется: `app` и выход описаны структурно, модуль проверяется под Node.

/** Ключи Chromium, открывающие протокол DevTools снаружи; `=0` и pipe — те же ключи. */
export const DEBUG_SWITCHES: readonly string[] = ['remote-debugging-port', 'remote-debugging-pipe'];

interface DebugGuardApp {
  readonly isPackaged: boolean;
  readonly commandLine: { hasSwitch(name: string): boolean };
}

/**
 * Упакованное приложение с ключом отладки выходит с кодом 1, и вызывающий не продолжает запуск.
 * Возвращает `true`, если выход затребован: `exit` в тестах — подставной.
 */
export function installDebugGuard(app: DebugGuardApp, exit: (code: number) => void): boolean {
  if (!app.isPackaged) {
    return false;
  }
  const found = DEBUG_SWITCHES.find((name) => app.commandLine.hasSwitch(name));
  if (found === undefined) {
    return false;
  }
  console.error(`[main] ключ --${found} в установленном приложении не поддерживается`);
  exit(1);
  return true;
}
