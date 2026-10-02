import { createHash } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { fail, ok, type DomainError, type Result } from '@shared';
import { isUnderBase } from './device-path';
import { badResponse, XML_LIMITS, type BadResponseReason } from './xml';

// Сетевой слой клиента сканера (план M1, KTD-6, KTD-7, KTD-40).
//
// ЕДИНСТВЕННЫЙ файл в src/, где проверка TLS ослаблена: сканер отдаёт самоподписанный сертификат.
// Ослабление живёт в агенте, который создаётся под профиль сканера и из модуля не выходит;
// глобальный агент, `fetch` и переменные окружения не трогаются (тест
// test/integration/tls-isolation.test.ts). Исключение линтера открыто ровно для этого файла.
//
// Инварианты:
// - запрос уходит только на origin профиля и только по пути под его базой;
// - переходы по 3xx не исполняются: ответ отдаётся вызывающему как есть;
// - при ослабленной проверке Node идентичность сервера не проверяет вовсе, поэтому отпечаток
//   сертификата сверяется здесь, явным шагом на каждом соединении, ДО отправки запроса;
// - у каждого обмена есть общий срок: устройство, цедящее ответ по байту, не держит его вечно;
// - сжатие не запрашивается и не раскрывается, `Retry-After` не читается.

export interface ScannerProfile {
  readonly scheme: 'https' | 'http';
  readonly host: string;
  readonly port: number;
  /** Нормализованный базовый путь (./device-path.ts): `/eSCL` или пустая строка. */
  readonly basePath: string;
  /**
   * SHA-256 сертификата сканера, hex в нижнем регистре. `null` — отпечаток ещё не запомнен
   * (первое подключение) или профиль на HTTP.
   */
  readonly fingerprint: string | null;
}

export interface TransportLimits {
  /** Сколько ждать соединения вместе с рукопожатием TLS. */
  readonly connectTimeoutMs: number;
  /** Сколько соединение может молчать — до заголовков ответа и между частями тела. */
  readonly idleTimeoutMs: number;
  /** Общий срок запроса с телом в памяти, если вызывающий не задал свой. */
  readonly requestDeadlineMs: number;
  readonly maxXmlBytes: number;
}

// Стартовые значения плана (KTD-14), подтверждённые следом U1: рукопожатие TLS — до 0,8 с,
// XML-ответ — до 40 мс, первый ответ уснувшего устройства — 0,9 с.
export const TRANSPORT_DEFAULTS: TransportLimits = {
  connectTimeoutMs: 5000,
  idleTimeoutMs: 10_000,
  requestDeadlineMs: 10_000,
  maxXmlBytes: XML_LIMITS.maxBytes,
};

export interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** Путь под базой профиля. Всё остальное отклоняется до обращения к сети. */
  readonly path: string;
  /** Тело запроса — XML. */
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly connectTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  /** Общий срок обмена от запроса до конца тела. */
  readonly deadlineMs?: number;
}

/** Страница: потолок размера, таймаут тишины и общий срок обязательны — умолчаний у них нет. */
export interface StreamOptions extends RequestOptions {
  readonly maxBytes: number;
  readonly idleTimeoutMs: number;
  readonly deadlineMs: number;
}

export interface ResponseHead {
  readonly status: number;
  /** Сырое значение заголовка — данные устройства; путь из него берёт ./device-path.ts. */
  readonly location: string | null;
  readonly contentType: string | null;
  /** Отпечаток сертификата сканера на этом соединении; `null` только на HTTP. */
  readonly fingerprint: string | null;
}

export interface BufferedResponse extends ResponseHead {
  readonly body: Uint8Array;
}

/**
 * Получатель страницы. Тело есть только у ответа `200`; сбой при его чтении бросает
 * `TransportError`. Соединение закрывает транспорт — когда получатель вернул значение или бросил
 * исключение, в том числе не начав читать.
 */
export type StreamConsumer<T> = (
  head: ResponseHead,
  body: AsyncIterable<Uint8Array> | null,
) => Promise<T>;

export interface ScannerTransport {
  /** Запрос с телом ответа в памяти; тело больше потолка — отказ, а не усечение. */
  request(
    options: RequestOptions & { readonly maxBytes?: number },
  ): Promise<Result<BufferedResponse>>;
  /**
   * Запрос страницы: тело отдаётся получателю потоком с потолком по сосчитанным байтам. Сбой
   * обмена — отказ в конверте; исключение получателя, не связанное с сетью, пробрасывается.
   */
  stream<T>(options: StreamOptions, consume: StreamConsumer<T>): Promise<Result<T>>;
  /** Закрывает агент профиля. */
  close(): void;
}

/** Сбой обмена с устройством; несёт доменную ошибку для конверта. */
export class TransportError extends Error {
  constructor(readonly failure: DomainError) {
    super(failure.code);
    this.name = 'TransportError';
  }
}

export type UnreachableReason =
  'refused' | 'timeout' | 'dns' | 'reset' | 'tls' | 'network' | 'other';

const unreachable = (reason: UnreachableReason): TransportError =>
  new TransportError({ code: 'scannerUnreachable', details: { reason } });
const badResponseError = (reason: BadResponseReason): TransportError =>
  new TransportError({ code: 'scannerBadResponse', details: { reason } });

const REASON_BY_CODE = new Map<string, UnreachableReason>([
  ['ECONNREFUSED', 'refused'],
  ['ETIMEDOUT', 'timeout'],
  ['ENOTFOUND', 'dns'],
  ['EAI_AGAIN', 'dns'],
  ['ECONNRESET', 'reset'],
  ['ECONNABORTED', 'reset'],
  ['EPIPE', 'reset'],
  ['EHOSTUNREACH', 'network'],
  ['ENETUNREACH', 'network'],
  ['EADDRNOTAVAIL', 'network'],
  ['EPROTO', 'tls'],
]);

function toTransportError(error: unknown): TransportError {
  if (error instanceof TransportError) {
    return error;
  }
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' ? raw : '';
  if (code.startsWith('HPE_')) {
    return badResponseError('http');
  }
  if (code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')) {
    return unreachable('tls');
  }
  return unreachable(REASON_BY_CODE.get(code) ?? 'other');
}

const failureOf = (error: unknown): Result<never> => {
  const { failure } = toTransportError(error);
  return fail(failure.code, failure.details);
};

function certificateFingerprint(socket: TLSSocket): string | null {
  const raw: unknown = (socket.getPeerCertificate() as { raw?: unknown } | null)?.raw;
  return raw instanceof Uint8Array ? createHash('sha256').update(raw).digest('hex') : null;
}

const headerOf = (value: string | string[] | undefined): string | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

// Тело ответа с потолком по сосчитанным байтам; любой сбой чтения — `TransportError`.
async function* bounded(
  response: http.IncomingMessage,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  let received = 0;
  try {
    for await (const chunk of response as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength;
      if (received > maxBytes) {
        throw badResponseError('tooLarge');
      }
      yield chunk;
    }
  } catch (error) {
    throw toTransportError(error);
  }
}

/** Сессия TLS соединения, прошедшего сверку, и отпечаток сертификата, которому она принадлежит. */
interface TrustedSession {
  readonly session: Buffer;
  readonly fingerprint: string;
}

interface Opened {
  readonly head: ResponseHead;
  readonly response: http.IncomingMessage;
  /** Снимает таймеры и подписку на отмену; повторный вызов безвреден. */
  readonly release: () => void;
}

export function createTransport(
  profile: ScannerProfile,
  limits: Partial<TransportLimits> = {},
): ScannerTransport {
  const defaults: TransportLimits = { ...TRANSPORT_DEFAULTS, ...limits };
  const secure = profile.scheme === 'https';
  // Соединение на запрос: устройство и так отвечает `Connection: close` (журнал M1, U1), а новое
  // соединение — это новая сверка отпечатка. Кэш сессий агента выключен: он запоминает сессию
  // ДО сверки, то есть и сессию подменного устройства. Возобновлением ведает сам транспорт.
  const agent = secure
    ? new https.Agent({ keepAlive: false, rejectUnauthorized: false, maxCachedSessions: 0 })
    : new http.Agent({ keepAlive: false });

  // Возобновление делает соединение дешёвым: 10–20 мс вместо 0,7 с полного рукопожатия на
  // ET-3850. Запоминается сессия только того соединения, чей сертификат прошёл сверку.
  let trusted: TrustedSession | null = null;

  function open(options: RequestOptions): Promise<Opened> {
    return new Promise((resolve, reject) => {
      const { signal } = options;
      if (signal?.aborted === true) {
        reject(new TransportError({ code: 'canceled' }));
        return;
      }

      const headers: Record<string, string | number> = {};
      if (options.body !== undefined) {
        headers['Content-Type'] = 'text/xml';
        headers['Content-Length'] = Buffer.byteLength(options.body);
      }
      const offered = trusted;
      const request = (secure ? https : http).request({
        agent,
        host: profile.host,
        port: profile.port,
        method: options.method,
        path: options.path,
        headers,
        ...(offered === null ? {} : { session: offered.session }),
      });

      let response: http.IncomingMessage | null = null;
      let fingerprint: string | null = null;
      const abort = (error: TransportError): void => {
        // После заголовков причину несёт поток ответа: её увидит читающий тело.
        if (response === null) {
          request.destroy(error);
        } else {
          response.destroy(error);
        }
      };

      const timers: NodeJS.Timeout[] = [];
      const connectTimer = setTimeout(() => {
        abort(unreachable('timeout'));
      }, options.connectTimeoutMs ?? defaults.connectTimeoutMs);
      timers.push(connectTimer);
      if (options.deadlineMs !== undefined) {
        timers.push(
          setTimeout(() => {
            abort(unreachable('timeout'));
          }, options.deadlineMs),
        );
      }
      const onAbort = (): void => {
        abort(new TransportError({ code: 'canceled' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const release = (): void => {
        for (const timer of timers) {
          clearTimeout(timer);
        }
        signal?.removeEventListener('abort', onAbort);
      };

      request.once('socket', (socket) => {
        let verified = false;
        let pendingSession: Buffer | null = null;
        const remember = (session: Buffer): void => {
          if (fingerprint !== null) {
            trusted = { session, fingerprint };
          }
        };
        if (secure) {
          // Событие приходит до или после конца рукопожатия — зависит от версии TLS.
          socket.on('session', (session: Buffer) => {
            if (verified) {
              remember(session);
            } else {
              pendingSession = session;
            }
          });
        }

        // Запрос не отправлен, пока не вызван `end`: до сверки отпечатка в сеть не уходит ничего,
        // кроме рукопожатия.
        socket.once(secure ? 'secureConnect' : 'connect', () => {
          clearTimeout(connectTimer);
          if (secure) {
            const tlsSocket = socket as TLSSocket;
            // На возобновлённой сессии OpenSSL сертификата не отдаёт вовсе (BoringSSL — отдаёт).
            // Возобновить сессию может только тот, у кого её ключи, — устройство, прошедшее
            // сверку; отпечаток берётся тот, что привязан к предложенной сессии.
            fingerprint =
              certificateFingerprint(tlsSocket) ??
              (tlsSocket.isSessionReused() && offered !== null ? offered.fingerprint : null);
            if (fingerprint === null) {
              abort(unreachable('tls'));
              return;
            }
            if (profile.fingerprint !== null && fingerprint !== profile.fingerprint) {
              abort(new TransportError({ code: 'scannerCertificateChanged' }));
              return;
            }
            verified = true;
            if (pendingSession !== null) {
              remember(pendingSession);
            }
          }
          request.setTimeout(options.idleTimeoutMs ?? defaults.idleTimeoutMs, () => {
            abort(unreachable('timeout'));
          });
          request.end(options.body);
        });
      });
      request.once('response', (incoming) => {
        response = incoming;
        // Уборка не зависит от того, прочитал ли кто-то тело: ответ закрылся — таймеры сняты.
        incoming.once('close', release);
        resolve({
          head: {
            status: incoming.statusCode ?? 0,
            location: headerOf(incoming.headers.location),
            contentType: headerOf(incoming.headers['content-type']),
            fingerprint,
          },
          response: incoming,
          release,
        });
      });
      // `on`, а не `once`: ошибка сокета после заголовков приходит и сюда; без слушателя она
      // стала бы необработанным исключением в main. Причину тогда несёт поток ответа.
      request.on('error', (error) => {
        if (response === null) {
          release();
          reject(toTransportError(error));
        }
      });
      // Запрос может закрыться без ответа и без ошибки — так Node обходится с `101 Switching
      // Protocols`. Без этого слушателя обмен не кончился бы никогда: ни таймаут, ни отмена до
      // закрытого сокета не дотягиваются. После `error` повторный отказ ничего не меняет.
      request.once('close', () => {
        if (response === null) {
          release();
          reject(badResponseError('http'));
        }
      });
    });
  }

  const foreignPath = (path: string): boolean => !isUnderBase(path, profile.basePath);

  return {
    async request(options) {
      if (foreignPath(options.path)) {
        return badResponse('foreignPath');
      }
      const maxBytes = options.maxBytes ?? defaults.maxXmlBytes;

      let opened: Opened;
      try {
        opened = await open({
          ...options,
          deadlineMs: options.deadlineMs ?? defaults.requestDeadlineMs,
        });
      } catch (error) {
        return failureOf(error);
      }
      const { head, response, release } = opened;
      try {
        const declared = Number(headerOf(response.headers['content-length']) ?? 0);
        if (declared > maxBytes) {
          throw badResponseError('tooLarge');
        }
        const chunks: Uint8Array[] = [];
        for await (const chunk of bounded(response, maxBytes)) {
          chunks.push(chunk);
        }
        return ok({ ...head, body: Buffer.concat(chunks) });
      } catch (error) {
        return failureOf(error);
      } finally {
        release();
        response.destroy();
      }
    },

    async stream(options, consume) {
      if (foreignPath(options.path)) {
        return badResponse('foreignPath');
      }

      let opened: Opened;
      try {
        opened = await open(options);
      } catch (error) {
        return failureOf(error);
      }
      const { head, response, release } = opened;
      try {
        if (head.status !== 200) {
          response.destroy();
          return ok(await consume(head, null));
        }
        return ok(await consume(head, bounded(response, options.maxBytes)));
      } catch (error) {
        if (error instanceof TransportError) {
          return failureOf(error);
        }
        throw error;
      } finally {
        release();
        response.destroy();
      }
    },

    close() {
      agent.destroy();
    },
  };
}
