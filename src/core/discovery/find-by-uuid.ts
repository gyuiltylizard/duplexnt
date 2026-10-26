import { setTimeout as delay } from 'node:timers/promises';
import type { ProbeClock } from '../escl/connect';
import { startDiscovery, type Discovery, type DiscoveryOptions } from './mdns';

// Поиск запомненного сканера по UUID (M5, KTD2). UUID — только ключ поиска: кандидат лишь говорит,
// где проверить; то же ли это устройство, решает проба с запомненным отпечатком у вызывающего.
// Кандидаты отдаются по мере появления — очередь, порядок проб и пропуск старого адреса —
// забота вызывающего (KTD4). Отбора по автоподаче здесь нет: его тоже решает проба.

// Новые кандидаты принимаются столько от старта поиска: худший замер появления ET-3850 — 7,3 с,
// после смены адреса первое объявление пришло за 1,2–2,0 с (KTD3; журнал M5, U1).
export const UUID_SEARCH_WINDOW_MS = 8000;

/** Где проверить запомненный сканер. Схема не названа — её берёт запомненный профиль. */
export interface UuidCandidate {
  readonly address: string;
  readonly port: number;
  readonly basePath: string;
}

/**
 * Почему поиск закончился: `window` — истекло окно приёма; `noNetwork` и `socket` — поиск идти не
 * может (сбой обнаружения); `canceled` — внешний сигнал отмены; `stopped` — команда вызывающего.
 */
export type UuidSearchEnd = 'window' | 'noNetwork' | 'socket' | 'canceled' | 'stopped';

/** Часы окна приёма — часть `ProbeClock` пробы, чтобы проверка вела сроки одним швом. */
export type SearchClock = Pick<ProbeClock, 'sleep'>;

// Таймер окна не держит процесс живым — как повтор запроса в ./mdns.ts.
const realSearchClock: SearchClock = {
  sleep: (ms, signal) =>
    delay(ms, undefined, { ref: false, ...(signal === undefined ? {} : { signal }) }).catch(
      () => undefined,
    ),
};

export interface UuidSearchOptions {
  /** UUID запомненного сканера; регистр не важен. */
  readonly uuid: string;
  /**
   * Новый кандидат. Каждый адрес с портом приходит один раз. Вызывается не раньше, чем
   * `findByUuid` вернёт объект поиска. Исключение обработчика останавливает поиск, и `done`
   * отклоняется им.
   */
  readonly onCandidate: (candidate: UuidCandidate) => void;
  /** Окно приёма новых кандидатов; по умолчанию — `UUID_SEARCH_WINDOW_MS`. */
  readonly windowMs?: number;
  /** Отмена — закрытие приложения (R9). */
  readonly signal?: AbortSignal;
  readonly clock?: SearchClock;
  /** Подмена библиотеки mDNS и интерфейсов — для тестов. */
  readonly discovery?: Omit<DiscoveryOptions, 'onChange'>;
}

export interface UuidSearch {
  /** Исход поиска. К нему сокеты уже закрыты. */
  readonly done: Promise<UuidSearchEnd>;
  /** Останавливает поиск: кандидат подтверждён или ждать больше незачем. */
  stop(): void;
}

export function findByUuid(options: UuidSearchOptions): UuidSearch {
  // TXT приводится к нижнему регистру при разборе (./txt.ts), UUID из capabilities хранится как
  // есть — сравнение в нижнем регистре с обеих сторон (KTD2).
  const uuid = options.uuid.toLowerCase();
  const clock = options.clock ?? realSearchClock;
  const acceptance = new AbortController();
  const offered = new Set<string>();
  let discovery: Discovery | null = null;
  let finished = false;
  // Поиск может закончиться из обработчика вызывающего, а сужение типа по потоку управления
  // присваиваний из вызова не видит — после вызова флаг читается функцией.
  const ended = (): boolean => finished;

  let resolve!: (end: UuidSearchEnd) => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<UuidSearchEnd>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });

  // Единственный выход: окно, отмена, сбой, команда вызывающего и его исключение — все сюда.
  const finish = (end: UuidSearchEnd | { readonly error: unknown }): void => {
    if (finished) {
      return;
    }
    finished = true;
    acceptance.abort();
    options.signal?.removeEventListener('abort', cancel);
    try {
      discovery?.stop();
    } finally {
      if (typeof end === 'string') {
        resolve(end);
      } else {
        reject(end.error);
      }
    }
  };
  function cancel(): void {
    finish('canceled');
  }

  // Вызывается на каждое изменение списка: записи с UUID сливаются на месте (./txt.ts), поэтому
  // кандидат появляется и тогда, когда UUID пришёл не с первым объявлением адреса.
  const review = (): void => {
    if (finished || discovery === null) {
      return;
    }
    try {
      for (const record of discovery.records()) {
        const key = `${record.address}:${record.port}`;
        if (record.uuid !== uuid || offered.has(key)) {
          continue;
        }
        offered.add(key);
        options.onCandidate({
          address: record.address,
          port: record.port,
          basePath: record.basePath,
        });
        // Вызывающий мог остановить поиск из обработчика.
        if (ended()) {
          return;
        }
      }
    } catch (error) {
      // Обработчик зовётся из события библиотеки: исключение оттуда уронило бы main.
      finish({ error });
      return;
    }
    // Найденное до сбоя вызывающий уже получил.
    const { failure } = discovery.state();
    if (failure !== null) {
      finish(failure);
    }
  };

  const search: UuidSearch = {
    done,
    stop: () => {
      finish('stopped');
    },
  };

  // Отмена до старта сокетов не открывает.
  if (options.signal?.aborted === true) {
    finish('canceled');
    return search;
  }
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    discovery = startDiscovery({ ...options.discovery, onChange: review });
  } catch (error) {
    finish({ error });
    return search;
  }
  // Объявления, пришедшие при старте, и сбой «нет сети» — после возврата объекта поиска:
  // обработчику вызывающего он уже может понадобиться.
  queueMicrotask(() => {
    review();
    if (!finished) {
      void clock.sleep(options.windowMs ?? UUID_SEARCH_WINDOW_MS, acceptance.signal).then(
        () => {
          finish('window');
        },
        () => undefined,
      );
    }
  });
  return search;
}
