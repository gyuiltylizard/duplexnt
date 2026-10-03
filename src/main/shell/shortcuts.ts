import type { Input, WebContents } from 'electron';

// Браузерные клавиши в упакованном приложении выключены (решение автора, M1): перезагрузка
// посреди прохода теряет ответ на запуск, DevTools открывают мост со сканером, масштаб и
// «назад» ломают экран. В `dev` всё остаётся — перезагрузка и DevTools нужны для работы.
//
// Два слоя: меню по умолчанию снимается (с ним уходят его сочетания), а клавиши перехватываются
// до страницы. Проверка — по физической клавише (`code`), а не по символу: в русской раскладке
// Ctrl+R приходит как «к». Импорт Electron — только типы, модуль проверяется под Node.

type KeyInput = Pick<Input, 'type' | 'code' | 'control' | 'meta' | 'shift' | 'alt'>;

/** Без модификаторов: перезагрузка, DevTools и аппаратные кнопки браузера. */
const BARE_KEYS: ReadonlySet<string> = new Set([
  'F5',
  'F12',
  'BrowserBack',
  'BrowserForward',
  'BrowserRefresh',
  'BrowserHome',
]);

/** С Ctrl: перезагрузка, масштаб, печать, исходник, переход по адресу. */
const CTRL_KEYS: ReadonlySet<string> = new Set([
  'KeyR',
  'F5',
  'Equal',
  'Minus',
  'Digit0',
  'NumpadAdd',
  'NumpadSubtract',
  'Numpad0',
  'KeyP',
  'KeyU',
]);

/** С Ctrl+Shift: DevTools, консоль, инспектор элемента. */
const CTRL_SHIFT_KEYS: ReadonlySet<string> = new Set(['KeyI', 'KeyJ', 'KeyC']);

/** С Alt: «назад» и «вперёд». */
const ALT_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight']);

export function isBrowserShortcut(input: KeyInput): boolean {
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') {
    return false;
  }
  const { code } = input;
  const ctrl = input.control || input.meta;
  if (BARE_KEYS.has(code)) {
    return true;
  }
  if (ctrl && input.shift && CTRL_SHIFT_KEYS.has(code)) {
    return true;
  }
  if (ctrl && CTRL_KEYS.has(code)) {
    return true;
  }
  return input.alt && !ctrl && ALT_KEYS.has(code);
}

export function blockBrowserShortcuts(contents: WebContents): void {
  contents.on('before-input-event', (event, input) => {
    if (isBrowserShortcut(input)) {
      event.preventDefault();
    }
  });
}

interface ShortcutApp {
  readonly isPackaged: boolean;
  on(
    event: 'web-contents-created',
    listener: (event: unknown, contents: WebContents) => void,
  ): unknown;
}

/**
 * Вешается до первого окна и только в упакованном приложении. Меню снимает вызывающий:
 * `Menu.setApplicationMenu(null)` — здесь Electron не импортируется.
 */
export function installShortcutGuard(app: ShortcutApp): boolean {
  if (!app.isPackaged) {
    return false;
  }
  app.on('web-contents-created', (_event, contents) => {
    blockBrowserShortcuts(contents);
  });
  return true;
}
