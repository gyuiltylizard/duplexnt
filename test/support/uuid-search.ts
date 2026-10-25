import { fail, ok, type Result } from '../../src/shared';
import {
  UUID_SEARCH_WINDOW_MS,
  type UuidSearch,
  type UuidSearchEnd,
  type UuidSearchOptions,
} from '../../src/core/discovery/find-by-uuid';
import type { ProbeClock } from '../../src/core/escl/connect';
import type {
  BufferedResponse,
  ScannerProfile,
  ScannerTransport,
} from '../../src/core/escl/transport';
import { ET_3850, readFixtureText } from './fixtures';

// Швы проверки запомненного сканера с поиском (M5, U4, KTD9): часы, время которых идёт только по
// команде теста, сеть подставных устройств с задержками в этом времени и поиск по UUID без
// сокетов 5353.

/** Поиск, который ничего не находит и сразу заканчивается: обвязки служб на эмуляторе. */
export const noSearch = (): UuidSearch => ({
  done: Promise.resolve('window'),
  stop: () => undefined,
});

/** Часы виртуального времени: `run` ведёт время от таймера к таймеру, пока обещание не исполнится. */
export function virtualClock() {
  let now = 0;
  let order = 0;
  const timers: { at: number; order: number; wake: () => void }[] = [];
  const clock: ProbeClock = {
    now: () => now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted === true) {
          resolve();
          return;
        }
        const timer = {
          at: now + ms,
          order: (order += 1),
          wake: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
        };
        function onAbort(): void {
          timers.splice(timers.indexOf(timer), 1);
          resolve();
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        timers.push(timer);
      }),
  };
  // Микрозадачи исполняются все до фазы `setImmediate`.
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  async function run<T>(promise: Promise<T>): Promise<T> {
    const state = { settled: false };
    promise.then(
      () => (state.settled = true),
      () => (state.settled = true),
    );
    for (;;) {
      await settle();
      if (state.settled) {
        return promise;
      }
      timers.sort((a, b) => a.at - b.at || a.order - b.order);
      const next = timers.shift();
      if (next === undefined || !Number.isFinite(next.at)) {
        throw new Error(`виртуальное время встало на ${String(now)} мс`);
      }
      now = Math.max(now, next.at);
      next.wake();
    }
  }
  return { clock, now: () => now, run };
}

export type VirtualClock = ReturnType<typeof virtualClock>;

const CAPABILITIES = readFixtureText(...ET_3850, 'ScannerCapabilities.xml');

/** Что отвечает устройство: готовый результат или исправный сканер со своим сертификатом. */
export type Answer =
  Result<BufferedResponse> | { readonly fingerprint: string; readonly uuid?: string };

/** Ответ через `afterMs` виртуального времени; `answer: null` — соединение висит без ответа. */
export interface Step {
  readonly afterMs: number;
  readonly answer: Answer | null;
}

export const status = (code: number): Result<BufferedResponse> =>
  ok({
    status: code,
    location: null,
    contentType: null,
    fingerprint: null,
    body: new Uint8Array(),
  });

/**
 * Сеть подставных устройств по ключу `адрес:порт`; n-й запрос к адресу берёт n-й шаг (последний
 * повторяется). Неизвестный адрес молчит отказом соединения. Как настоящий транспорт, отклоняет
 * соединение, когда запомненный отпечаток не совпал с сертификатом (KTD-40).
 */
export function network(clock: ProbeClock, devices: Record<string, Step | readonly Step[]>) {
  const requests: string[] = [];
  let open = 0;
  const createTransport = (profile: ScannerProfile): ScannerTransport => {
    open += 1;
    let closed = false;
    const key = `${profile.host}:${String(profile.port)}`;
    return {
      request: async ({ signal }) => {
        const asked = requests.filter((it) => it === key).length;
        requests.push(key);
        const script = devices[key];
        const steps: readonly Step[] =
          script === undefined
            ? [{ afterMs: 0, answer: fail('scannerUnreachable', { reason: 'refused' }) }]
            : 'afterMs' in script
              ? [script]
              : script;
        const step = steps[Math.min(asked, steps.length - 1)] ?? steps[0];
        await clock.sleep(step?.answer === null ? Infinity : (step?.afterMs ?? 0), signal);
        const answer = step?.answer;
        if (signal?.aborted === true || answer === null || answer === undefined) {
          return fail('canceled');
        }
        if ('ok' in answer) {
          return answer;
        }
        if (profile.fingerprint !== null && profile.fingerprint !== answer.fingerprint) {
          return fail('scannerCertificateChanged');
        }
        const capabilities =
          answer.uuid === undefined
            ? CAPABILITIES
            : CAPABILITIES.replace(
                /<scan:UUID>[^<]*<\/scan:UUID>/,
                `<scan:UUID>${answer.uuid}</scan:UUID>`,
              );
        return ok({
          status: 200,
          location: null,
          contentType: 'text/xml',
          fingerprint: answer.fingerprint,
          body: new TextEncoder().encode(capabilities),
        });
      },
      stream: () => Promise.reject(new Error('страницы в этих тестах не запрашиваются')),
      close: () => {
        if (!closed) {
          closed = true;
          open -= 1;
        }
      },
    };
  };
  return { connector: { createTransport, clock }, requests, open: () => open };
}

/** Объявление сканера в момент `at` виртуального времени от старта проверки. */
export interface Announcement {
  readonly at: number;
  readonly address: string;
  readonly port?: number;
}

/**
 * Поиск по UUID без сокетов: объявления приходят в назначенное время, окно приёма и отмена — как у
 * настоящего `findByUuid`. `ends` — исходы запусков; `running` — не закончившиеся.
 */
export function scriptedSearch(clock: ProbeClock, announcements: readonly Announcement[] = []) {
  const starts: UuidSearchOptions[] = [];
  const ends: UuidSearchEnd[] = [];
  let running = 0;
  const start = (options: UuidSearchOptions): UuidSearch => {
    starts.push(options);
    running += 1;
    const accepting = new AbortController();
    let resolve!: (end: UuidSearchEnd) => void;
    const done = new Promise<UuidSearchEnd>((onResolve) => {
      resolve = onResolve;
    });
    const finish = (end: UuidSearchEnd): void => {
      if (accepting.signal.aborted) {
        return;
      }
      accepting.abort();
      running -= 1;
      ends.push(end);
      resolve(end);
    };
    const startedAt = clock.now();
    if (options.signal?.aborted === true) {
      finish('canceled');
    }
    options.signal?.addEventListener('abort', () => {
      finish('canceled');
    });
    // Объявления одного момента приходят одной пачкой, как записи одного изменения списка.
    for (const moment of new Set(announcements.map((it) => it.at))) {
      void clock.sleep(Math.max(0, moment - startedAt), accepting.signal).then(() => {
        for (const { at, address, port = 443 } of announcements) {
          if (at === moment && !accepting.signal.aborted) {
            options.onCandidate({ address, port, basePath: '/eSCL' });
          }
        }
      });
    }
    void clock.sleep(options.windowMs ?? UUID_SEARCH_WINDOW_MS, accepting.signal).then(() => {
      finish('window');
    });
    return {
      done,
      stop: () => {
        finish('stopped');
      },
    };
  };
  return { start, starts, ends, running: () => running };
}
