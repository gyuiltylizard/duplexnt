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
    const browsers: { stop(): void; update(): void }[] = [];
    return {
      browse(type, onUp) {
        browsers.push(
          bonjour.find({ type, protocol: 'tcp' }, (service) => {
            onUp({
              name: service.name,
              port: service.port,
              addresses: service.addresses ?? [],
              // Библиотека разбирает TXT наивно (`note=` у неё — ключ со знаком равенства);
              // записи берутся сырыми и разбираются в ./txt.ts.
              txt: txtEntries((service as { rawTxt?: unknown }).rawTxt),
            });
          }),
        );
      },
      requery() {
        for (const browser of browsers) {
          browser.update();
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
  let stopped = false;
  const alive = new Set<MdnsInstance>();

  const changed = (): void => {
    options.onChange?.();
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
  for (const address of addresses) {
    const holder: { instance: MdnsInstance | null; failed: boolean } = {
      instance: null,
      failed: false,
    };
    const fail = (): void => {
      if (holder.failed) {
        return;
      }
      holder.failed = true;
      if (holder.instance !== null && alive.delete(holder.instance)) {
        try {
          holder.instance.destroy();
        } catch {
          // Сокет, который не открылся, может не дать себя закрыть.
        }
        if (!stopped) {
          changed();
        }
      }
    };
    try {
      const instance = backend.open(address, fail);
      holder.instance = instance;
      if (holder.failed) {
        instance.destroy();
        continue;
      }
      for (const type of SERVICE_TYPES) {
        instance.browse(type, onAnnouncement);
      }
      alive.add(instance);
    } catch {
      fail();
    }
  }

  // Сбой — когда поиск идти не может; пустой список при живых сокетах сбоем не является.
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
      scheduleRequery();
    }, pause);
    // Таймер поиска не держит процесс живым.
    timer.unref();
  };
  if (alive.size > 0) {
    scheduleRequery();
  }

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
      const index = records.findIndex((_, position) => idOf(position) === id);
      const record = records[index];
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
        try {
          instance.destroy();
        } catch {
          // Остальные сокеты всё равно должны быть закрыты.
        }
      }
      alive.clear();
    },
  };
}
