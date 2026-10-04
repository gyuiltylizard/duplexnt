import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { onTestFinished } from 'vitest';
import { createSelfSignedCert, type SelfSignedCert } from './self-signed-cert';

// Локальный сервер для тестов сетевого слоя. Слушает только loopback — файрвол Windows не
// спрашивает разрешения, сеть не нужна. Закрывается по окончании теста, который его завёл.

export interface LoopbackServer {
  readonly host: '127.0.0.1';
  readonly port: number;
  /** Сертификат сервера; `null` у сервера на HTTP. */
  readonly cert: SelfSignedCert | null;
  /** Сколько раз к серверу подключились (TCP). */
  connections(): number;
  /** Запросы, дошедшие до обработчика: метод и путь. */
  readonly requests: readonly string[];
}

interface LoopbackOptions {
  readonly tls: boolean;
  /** Готовый сертификат вместо свежего — чтобы поднять второй сервер с тем же. */
  readonly cert?: SelfSignedCert;
  /** Порт вместо случайного — чтобы подменить устройство на том же origin. */
  readonly port?: number;
}

/** Поднимает сервер и ждёт, пока он начнёт слушать. Вызывать изнутри `it(...)`. */
export async function startLoopbackServer(
  options: LoopbackOptions,
  handler: http.RequestListener,
): Promise<LoopbackServer & { close(): Promise<void> }> {
  const cert = options.tls ? (options.cert ?? createSelfSignedCert()) : null;
  const requests: string[] = [];
  const listener: http.RequestListener = (request, response) => {
    requests.push(`${request.method ?? '?'} ${request.url ?? '?'}`);
    handler(request, response);
  };
  const server =
    cert === null
      ? http.createServer(listener)
      : https.createServer({ key: cert.keyPem, cert: cert.certPem }, listener);

  let connections = 0;
  server.on('connection', () => {
    connections += 1;
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  let closed = false;
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      closed = true;
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  onTestFinished(close);

  return {
    host: '127.0.0.1',
    port: (server.address() as AddressInfo).port,
    cert,
    connections: () => connections,
    requests,
    close,
  };
}
