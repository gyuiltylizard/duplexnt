import { readdirSync, readFileSync } from 'node:fs';
import * as https from 'node:https';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createTransport } from '../../src/core/escl/transport';
import { startLoopbackServer, type LoopbackServer } from '../support/loopback-server';

// Изоляция TLS на продуктовом коде (план M1, R11, AE13). Транспорт сканера принимает
// самоподписанный сертификат; после этого ТОТ ЖЕ процесс обязан по-прежнему отклонять такой
// сертификат любым другим путём. Тест утверждает факт отказа, а не код ошибки: формулировки
// OpenSSL и BoringSSL расходятся.

const STATUS = '<status>Idle</status>';

async function viaTransport(server: LoopbackServer): Promise<number | string> {
  const transport = createTransport({
    scheme: 'https',
    host: server.host,
    port: server.port,
    basePath: '/eSCL',
    fingerprint: null,
  });
  onTestFinished(() => {
    transport.close();
  });
  const result = await transport.request({ method: 'GET', path: '/eSCL/ScannerStatus' });
  return result.ok ? result.value.status : result.error.code;
}

// `true` — запрос отклонён; `false` — сервер ответил.
function rejectedBy(send: () => Promise<unknown>): Promise<boolean> {
  return send().then(
    () => false,
    () => true,
  );
}

const viaDefaultAgent = (server: LoopbackServer): Promise<unknown> =>
  new Promise((resolve, reject) => {
    https
      .get({ host: server.host, port: server.port, path: '/eSCL/ScannerStatus' }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
      .on('error', reject);
  });

const viaFreshAgent = (server: LoopbackServer): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const agent = new https.Agent();
    https
      .get(
        { host: server.host, port: server.port, path: '/eSCL/ScannerStatus', agent },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      )
      .on('error', reject)
      .on('close', () => {
        agent.destroy();
      });
  });

const viaFetch = (server: LoopbackServer): Promise<unknown> =>
  fetch(`https://${server.host}:${server.port}/eSCL/ScannerStatus`);

describe('изоляция TLS', () => {
  it('транспорт проходит, а тот же сервер через агент по умолчанию и fetch отклонён', async () => {
    const scanner = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.end(STATUS);
    });

    expect(await viaTransport(scanner)).toBe(200);

    expect(await rejectedBy(() => viaDefaultAgent(scanner))).toBe(true);
    expect(await rejectedBy(() => viaFreshAgent(scanner))).toBe(true);
    expect(await rejectedBy(() => viaFetch(scanner))).toBe(true);
    // До обработчика дошёл только запрос транспорта.
    expect(scanner.requests).toEqual(['GET /eSCL/ScannerStatus']);
  });

  it('AE13: после запроса к сканеру посторонний хост с самоподписанным сертификатом отклонён', async () => {
    const scanner = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.end(STATUS);
    });
    const stranger = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.end('чужой');
    });

    expect(await viaTransport(scanner)).toBe(200);

    expect(await rejectedBy(() => viaDefaultAgent(stranger))).toBe(true);
    expect(await rejectedBy(() => viaFetch(stranger))).toBe(true);
    expect(stranger.requests).toEqual([]);
  });

  it('транспорт не трогает глобальное состояние процесса', async () => {
    const before = {
      env: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
      agent: https.globalAgent.options.rejectUnauthorized,
    };
    const scanner = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.end(STATUS);
    });

    expect(await viaTransport(scanner)).toBe(200);

    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before.env);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    expect(https.globalAgent.options.rejectUnauthorized).toBe(before.agent);
    expect(https.globalAgent.options.rejectUnauthorized).not.toBe(false);
  });

  it('отказ — из-за сертификата, а не из-за недоступности: сервер жив и отвечает транспорту', async () => {
    const scanner = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.end(STATUS);
    });

    expect(await rejectedBy(() => viaDefaultAgent(scanner))).toBe(true);
    expect(await viaTransport(scanner)).toBe(200);
    expect(await rejectedBy(() => viaFetch(scanner))).toBe(true);
  });
});

describe('ослабление TLS в исходниках', () => {
  it('встречается в src/ ровно в одном файле — транспорте сканера', () => {
    const relaxing = readdirSync('src', { recursive: true, encoding: 'utf8' })
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => `src/${path.replaceAll('\\', '/')}`)
      .filter((path) => readFileSync(path, 'utf8').includes('rejectUnauthorized'));

    expect(relaxing).toEqual(['src/core/escl/transport.ts']);
  });
});
