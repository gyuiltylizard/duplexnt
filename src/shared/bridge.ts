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

import type { DiscoveryState } from './discovery';
import type { SessionEdits } from './edits';
import type { DomainError, Result } from './errors';
import type { ScanParams } from './scan-params';
import type { PassReport, Snapshot } from './snapshot';

export const PROBE_TOKEN_MAX_LENGTH = 64;

/** Схема изображений страниц (ADR 0005; план M1, KTD-38): `<схема>://<сессия>/<вид>/<ключ>`. */
export const PAGE_IMAGE_SCHEME = 'duplexnt-page';
export const PAGE_IMAGE_VIEWS = ['page', 'thumb'] as const;
export type PageImageView = (typeof PAGE_IMAGE_VIEWS)[number];

/** Адрес изображения страницы текущей сессии — единственный способ его собрать в интерфейсе. */
export function pageImageUrl(sessionId: string, view: PageImageView, key: string): string {
  return `${PAGE_IMAGE_SCHEME}://${sessionId}/${view}/${key}`;
}

/**
 * Подключение сканера (план M1, R1, KTD-39): адрес, введённый вручную, с полями «Дополнительно»,
 * либо непрозрачный идентификатор найденного устройства. `null` в поле — «не названо»: схема —
 * сначала HTTPS, порт — по умолчанию для схемы, путь — `/eSCL`.
 */
export type ConnectScannerRequest =
  | {
      readonly kind: 'address';
      /** Хост, хост с портом или полный URL — как ввёл пользователь. */
      readonly host: string;
      readonly scheme: 'https' | 'http' | null;
      readonly port: number | null;
      readonly basePath: string | null;
    }
  | { readonly kind: 'discovered'; readonly id: string };

export interface ProbeRequest {
  readonly token: string;
}

/**
 * Правки редактора (M3, KTD-3): итоговое состояние целиком и поворот оборотов на 180° — одной
 * командой, чтобы «Вернуть» и его отмена были одним шагом. Нормализует ядро.
 */
export interface SetEditsRequest {
  readonly edits: SessionEdits;
  readonly rotate180: boolean;
}

/**
 * Исход правки: номер снимка, который несёт её результат. Снимок уходит после каждой принятой
 * команды — и когда правки совпали с журналом после нормализации (M3, ревью сессий 3–4).
 */
export interface SetEditsReport {
  readonly seq: number;
}

/** Итог «Сохранить документ» (M2, KTD-3): отказ в диалоге — не ошибка, ничего не записано. */
export type SavePdfReport =
  | { readonly canceled: true }
  /** Имя файла и папка — для тоста «Сохранено: …». */
  | { readonly canceled: false; readonly fileName: string; readonly directory: string };

/** Режим сохранения (M3, R11): по документам или всё одним файлом (R15 — границы не в счёт). */
export const SAVE_MODES = ['separate', 'single'] as const;
export type SaveMode = (typeof SAVE_MODES)[number];

/**
 * «Сохранить» из модалки (M3, U4): имена файлов по документам (для «одного файла» — одно), папка —
 * выбранная `chooseSaveFolder`. `retry` — повтор только неудавшихся файлов прошлого пакета.
 */
export interface SaveDocumentsRequest {
  readonly mode: SaveMode;
  readonly names: readonly string[];
  readonly retry: boolean;
}

export interface SavedFile {
  /** Номер документа в пакете, с нуля. */
  readonly index: number;
  /** Фактическое имя файла — с суффиксом « (2)», если исходное было занято. */
  readonly fileName: string;
}

export interface FailedFile extends SavedFile {
  readonly error: DomainError;
}

/**
 * Итог пакета (M3, R12): записанные — накопительно с прошлых попыток, неудавшиеся — этой.
 * «Сохранено» ставится только когда `failed` пуст.
 */
export interface SaveDocumentsReport {
  /** Папка — для сводки и тоста. */
  readonly folder: string;
  readonly written: readonly SavedFile[];
  readonly failed: readonly FailedFile[];
}

/** Выбор папки сохранения: отказ в диалоге оставляет прежнюю. */
export interface SaveFolderChoice {
  readonly canceled: boolean;
  readonly folder: string;
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

/** Команда без входа: любое значение, кроме `undefined`, отклоняется (KTD-39). */
export type NoRequest = undefined;

export interface BridgeCommands {
  readonly probe: { readonly request: ProbeRequest; readonly value: ProbeResult };
  /** Снимок состояния — единственный источник правды для экрана (KTD-23). */
  readonly getSnapshot: { readonly request: NoRequest; readonly value: Snapshot };
  readonly startDiscovery: { readonly request: NoRequest; readonly value: DiscoveryState };
  readonly getDiscovery: { readonly request: NoRequest; readonly value: DiscoveryState };
  readonly stopDiscovery: { readonly request: NoRequest; readonly value: undefined };
  /** Исход — в снимке: сканер подключён, запомнен, параметры сверены. */
  readonly connectScanner: { readonly request: ConnectScannerRequest; readonly value: undefined };
  /** Отмена подключения — закрытие модалки `device`; если оно ещё идёт, вернёт `canceled`. */
  readonly cancelConnect: { readonly request: NoRequest; readonly value: undefined };
  /** Проверка запомненного сканера ещё раз — кнопка «Повторить» (U19, S3); исход — в снимке. */
  readonly recheckScanner: { readonly request: NoRequest; readonly value: undefined };
  readonly setScanParams: { readonly request: ScanParams; readonly value: undefined };
  /** Новый проход или досканирование; возвращается, когда задание закрыто. */
  readonly startPass: { readonly request: NoRequest; readonly value: PassReport };
  readonly stopPass: { readonly request: NoRequest; readonly value: undefined };
  readonly acceptPass: { readonly request: NoRequest; readonly value: undefined };
  /** «Обороты не нужны» (M2, KTD-6): durable-отметка, `flip` больше не показывается. */
  readonly declineBacks: { readonly request: NoRequest; readonly value: undefined };
  /**
   * Правки редактора и тумблер 180° (M3, KTD-3); исход — в снимке с номером из ответа. Во время
   * записи PDF и идущего прохода отклоняется конфликтом (KTD-9).
   */
  readonly setEdits: { readonly request: SetEditsRequest; readonly value: SetEditsReport };
  /**
   * «Сохранить документ» (M2, KTD-3): путь спрашивает main системным диалогом, ядро собирает
   * PDF и пишет атомарно; отметка о сохранении — в журнале.
   */
  readonly savePdf: { readonly request: NoRequest; readonly value: SavePdfReport };
  /** Папка сохранения пакета (M3, KTD-5): по умолчанию «Документы», помнится до выхода. */
  readonly getSaveFolder: { readonly request: NoRequest; readonly value: string };
  /** «Выбрать…» в модалке `save`: системный диалог папки в main. */
  readonly chooseSaveFolder: { readonly request: NoRequest; readonly value: SaveFolderChoice };
  /**
   * Пакетное сохранение (M3, U4): документы ленты в PDF в выбранную папку, best-effort. Во время
   * записи правки отклоняются (KTD-9).
   */
  readonly saveDocuments: {
    readonly request: SaveDocumentsRequest;
    readonly value: SaveDocumentsReport;
  };
  readonly closeSession: { readonly request: NoRequest; readonly value: undefined };
  /** Открывает каталог данных в проводнике — при несовместимых данных. Каталог знает main. */
  readonly openDataFolder: { readonly request: NoRequest; readonly value: undefined };
}

export type BridgeCommand = keyof BridgeCommands;

export const BRIDGE_CHANNELS = {
  probe: 'duplexnt:probe',
  getSnapshot: 'duplexnt:get-snapshot',
  startDiscovery: 'duplexnt:start-discovery',
  getDiscovery: 'duplexnt:get-discovery',
  stopDiscovery: 'duplexnt:stop-discovery',
  connectScanner: 'duplexnt:connect-scanner',
  cancelConnect: 'duplexnt:cancel-connect',
  recheckScanner: 'duplexnt:recheck-scanner',
  setScanParams: 'duplexnt:set-scan-params',
  startPass: 'duplexnt:start-pass',
  stopPass: 'duplexnt:stop-pass',
  acceptPass: 'duplexnt:accept-pass',
  declineBacks: 'duplexnt:decline-backs',
  setEdits: 'duplexnt:set-edits',
  savePdf: 'duplexnt:save-pdf',
  getSaveFolder: 'duplexnt:get-save-folder',
  chooseSaveFolder: 'duplexnt:choose-save-folder',
  saveDocuments: 'duplexnt:save-documents',
  closeSession: 'duplexnt:close-session',
  openDataFolder: 'duplexnt:open-data-folder',
} as const satisfies Record<BridgeCommand, string>;

export type CommandResult<K extends BridgeCommand> = Result<BridgeCommands[K]['value']>;

export type CommandsApi = {
  readonly [K in BridgeCommand]: BridgeCommands[K]['request'] extends NoRequest
    ? () => Promise<CommandResult<K>>
    : (request: BridgeCommands[K]['request']) => Promise<CommandResult<K>>;
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
