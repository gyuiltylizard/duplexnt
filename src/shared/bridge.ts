// Контракт моста: единственное место, где названы команды, их каналы и типы.
//
// Правила для всех будущих каналов:
// - одна команда — одна функция в `window.api` с зашитым каналом; сквозного `invoke(канал, …)`,
//   `ipcRenderer` и объектов событий наружу нет;
// - регистрация в main идёт только через обёртку src/main/bridge.ts — она отклоняет вызов
//   не из главного фрейма окна приложения;
// - вход валидируется в ядре: обработчик принимает `unknown`;
// - в типах контракта — только то, что есть в ES-библиотеке и переживает structured clone:
//   `Uint8Array` и `ArrayBuffer` можно; `Buffer`, `Blob` и потоки нельзя.

export const PROBE_TOKEN_MAX_LENGTH = 64;

export interface ProbeRequest {
  readonly token: string;
}

export interface ProbeResult {
  /** Эхо входного токена — доказывает, что ответ пришёл на этот вызов. */
  readonly echo: string;
  readonly versions: {
    /** `null` вне Electron: тот же код идёт под обычным Node в тестах. */
    readonly electron: string | null;
    readonly chrome: string | null;
    readonly node: string;
    readonly sharp: string;
    readonly libvips: string;
  };
  /** Итог настоящей операции над изображением, а не просто загрузки модуля. */
  readonly image: {
    readonly format: string;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
  };
}

export interface BridgeCommands {
  readonly probe: { readonly request: ProbeRequest; readonly response: ProbeResult };
}

export type BridgeCommand = keyof BridgeCommands;

export const BRIDGE_CHANNELS = {
  probe: 'duplexnt:probe',
} as const satisfies Record<BridgeCommand, string>;

/** То, что интерфейс видит как `window.api`. */
export type Api = {
  readonly [K in BridgeCommand]: (
    request: BridgeCommands[K]['request'],
  ) => Promise<BridgeCommands[K]['response']>;
};

/** Обработчики на стороне main: вход ещё не проверен, поэтому `unknown`. */
export type BridgeHandlers = {
  readonly [K in BridgeCommand]: (rawRequest: unknown) => Promise<BridgeCommands[K]['response']>;
};
