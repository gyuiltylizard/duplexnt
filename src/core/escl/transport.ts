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

// Стартовые значения плана (KTD-14), подтверждённые следом U1: рукопожатие TLS — до 0,8 с,
// XML-ответ — до 40 мс.
export const TRANSPORT_DEFAULTS = {
  connectTimeoutMs: 5000,
  idleTimeoutMs: 10_000,
  maxXmlBytes: XML_LIMITS.maxBytes,
} as const;

export interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** Путь под базой профиля. Всё остальное отклоняется до обращения к сети. */
  readonly path: string;
  /** Тело запроса — XML. */
  readonly body?: string;
  readonly signal?: AbortSignal;
  /** Сколько ждать соединения вместе с рукопожатием TLS. */
  readonly connectTimeoutMs?: number;
  /** Сколько соединение может молчать — до заголовков ответа и между частями тела. */
  readonly idleTimeoutMs?: number;
  /** Общий срок обмена от запроса до конца тела. */
  readonly deadlineMs?: number;
}

export interface ResponseHead {
  readonly status: number;
  /** Сырое значение заголовка — данные устройства; путь из него берёт ./device-path.ts. */
  readonly location: string | null;
  readonly contentType: string | null;
  /** Отпечаток сертификата на этом соединении; `null` на HTTP. */
  readonly fingerprint: string | null;
}

export interface BufferedResponse extends ResponseHead {
  readonly body: Uint8Array;
}

export interface StreamedResponse extends ResponseHead {
  /**
   * Тело ответа `200` потоком; у остальных статусов — `null`, соединение уже закрыто. Сбой при
   * чтении бросает `TransportError`. Поток обязан быть дочитан или прерван вызывающим.
   */
  readonly body: AsyncIterable<Uint8Array> | null;
}

export interface ScannerTransport {
  /** Запрос с телом ответа в памяти; тело больше потолка — отказ, а не усечение. */
  request(
    options: RequestOptions & { readonly maxBytes?: number },
  ): Promise<Result<BufferedResponse>>;
  /** Запрос страницы: тело отдаётся потоком с потолком размера по сосчитанным байтам. */
  stream(
    options: RequestOptions & { readonly maxBytes: number },
  ): Promise<Result<StreamedResponse>>;
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

function fingerprintOf(socket: TLSSocket): string | null {
  const raw: unknown = socket.getPeerCertificate().raw;
  return raw instanceof Uint8Array ? createHash('sha256').update(raw).digest('hex') : null;
}

const headerOf = (value: string | string[] | undefined): string | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

interface Opened {
  readonly head: ResponseHead;
  readonly response: http.IncomingMessage;
  /** Обрывает обмен с указанной причиной. */
  readonly abort: (error: TransportError) => void;
  /** Снимает таймеры и подписку на отмену; вызывается, когда обмен окончен. */
  readonly release: () => void;
}

export function createTransport(profile: ScannerProfile): ScannerTransport {
  const secure = profile.scheme === 'https';
  // Соединение на запрос: устройство и так отвечает `Connection: close` (журнал M1, U1), а новое
  // соединение — это новая сверка отпечатка. Возобновление сессии TLS делает его дешёвым.
  const agent = secure
    ? new https.Agent({ keepAlive: false, rejectUnauthorized: false })
    : new http.Agent({ keepAlive: false });

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
      const request = (secure ? https : http).request({
        agent,
        host: profile.host,
        port: profile.port,
        method: options.method,
        path: options.path,
        headers,
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
      }, options.connectTimeoutMs ?? TRANSPORT_DEFAULTS.connectTimeoutMs);
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
        // Запрос не отправлен, пока не вызван `end`: до сверки отпечатка в сеть не уходит ничего,
        // кроме рукопожатия.
        socket.once(secure ? 'secureConnect' : 'connect', () => {
          clearTimeout(connectTimer);
          if (secure) {
            fingerprint = fingerprintOf(socket as TLSSocket);
            if (profile.fingerprint !== null && fingerprint !== profile.fingerprint) {
              abort(new TransportError({ code: 'scannerCertificateChanged' }));
              return;
            }
          }
          request.setTimeout(options.idleTimeoutMs ?? TRANSPORT_DEFAULTS.idleTimeoutMs, () => {
            abort(unreachable('timeout'));
          });
          request.end(options.body);
        });
      });
      request.once('response', (incoming) => {
        response = incoming;
        resolve({
          head: {
            status: incoming.statusCode ?? 0,
            location: headerOf(incoming.headers.location),
            contentType: headerOf(incoming.headers['content-type']),
            fingerprint,
          },
          response: incoming,
          abort,
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
    });
  }

  const foreignPath = (path: string): boolean => !isUnderBase(path, profile.basePath);

  return {
    async request(options) {
      if (foreignPath(options.path)) {
        return badResponse('foreignPath');
      }
      const maxBytes = options.maxBytes ?? TRANSPORT_DEFAULTS.maxXmlBytes;

      let opened: Opened;
      try {
        opened = await open(options);
      } catch (error) {
        return failureOf(error);
      }
      try {
        const declared = Number(headerOf(opened.response.headers['content-length']) ?? 0);
        if (declared > maxBytes) {
          throw badResponseError('tooLarge');
        }
        const chunks: Uint8Array[] = [];
        let received = 0;
        for await (const chunk of opened.response as AsyncIterable<Uint8Array>) {
          received += chunk.byteLength;
          if (received > maxBytes) {
            throw badResponseError('tooLarge');
          }
          chunks.push(chunk);
        }
        return ok({ ...opened.head, body: Buffer.concat(chunks) });
      } catch (error) {
        return failureOf(error);
      } finally {
        opened.release();
        opened.response.destroy();
      }
    },

    async stream(options) {
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
      if (head.status !== 200) {
        release();
        response.destroy();
        return ok({ ...head, body: null });
      }

      const { maxBytes } = options;
      async function* body(): AsyncGenerator<Uint8Array> {
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
        } finally {
          release();
          response.destroy();
        }
      }
      return ok({ ...head, body: body() });
    },

    close() {
      agent.destroy();
    },
  };
}
