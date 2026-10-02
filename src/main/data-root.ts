import { join } from 'node:path';

// Корень данных приложения (план M1, KTD-21): подкаталог `data` в `userData`. Кэши Chromium
// остаются рядом и не смешиваются с данными. Electron не импортируется: `app` описан структурно.

interface DataRootApp {
  readonly isPackaged: boolean;
  getName(): string;
  getPath(name: 'appData' | 'userData'): string;
  setPath(name: 'userData', path: string): void;
}

export const DEV_USER_DATA_SUFFIX = '-dev';
export const DATA_DIR_NAME = 'data';

// Вызывается ПЕРВЫМ действием main — до блокировки экземпляра и до `ready`: блокировка лежит в
// `userData`, и `dev` с установленным приложением должны жить в разных каталогах, а не делить
// сессию и блокировку. Неупакованный запуск получает соседний каталог; путь по умолчанию до
// переопределения не запрашивается — каталог `dev` строится от `appData`.
export function resolveDataRoot(app: DataRootApp): string {
  if (!app.isPackaged) {
    app.setPath('userData', join(app.getPath('appData'), app.getName() + DEV_USER_DATA_SUFFIX));
  }
  return join(app.getPath('userData'), DATA_DIR_NAME);
}
