import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import Bonjour from 'bonjour-service';
import type { DiscoveredScanner, DiscoveryState } from '@shared';
import type { ScannerAddress } from '../escl/connect';
import {
  mergeRecord,
  recordOf,
  SERVICE_TYPES,
  type Announcement,
  type ScannerRecord,
  type ServiceType,
} from './txt';

// Обнаружение сканеров по mDNS без службы Bonjour (план M1, U12; амендмент ADR 0003). Список
// строится только по объявлениям: capabilities запрашиваются у выбранного устройства, и
// ослабленный TLS не ходит к устройствам, которые пользователь не выбирал (KTD-12). Ссылки из
// TXT не запрашиваются и наружу не выходят.
//
// Библиотека спрятана за узким интерфейсом `MdnsBackend`: тесты подменяют его и сокетов не
// открывают.

/** Экземпляр mDNS на одном сетевом интерфейсе. */
export interface MdnsInstance {
  browse(type: ServiceType, onUp: (announcement: Announcement) => void): void;
  /** Повторяет запрос по всем начатым поискам. */
  requery(): void;
  /** Останавливает поиск и освобождает сокет. */
  destroy(): void;
}

export interface MdnsBackend {
  /** `onError` — ошибка сокета, в том числе отложенная. */
  open(interfaceAddress: string, onError: (error: unknown) => void): MdnsInstance;
}

// Потолок числа записей: поток объявлений из сети список не раздувает.
export const MAX_DISCOVERED_SCANNERS = 64;

// Библиотека шлёт запрос один раз, при старте поиска. Один потерянный пакет multicast — и список
// пуст без единой ошибки (наблюдалось в M0 и в M1, U12). Запрос повторяется с растущей паузой,
// последняя пауза — пока идёт поиск.
export const REQUERY_DELAYS_MS = [1000, 2000, 4000, 8000] as const;

const txtEntries = (raw: unknown): Uint8Array[] =>
  Array.isArray(raw) ? raw.filter((entry): entry is Uint8Array => entry instanceof Uint8Array) : [];

/** Адреса хоста, известные по прежним ответам. */
export type AddressLookup = (host: string) => readonly string[];

interface MdnsSocket {
  on(event: 'error' | 'response', listener: (payload: unknown) => void): unknown;
}

// Потолки памяти адресов: поток ответов из сети её не раздувает.
const KNOWN_HOSTS_MAX = 256;
const ADDRESSES_PER_HOST_MAX = 8;

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);

const recordsOf = (packet: unknown): unknown[] => {
  const { answers, additionals } = (packet ?? {}) as { answers?: unknown; additionals?: unknown };
  return [...listOf(answers), ...listOf(additionals)];
};

/**
 * Запоминает записи A из всех ответов. Библиотека берёт адреса сервиса только из того пакета,
 * где пришла его запись SRV, а ET-3850 запись A повторяет не в каждом ответе: только что
 * разосланную в ответ на соседний запрос он опускает (наблюдалось в M1, ревью сессии 4). Без
 * памяти такое объявление осталось бы без адреса — и устройство без строки в списке.
 */
export function collectAddresses(socket: MdnsSocket): AddressLookup {
  const byHost = new Map<string, string[]>();
  socket.on('response', (packet) => {
    for (const record of recordsOf(packet)) {
      const { type, name, data } = (record ?? {}) as {
        type?: unknown;
        name?: unknown;
        data?: unknown;
      };
      if (type !== 'A' || typeof name !== 'string' || typeof data !== 'string') {
        continue;
      }
      const host = name.toLowerCase();
      const known = byHost.get(host);
      if (known === undefined) {
        if (byHost.size < KNOWN_HOSTS_MAX) {
          byHost.set(host, [data]);
        }
      } else if (!known.includes(data) && known.length < ADDRESSES_PER_HOST_MAX) {
        known.push(data);
      }
    }
  });
  return (host) => byHost.get(host.toLowerCase()) ?? [];
}

const announcementOf = (service: Bonjour.Service, addressesOf: AddressLookup): Announcement => ({
  name: service.name,
  port: service.port,
  addresses:
    service.addresses !== undefined && service.addresses.length > 0
      ? service.addresses
      : addressesOf(service.host),
  // Библиотека разбирает TXT наивно (`note=` у неё — ключ со знаком равенства); записи берутся
  // сырыми и разбираются в ./txt.ts.
  txt: txtEntries((service as { rawTxt?: unknown }).rawTxt),
});

/**
 * Объявления одного поиска библиотеки. `up` она шлёт один раз на имя сервиса; о том, что у
 * известного сервиса сменился хост, порт или TXT, сообщает отдельными событиями — без них
 * объявление, пришедшее первым (неполное или чужое под тем же именем), заслонило бы настоящее.
 */
export function watchBrowser(
  browser: Bonjour.Browser,
  onUp: (announcement: Announcement) => void,
  addressesOf: AddressLookup,
): void {
  const forward = (service: Bonjour.Service): void => {
    onUp(announcementOf(service, addressesOf));
  };
  browser.on('up', forward);
  browser.on('srv-update', forward);
  browser.on('txt-update', forward);
}

/**
 * Повтор запроса. Список известных сервисов библиотеки перед ним очищается: известный сервис она
 * заново не объявляет, и устройство, чьё первое объявление пришло без адреса, осталось бы
 * невидимым до конца поиска. После очистки каждый ответ снова приходит как `up` — уже с адресом
 * из памяти; слияние записей повторы терпит. Заодно список не растёт без потолка под потоком
 * объявлений: сама библиотека его не чистит.
 */
export function requeryBrowser(browser: Bonjour.Browser): void {
  browser.services.length = 0;
  browser.update();
}

/**
 * Настоящая библиотека. Два условия работы на Windows — часть решения (амендмент ADR 0003):
 * `reuseAddr` обязателен — порт 5353 делят служба Bonjour, DNS-клиент системы и сторонние
 * приложения; экземпляр привязан к своему интерфейсу — multicast по умолчанию уходит в интерфейс
 * с наименьшей метрикой, а на машине с Hyper-V и WSL это виртуальный адаптер.
 */
export const bonjourBackend: MdnsBackend = {
  open(interfaceAddress, onError) {
    // Опции уходят в multicast-dns; тип конструктора описывает только публикацию сервиса.
    const options = { reuseAddr: true, interface: interfaceAddress };
    const bonjour = new Bonjour(options as ConstructorParameters<typeof Bonjour>[0], onError);
    // Обработчик из конструктора библиотека зовёт только при сбое ответа на чужой запрос. Ошибки
    // сокета — порт не открылся, адреса интерфейса уже нет — приходят событием `error` самого
    // multicast-dns, и без слушателя оно стало бы необработанным исключением в main. Поле
    // библиотеки приватно только в типах.
    let addressesOf: AddressLookup;
    try {
      const socket = (bonjour as unknown as { server: { mdns: MdnsSocket } }).server.mdns;
      socket.on('error', onError);
      // До первого поиска: память адресов обновляется раньше, чем библиотека разберёт пакет.
      addressesOf = collectAddresses(socket);
    } catch (error) {
      bonjour.destroy();
      throw error;
    }
    const browsers: Bonjour.Browser[] = [];
    return {
      browse(type, onUp) {
        const browser = bonjour.find({ type, protocol: 'tcp' });
        watchBrowser(browser, onUp, addressesOf);
        browsers.push(browser);
      },
      requery() {
        for (const browser of browsers) {
          requeryBrowser(browser);
        }
      },
      destroy() {
        for (const browser of browsers) {
          browser.stop();
        }
        bonjour.destroy();
      },
    };
  },
};

/** Адреса внешних IPv4-интерфейсов машины. */
export function externalIpv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

export interface DiscoveryOptions {
  readonly backend?: MdnsBackend;
  readonly interfaces?: () => readonly string[];
  /** Список или состояние поиска изменились. */
  readonly onChange?: () => void;
  readonly maxScanners?: number;
}

export interface Discovery {
  state(): DiscoveryState;
  /**
   * Адрес найденного устройства для подключения. `null` — идентификатор не из этого поиска или
   * устройство без автоподачи: оно показывается, но не выбирается.
   */
  addressOf(id: string): ScannerAddress | null;
  /** Останавливает поиск и освобождает сокеты. Найденное остаётся доступным по идентификатору. */
  stop(): void;
}

export function startDiscovery(options: DiscoveryOptions = {}): Discovery {
  const backend = options.backend ?? bonjourBackend;
  const maxScanners = options.maxScanners ?? MAX_DISCOVERED_SCANNERS;
  const addresses = (options.interfaces ?? externalIpv4Addresses)();
  // Идентификатор — метка поиска и место записи в списке. Записи только добавляются и сливаются
  // на месте, поэтому место устойчиво; метка не даёт идентификатору прошлого поиска указать на
  // другое устройство в новом.
  const token = randomBytes(4).toString('hex');
  const idOf = (index: number): string => `${token}-${index + 1}`;

  let records: readonly ScannerRecord[] = [];
  let started = false;
  let stopped = false;
  const alive = new Set<MdnsInstance>();

  // Пока поиск собирается, вызывающий ещё не получил объект поиска: уведомлять его рано.
  const changed = (): void => {
    if (started && !stopped) {
      options.onChange?.();
    }
  };

  const onAnnouncement = (announcement: Announcement): void => {
    if (stopped) {
      return;
    }
    const record = recordOf(announcement);
    if (record === null) {
      return;
    }
    const next = mergeRecord(records, record, maxScanners);
    if (next !== records) {
      records = next;
      changed();
    }
  };

  // По экземпляру на каждый внешний IPv4-интерфейс: без перебора один прогон из нескольких
  // возвращал пустой результат без единой ошибки (амендмент ADR 0003).
  const destroyQuietly = (instance: MdnsInstance): void => {
    try {
      instance.destroy();
    } catch {
      // Сокет, который не открылся, может не дать себя закрыть; остальные закрываются всё равно.
    }
  };

  function openInstance(address: string): void {
    // Поля объекта, а не переменные: ошибка сокета может прийти раньше, чем `open` вернёт
    // экземпляр, а сужение типа по потоку управления присваиваний из обработчика не видит.
    const slot: { instance: MdnsInstance | null; failed: boolean } = {
      instance: null,
      failed: false,
    };
    const fail = (): void => {
      if (slot.failed) {
        return;
      }
      slot.failed = true;
      // После остановки экземпляр уже закрыт и из `alive` убран.
      if (slot.instance !== null && alive.delete(slot.instance)) {
        destroyQuietly(slot.instance);
        changed();
      }
    };
    try {
      const instance = backend.open(address, fail);
      slot.instance = instance;
      if (slot.failed) {
        destroyQuietly(instance);
        return;
      }
      // В `alive` — до начала поиска: если `browse` бросит, сокет закроет `fail`.
      alive.add(instance);
      for (const type of SERVICE_TYPES) {
        instance.browse(type, onAnnouncement);
      }
    } catch {
      fail();
    }
  }
  for (const address of addresses) {
    openInstance(address);
  }
  started = true;

  let requeries = 0;
  let timer: NodeJS.Timeout | null = null;
  const scheduleRequery = (): void => {
    const pause = REQUERY_DELAYS_MS[Math.min(requeries, REQUERY_DELAYS_MS.length - 1)];
    timer = setTimeout(() => {
      requeries += 1;
      for (const instance of alive) {
        try {
          instance.requery();
        } catch {
          // Сбой сокета придёт своим обработчиком ошибки.
        }
      }
      // Все сокеты отказали — повторять запрос некому.
      if (alive.size > 0) {
        scheduleRequery();
      }
    }, pause);
    // Таймер поиска не держит процесс живым.
    timer.unref();
  };
  if (alive.size > 0) {
    scheduleRequery();
  }

  // Сбой — когда поиск идти не может; пустой список при живых сокетах сбоем не является.
  const failure = (): DiscoveryState['failure'] => {
    if (addresses.length === 0) {
      return 'noNetwork';
    }
    // После остановки сокеты закрыты намеренно.
    return alive.size === 0 && !stopped ? 'socket' : null;
  };

  return {
    state() {
      const scanners: DiscoveredScanner[] = records.map((record, index) => ({
        id: idOf(index),
        name: record.name,
        address: record.address,
        port: record.port,
        hasAdf: record.hasAdf,
      }));
      return { scanners, failure: failure() };
    },
    addressOf(id) {
      const record = records.find((_, position) => idOf(position) === id);
      if (record?.hasAdf !== true) {
        return null;
      }
      // Схема не названа: HTTPS первым, HTTP — при отказе соединения, на том же порту.
      return { scheme: null, host: record.address, port: record.port, basePath: record.basePath };
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      for (const instance of alive) {
        destroyQuietly(instance);
      }
      alive.clear();
    },
  };
}
