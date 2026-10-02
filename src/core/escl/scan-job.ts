import { setTimeout as delay } from 'node:timers/promises';
import { fail, ok, type DomainError, type Result } from '@shared';
import { jobPathFromLocation, SCAN_JOBS_SEGMENT } from './device-path';
import { parseStatus } from './status';
import { TransportError, type ScannerTransport } from './transport';
import type { BadResponseReason } from './xml';

// Задание автоподачи: `POST /ScanJobs` → `NextDocument` до конца → `DELETE` (план M1, R6, KTD-9,
// KTD-10, KTD-11, KTD-31). Правила конца и обрыва — по наблюдениям на ET-3850 (журнал M1, U1), а
// не по исходной формулировке плана:
//
// | Ответ на `NextDocument`                      | Что это                          |
// | `200`, тело дочитано, JPEG от `SOI` до `EOI` | страница                         |
// | `503`                                        | «ещё не готово» — повтор         |
// | `404` после хотя бы одной страницы           | конец прохода                    |
// | `404` на первой странице                     | пустой проход: бумаги не было    |
// | `410`                                        | обрыв: сбой подачи               |
// | соединение закрыто, таймаут, другой отказ    | обрыв                            |
//
// `DELETE` отправляется при любом исходе, если задание создано. Отказ в конверте означает, что
// задания на устройстве нет: закрывать нечего.

export interface ScanJobLimits {
  /** Пауза перед повтором `503` — и на `POST`, и на `NextDocument`. `Retry-After` не читается. */
  readonly retryDelayMs: number;
  /** Сколько ждать, пока устройство занято и не принимает задание. */
  readonly busyCeilingMs: number;
  /** Сколько может длиться серия `503` на `NextDocument` (на устройстве наблюдалось до 7 с). */
  readonly notReadyCeilingMs: number;
  readonly pageIdleTimeoutMs: number;
  /** Общий срок приёма одной страницы. */
  readonly pageDeadlineMs: number;
  readonly maxPageBytes: number;
  /** Потолок числа страниц задания: лоток можно догружать, но не бесконечно. */
  readonly maxPages: number;
  readonly deleteDeadlineMs: number;
}

// Стартовые значения плана (KTD-14, KTD-31), сверенные со следом U1: страница целиком — до 56 с,
// самая тяжёлая — 3,5 МБ, печать трёх страниц держит устройство занятым больше 16 с.
export const SCAN_JOB_LIMITS: ScanJobLimits = {
  retryDelayMs: 1000,
  busyCeilingMs: 60_000,
  notReadyCeilingMs: 30_000,
  pageIdleTimeoutMs: 90_000,
  pageDeadlineMs: 5 * 60_000,
  maxPageBytes: 64 * 1024 * 1024,
  maxPages: 500,
  deleteDeadlineMs: 5000,
};

export interface IncomingPage {
  /** Номер страницы в задании, с единицы, в порядке получения. */
  readonly index: number;
  /**
   * Тело страницы. Поток сам проверяет маркеры JPEG и бросает на обрыве, не-JPEG и пустом теле —
   * поэтому запись через `writeStreamAtomic` до переименования не доходит.
   */
  readonly body: AsyncIterable<Uint8Array>;
}

/**
 * Приёмник страницы. Обязан дочитать тело и завершить запись: следующая страница не
 * запрашивается, пока он не вернулся. Его исключение обрывает задание.
 */
export type PageSink = (page: IncomingPage) => Promise<void>;

export type ScanJobPhase =
  /** Устройство занято: `POST` получил `503`, идёт ожидание. */
  | 'busy'
  /** Задание принято, идут страницы. */
  | 'scanning';

export type InterruptReason =
  /** Отказ устройства или сети. */
  | { readonly source: 'device'; readonly error: DomainError }
  /** Отказ на нашей стороне: приёмник или обработчик вызывающего бросил исключение. */
  | { readonly source: 'sink'; readonly error: unknown };

export type ScanJobEnd =
  /** `404` после хотя бы одной страницы. */
  | { readonly kind: 'completed' }
  /** `404` на первой странице: бумаги не было. */
  | { readonly kind: 'empty' }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'interrupted'; readonly reason: InterruptReason };

export interface ScanJobReport {
  readonly end: ScanJobEnd;
  /** Сколько страниц приёмник принял целиком. */
  readonly pages: number;
  /**
   * Задание на устройстве; `null` — оно не создавалось. `path` — `null`, когда устройство не
   * назвало годного адреса; `closed` — удалось ли задание закрыть.
   */
  readonly job: { readonly path: string | null; readonly closed: boolean } | null;
}

export interface ScanJobClock {
  now(): number;
  /** Пауза, которую отмена обрывает досрочно. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface ScanJobRequest {
  readonly transport: ScannerTransport;
  /** Базовый путь профиля. */
  readonly basePath: string;
  /** Тело `POST /ScanJobs` — из `buildScanSettings`. */
  readonly settings: string;
  readonly sink: PageSink;
  /** «Остановить». Уже ушедший `POST` отмена не обрывает (KTD-10). */
  readonly signal?: AbortSignal;
  /**
   * Обработчики вызывающего. Исключение любого из них после создания задания обрывает задание
   * так же, как исключение приёмника: исход `interrupted` с причиной `sink`, `DELETE` уходит.
   * Исключение `onPhase('busy')` пробрасывается: задания ещё нет, закрывать нечего.
   *
   * При негодном `Location` обработчики ниже не вызываются: страниц не будет, задание
   * закрывается по адресу из статуса, а исход и адрес несёт только отчёт.
   */
  readonly onPhase?: (phase: ScanJobPhase) => void;
  /** Адрес задания — сразу после ответа `201`, до первой страницы (KTD-11). */
  readonly onJobCreated?: (jobPath: string) => Promise<void> | void;
  /** Исход — до `DELETE`: вызывающий записывает его раньше, чем задание закрыто (KTD-17). */
  readonly onEnd?: (end: ScanJobEnd, pages: number) => Promise<void> | void;
  readonly limits?: Partial<ScanJobLimits>;
  readonly clock?: ScanJobClock;
}

const realClock: ScanJobClock = {
  now: Date.now,
  sleep: (ms, signal) =>
    delay(ms, undefined, signal === undefined ? {} : { signal }).catch(() => undefined),
};

// Не путать с `badResponse` из ./xml.ts: тот возвращает конверт, этот — саму ошибку, из которой
// здесь собираются и исход задания, и исключение потока страницы.
const protocolError = (reason: BadResponseReason, status?: number): DomainError => ({
  code: 'scannerBadResponse',
  details: status === undefined ? { reason } : { reason, status },
});

const interrupted = (error: DomainError): ScanJobEnd => ({
  kind: 'interrupted',
  reason: { source: 'device', error },
});

const sinkFailed = (error: unknown): ScanJobEnd => ({
  kind: 'interrupted',
  reason: { source: 'sink', error },
});

const SOI = [0xff, 0xd8] as const;
const EOI = [0xff, 0xd9] as const;

/**
 * Тело страницы с проверкой маркеров JPEG (KTD-31). Начало проверяется до того, как первый байт
 * уйдёт приёмнику; конец — когда тело дочитано по своему обрамлению. `Content-Type` доказательством
 * не считается. `verified` вызывается, только если страница прошла проверку целиком.
 */
async function* jpegOnly(
  body: AsyncIterable<Uint8Array>,
  verified: () => void,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  let tail: [number, number] = [0, 0];
  for await (const chunk of body) {
    for (let index = 0; index < chunk.byteLength && total + index < SOI.length; index += 1) {
      if (chunk[index] !== SOI[total + index]) {
        throw new TransportError(protocolError('notJpeg'));
      }
    }
    if (chunk.byteLength > 0) {
      tail = [chunk.at(-2) ?? tail[1], chunk.at(-1) ?? 0];
      total += chunk.byteLength;
    }
    yield chunk;
  }
  if (total === 0) {
    throw new TransportError(protocolError('emptyPage'));
  }
  if (total < SOI.length + EOI.length || tail[0] !== EOI[0] || tail[1] !== EOI[1]) {
    throw new TransportError(protocolError('notJpeg'));
  }
  verified();
}

/**
 * Закрывает задание. `200` — идущему заданию, `404` — уже закрытому устройством; оба исхода —
 * успех (KTD-11). Отмена сюда не передаётся: закрыть задание нужно и после «Остановить».
 */
export async function closeScanJob(
  transport: ScannerTransport,
  jobPath: string,
  deadlineMs = SCAN_JOB_LIMITS.deleteDeadlineMs,
): Promise<boolean> {
  const result = await transport.request({ method: 'DELETE', path: jobPath, deadlineMs });
  if (!result.ok) {
    return false;
  }
  const { status } = result.value;
  return (status >= 200 && status < 300) || status === 404;
}

// Задание создано, а годного адреса устройство не назвало. Адрес идущего задания виден в статусе
// (журнал M1, U1). Очереди у устройства нет, поэтому сразу после нашего `201` идущее задание —
// наше; если их в статусе не одно, чьё наше — неизвестно, и чужое не трогается.
async function processingJobPath(
  transport: ScannerTransport,
  basePath: string,
): Promise<string | null> {
  const response = await transport.request({ method: 'GET', path: `${basePath}/ScannerStatus` });
  if (!response.ok || response.value.status !== 200) {
    return null;
  }
  const status = parseStatus(response.value.body);
  if (!status.ok) {
    return null;
  }
  const running = status.value.jobs.filter((job) => job.state === 'Processing');
  return running.length === 1 ? jobPathFromLocation(running[0]?.uri, basePath) : null;
}

export async function runScanJob(request: ScanJobRequest): Promise<Result<ScanJobReport>> {
  const { transport, basePath, signal } = request;
  const limits: ScanJobLimits = { ...SCAN_JOB_LIMITS, ...request.limits };
  const clock = request.clock ?? realClock;
  const canceled = (): boolean => signal?.aborted === true;

  // --- Создание задания: занятость повторяется раз в `retryDelayMs` до потолка (KTD-10). ---
  let location: string | null;
  let busySince: number | null = null;
  for (;;) {
    if (canceled()) {
      return ok({ end: { kind: 'canceled' }, pages: 0, job: null });
    }
    // Сигнал отмены в `POST` не передаётся: оборванный запрос оставил бы на устройстве задание
    // с неизвестным адресом. Клиент дожидается ответа и закрывает задание.
    const posted = await transport.request({
      method: 'POST',
      path: `${basePath}/${SCAN_JOBS_SEGMENT}`,
      body: request.settings,
    });
    if (!posted.ok) {
      return posted;
    }
    const { status } = posted.value;
    if (status === 201) {
      location = posted.value.location;
      break;
    }
    if (status === 409) {
      // Параметры, которых устройство не берёт. Повтор бессмыслен: это не занятость.
      return fail('scanParamsRejected');
    }
    if (status !== 503) {
      return { ok: false, error: protocolError('status', status) };
    }
    if (busySince === null) {
      busySince = clock.now();
      request.onPhase?.('busy');
    }
    if (clock.now() - busySince + limits.retryDelayMs > limits.busyCeilingMs) {
      return fail('scannerBusy');
    }
    await clock.sleep(limits.retryDelayMs, signal);
  }

  const jobPath = jobPathFromLocation(location, basePath);
  if (jobPath === null) {
    const found = await processingJobPath(transport, basePath);
    const closed =
      found !== null && (await closeScanJob(transport, found, limits.deleteDeadlineMs));
    return ok({
      end: interrupted(protocolError('location')),
      pages: 0,
      job: { path: found, closed },
    });
  }

  // --- Страницы. ---
  let pages = 0;

  async function receivePages(): Promise<ScanJobEnd> {
    let notReadySince: number | null = null;
    for (;;) {
      if (canceled()) {
        return { kind: 'canceled' };
      }
      if (pages >= limits.maxPages) {
        return interrupted(protocolError('tooManyPages'));
      }
      const index = pages + 1;
      const fetched = await transport.stream(
        {
          method: 'GET',
          path: `${jobPath}/NextDocument`,
          maxBytes: limits.maxPageBytes,
          idleTimeoutMs: limits.pageIdleTimeoutMs,
          deadlineMs: limits.pageDeadlineMs,
          ...(signal === undefined ? {} : { signal }),
        },
        async (head, body) => {
          if (head.status !== 200 || body === null) {
            return head.status;
          }
          // Поле объекта, а не переменная: присваивание идёт из генератора, и сужение типа по
          // потоку управления иначе считает значение неизменным.
          const check = { verified: false };
          await request.sink({
            index,
            body: jpegOnly(body, () => {
              check.verified = true;
            }),
          });
          if (!check.verified) {
            throw new Error('приёмник вернулся, не дочитав страницу: она не проверена');
          }
          return head.status;
        },
      );

      if (!fetched.ok) {
        return fetched.error.code === 'canceled'
          ? { kind: 'canceled' }
          : interrupted(fetched.error);
      }
      const status = fetched.value;
      if (status === 200) {
        pages += 1;
        notReadySince = null;
        continue;
      }
      if (status === 404) {
        return pages > 0 ? { kind: 'completed' } : { kind: 'empty' };
      }
      if (status === 410) {
        return interrupted({ code: 'scanFeedFailed', details: { reason: 'gone' } });
      }
      if (status !== 503) {
        return interrupted(protocolError('status', status));
      }
      // `503` между страницами — штатное «лист ещё едет»; обрыв — только затянувшаяся серия.
      notReadySince ??= clock.now();
      if (clock.now() - notReadySince + limits.retryDelayMs > limits.notReadyCeilingMs) {
        return interrupted({ code: 'scanFeedFailed', details: { reason: 'notReady' } });
      }
      await clock.sleep(limits.retryDelayMs, signal);
    }
  }

  let end: ScanJobEnd;
  try {
    await request.onJobCreated?.(jobPath);
    request.onPhase?.('scanning');
    end = await receivePages();
  } catch (error) {
    end = sinkFailed(error);
  }
  try {
    await request.onEnd?.(end, pages);
  } catch (error) {
    end = sinkFailed(error);
  }

  const closed = await closeScanJob(transport, jobPath, limits.deleteDeadlineMs);
  return ok({ end, pages, job: { path: jobPath, closed } });
}
