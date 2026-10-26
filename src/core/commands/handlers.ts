import { stat } from 'node:fs/promises';
import {
  fail,
  ok,
  sessionConflict,
  type BridgeHandlers,
  type ConnectScannerRequest,
  type DiscoveryState,
  type Result,
} from '@shared';
import {
  createConnector,
  parseScannerAddress,
  type Connector,
  type ScannerAddress,
} from '../escl/connect';
import { normalizeBasePath } from '../escl/device-path';
import { startDiscovery, type Discovery, type DiscoveryOptions } from '../discovery/mdns';
import { handleProbe } from '../probe/handle-probe';
import type { PassService } from '../scan/pass-service';
import {
  blankModeSchema,
  hintIdSchema,
  connectScannerRequestSchema,
  noRequestSchema,
  parseInput,
  saveDocumentsRequestSchema,
  scanParamsSchema,
  setDecisionRequestSchema,
  setEditsRequestSchema,
  startPassRequestSchema,
} from './schemas';

// Обработчики команд моста (ADR 0005; план M1, U18, KTD-39): вход приходит непроверенным и
// проходит схему; дальше — служба прохода, поиск устройств и подключение. Доменный отказ
// возвращается кодом в конверте, исключение — ошибка программы.
//
// Поиск устройств живёт здесь: одно обнаружение за раз, `stopDiscovery` обязателен при закрытии
// модалки, при выходе его останавливает `dispose`. Объявления приходят пачкой — событие
// отправляется один раз на пачку. Подключение одно: новое отменяет прежнее.

export interface CommandContext {
  readonly service: PassService;
  /** Открывает каталог данных в проводнике; какой — знает main (KTD-39). */
  readonly openDataFolder: () => Promise<Result<void>>;
  /** Открывает папку в проводнике — папку последнего пакета (M3.5, KTD-9); открывает main. */
  readonly openFolder: (path: string) => Promise<Result<void>>;
  /** Папка сохранения пакета по умолчанию (M3, KTD-5): «Документы» пользователя. */
  readonly defaultSaveFolder: string;
  /** Диалог выбора папки (M3, KTD-5), открытый на текущей; `null` — пользователь отказался. */
  readonly askSaveFolder: (current: string) => Promise<string | null>;
  /** Есть ли папка на диске; подмена для тестов. */
  readonly folderExists?: (path: string) => Promise<boolean>;
  /** Список найденных устройств изменился; `seq` — номер изменения. */
  readonly onDiscoveryChanged: (seq: number) => void;
  /** Подмена для тестов. */
  readonly startDiscovery?: (options: DiscoveryOptions) => Discovery;
  readonly connector?: Connector;
}

export interface Commands {
  readonly handlers: BridgeHandlers;
  /** При выходе: поиск остановлен, идущее подключение и проверка по «Повторить» отменены. */
  dispose(): void;
}

const NO_DISCOVERY: DiscoveryState = { scanners: [], failure: null };

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Адрес из полей модалки: хост — как ввёл пользователь (хост, хост с портом или URL), поля
 * «Дополнительно» имеют приоритет над тем, что разобрано из хоста.
 */
export function addressOf(
  request: Extract<ConnectScannerRequest, { kind: 'address' }>,
): Result<ScannerAddress> {
  const parsed = parseScannerAddress(request.host);
  if (!parsed.ok) {
    return parsed;
  }
  let { basePath } = parsed.value;
  if (request.basePath !== null) {
    const normalized = normalizeBasePath(request.basePath);
    if (normalized === null) {
      return fail('invalidInput', { field: 'basePath' });
    }
    basePath = normalized;
  }
  return ok({
    scheme: request.scheme ?? parsed.value.scheme,
    host: parsed.value.host,
    port: request.port ?? parsed.value.port,
    basePath,
  });
}

export function createCommands(context: CommandContext): Commands {
  const { service } = context;
  const connector = context.connector ?? createConnector();
  const newDiscovery = context.startDiscovery ?? startDiscovery;
  // Проверка по «Повторить» может искать сканер по сети: выход её прерывает (M5, R9).
  const rechecks = new AbortController();

  let discovery: Discovery | null = null;
  let discoverySeq = 0;
  const folderExists = context.folderExists ?? isDirectory;
  /**
   * Папка пакетного сохранения (M3, KTD-5): выбранная помнится в настройках между запусками.
   * Пропавшая с диска (вынута флешка) уступает «Документам» — но не забывается.
   */
  let saveFolder = service.rememberedSaveFolder() ?? context.defaultSaveFolder;
  let announced = false;

  // `onChange` поиска вызывается из обработчика сокета: исключение в нём стало бы необработанным.
  // Пачка объявлений даёт одно событие.
  const discoveryChanged = (): void => {
    if (announced) {
      return;
    }
    announced = true;
    queueMicrotask(() => {
      announced = false;
      discoverySeq += 1;
      try {
        context.onDiscoveryChanged(discoverySeq);
      } catch (error) {
        console.error('[core] событие поиска не отправлено', error);
      }
    });
  };

  // Остановленный поиск остаётся: найденное доступно по идентификатору до следующего поиска
  // (контракт `Discovery.stop`) — модалка может остановить поиск раньше, чем нажато «Подключить».
  const stopDiscovery = (): void => {
    discovery?.stop();
  };

  async function connectScanner(request: ConnectScannerRequest): Promise<Result<void>> {
    if (service.snapshot().pass !== null) {
      return { ok: false, error: sessionConflict('passRunning') };
    }
    let address: ScannerAddress;
    if (request.kind === 'discovered') {
      const found = discovery?.addressOf(request.id) ?? null;
      if (found === null) {
        return fail('invalidInput', { field: 'id', problem: 'unknown' });
      }
      address = found;
    } else {
      const composed = addressOf(request);
      if (!composed.ok) {
        return composed;
      }
      address = composed.value;
    }
    const connected = await connector.connect(address);
    if (!connected.ok) {
      return connected;
    }
    return service.useScanner(connected.value);
  }

  // Команда без входа: схема отклоняет всё, кроме `undefined`, — у `openDataFolder` аргументов
  // быть не может (KTD-39).
  const withoutRequest =
    <T>(run: () => Promise<Result<T>> | Result<T>) =>
    async (rawRequest: unknown): Promise<Result<T>> => {
      const request = parseInput(noRequestSchema, rawRequest);
      return request.ok ? run() : request;
    };

  // Пустой результат службы — пустое значение конверта.
  const done = async (run: () => Promise<Result<void>>): Promise<Result<undefined>> => {
    const result = await run();
    return result.ok ? ok(undefined) : result;
  };

  return {
    handlers: {
      probe: (rawRequest) => handleProbe(rawRequest),

      getSnapshot: withoutRequest(() => ok(service.snapshot())),

      startDiscovery: withoutRequest(() => {
        stopDiscovery();
        discovery = null;
        discovery = newDiscovery({ onChange: discoveryChanged });
        return ok(discovery.state());
      }),

      getDiscovery: withoutRequest(() => ok(discovery?.state() ?? NO_DISCOVERY)),

      stopDiscovery: withoutRequest(() => {
        stopDiscovery();
        return ok(undefined);
      }),

      connectScanner: async (rawRequest) => {
        const request = parseInput(connectScannerRequestSchema, rawRequest);
        return request.ok ? done(() => connectScanner(request.value)) : request;
      },

      // Закрытие модалки `device`: идущее подключение возвращает `canceled` и ничего не меняет.
      cancelConnect: withoutRequest(() => {
        connector.cancel();
        return ok(undefined);
      }),

      // Кнопка «Повторить» (U19, S3): исход — в снимке; гонку с ручным подключением служба
      // разводит сама — результат проверки не затирает сканер, подключённый за это время.
      recheckScanner: withoutRequest(async () => {
        await service.checkRememberedScanner(rechecks.signal);
        return ok(undefined);
      }),

      setScanParams: async (rawRequest) => {
        const request = parseInput(scanParamsSchema, rawRequest);
        return request.ok ? done(() => service.setParams(request.value)) : request;
      },

      setBlankMode: async (rawRequest) => {
        const request = parseInput(blankModeSchema, rawRequest);
        return request.ok ? done(() => service.setBlankMode(request.value)) : request;
      },

      markHintSeen: async (rawRequest) => {
        const request = parseInput(hintIdSchema, rawRequest);
        return request.ok ? done(() => service.markHintSeen(request.value)) : request;
      },

      startPass: async (rawRequest) => {
        const request = parseInput(startPassRequestSchema, rawRequest);
        return request.ok ? service.startPass(request.value) : request;
      },
      stopPass: withoutRequest(() => done(() => service.stopPass())),
      acceptPass: withoutRequest(() => done(() => service.acceptPass())),
      declineBacks: withoutRequest(() => done(() => service.declineBacks())),
      assemble: withoutRequest(() => done(() => service.assemble())),
      setEdits: async (rawRequest) => {
        const request = parseInput(setEditsRequestSchema, rawRequest);
        return request.ok
          ? service.setEdits(request.value.edits, request.value.rotate180)
          : request;
      },
      // Решения по оборотам набора «ДN» (M4.5, KTD3): номер — из отчёта сборки, проверяет ядро.
      keepSetBacks: async (rawRequest) => {
        const request = parseInput(setDecisionRequestSchema, rawRequest);
        return request.ok ? done(() => service.keepSetBacks(request.value.set)) : request;
      },
      rescanSetBacks: async (rawRequest) => {
        const request = parseInput(setDecisionRequestSchema, rawRequest);
        return request.ok ? done(() => service.rescanSetBacks(request.value.set)) : request;
      },

      // Папка пакета живёт здесь, как поиск устройств: её выбирает main, пишет служба. В снимок
      // она не идёт — там нет абсолютных путей (KTD-39); модалка берёт её командой.
      getSaveFolder: withoutRequest(async () => {
        if (saveFolder !== context.defaultSaveFolder && !(await folderExists(saveFolder))) {
          saveFolder = context.defaultSaveFolder;
        }
        return ok(saveFolder);
      }),
      chooseSaveFolder: withoutRequest(async () => {
        const picked = await context.askSaveFolder(saveFolder);
        if (picked !== null) {
          saveFolder = picked;
          // Отказ записи настроек не мешает: папка остаётся в памяти до выхода.
          await service.rememberSaveFolder(picked);
        }
        return ok({ canceled: picked === null, folder: saveFolder });
      }),
      saveDocuments: async (rawRequest) => {
        const request = parseInput(saveDocumentsRequestSchema, rawRequest);
        return request.ok ? service.saveDocuments(saveFolder, request.value) : request;
      },
      closeSession: withoutRequest(() => done(() => service.closeSession())),

      openDataFolder: withoutRequest(() => done(() => context.openDataFolder())),
      // «Открыть папку» (M3.5, KTD-9): папку последнего пакета помнит служба, путь от renderer
      // не принимается.
      openSaveFolder: withoutRequest(() => {
        const folder = service.lastBatchFolder();
        return folder === null
          ? { ok: false, error: sessionConflict('noBatch') }
          : done(() => context.openFolder(folder));
      }),
    },

    dispose() {
      stopDiscovery();
      discovery = null;
      connector.cancel();
      rechecks.abort();
    },
  };
}
