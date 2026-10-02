// Контракт моста: единственное место, где названы команды, события, их каналы и типы.
//
// Правила для всех каналов (ADR 0005):
// - одна команда — одна функция в `window.api` с зашитым каналом; сквозного `invoke(канал, …)`,
//   `ipcRenderer` и объектов событий наружу нет;
// - регистрация в main идёт только через обёртку src/main/bridge.ts — она отклоняет вызов
//   не из главного фрейма окна приложения;
// - вход валидируется в ядре схемой: обработчик принимает `unknown`;
// - команда возвращает конверт `Result`: доменный отказ — значение с кодом, а не исключение;
// - одно событие — одна функция-подписка `on<Событие>`, возвращающая отписку; событие —
//   подсказка, а не источник правды: оно несёт номер, состояние берётся командой-запросом;
// - в типах контракта — только то, что есть в ES-библиотеке и переживает structured clone:
//   `Uint8Array` и `ArrayBuffer` можно; `Buffer`, `Blob` и потоки нельзя.

import type { Result } from './errors';

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

// ---------------------------------------------------------------------------------------------
// Команды: renderer → main.
// ---------------------------------------------------------------------------------------------

export interface BridgeCommands {
  readonly probe: { readonly request: ProbeRequest; readonly value: ProbeResult };
}

export type BridgeCommand = keyof BridgeCommands;

export const BRIDGE_CHANNELS = {
  probe: 'duplexnt:probe',
} as const satisfies Record<BridgeCommand, string>;

export type CommandResult<K extends BridgeCommand> = Result<BridgeCommands[K]['value']>;

export type CommandsApi = {
  readonly [K in BridgeCommand]: (
    request: BridgeCommands[K]['request'],
  ) => Promise<CommandResult<K>>;
};

/** Обработчики на стороне main: вход ещё не проверен, поэтому `unknown`. */
export type BridgeHandlers = {
  readonly [K in BridgeCommand]: (rawRequest: unknown) => Promise<CommandResult<K>>;
};

// ---------------------------------------------------------------------------------------------
// События: main → renderer.
// ---------------------------------------------------------------------------------------------

export interface BridgeEvents {
  /** Снимок состояния изменился; `seq` — номер нового снимка. Берётся позднейшее по номеру. */
  readonly snapshotChanged: { readonly seq: number };
  /** Список найденных сканеров изменился; сам список берётся командой. */
  readonly discoveryChanged: { readonly seq: number };
}

export type BridgeEvent = keyof BridgeEvents;

export const BRIDGE_EVENT_CHANNELS = {
  snapshotChanged: 'duplexnt:event:snapshot-changed',
  discoveryChanged: 'duplexnt:event:discovery-changed',
} as const satisfies Record<BridgeEvent, string>;

export type Unsubscribe = () => void;

export type EventsApi = {
  readonly [K in BridgeEvent as `on${Capitalize<K>}`]: (
    listener: (payload: BridgeEvents[K]) => void,
  ) => Unsubscribe;
};

/** То, что интерфейс видит как `window.api`. */
export type Api = CommandsApi & EventsApi;
