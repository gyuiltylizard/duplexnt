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
  connectScannerRequestSchema,
  noRequestSchema,
  parseInput,
  scanParamsSchema,
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
  /** Список найденных устройств изменился; `seq` — номер изменения. */
  readonly onDiscoveryChanged: (seq: number) => void;
  /** Подмена для тестов. */
  readonly startDiscovery?: (options: DiscoveryOptions) => Discovery;
  readonly connector?: Connector;
}

export interface Commands {
  readonly handlers: BridgeHandlers;
  /** При выходе: поиск остановлен, идущее подключение отменено. */
  dispose(): void;
}

const NO_DISCOVERY: DiscoveryState = { scanners: [], failure: null };

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

  let discovery: Discovery | null = null;
  let discoverySeq = 0;
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
        await service.checkRememberedScanner();
        return ok(undefined);
      }),

      setScanParams: async (rawRequest) => {
        const request = parseInput(scanParamsSchema, rawRequest);
        return request.ok ? done(() => service.setParams(request.value)) : request;
      },

      startPass: withoutRequest(() => service.startPass()),
      stopPass: withoutRequest(() => done(() => service.stopPass())),
      acceptPass: withoutRequest(() => done(() => service.acceptPass())),
      closeSession: withoutRequest(() => done(() => service.closeSession())),

      openDataFolder: withoutRequest(() => done(() => context.openDataFolder())),
    },

    dispose() {
      stopDiscovery();
      discovery = null;
      connector.cancel();
    },
  };
}
