import * as net from 'node:net';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, onTestFinished } from 'vitest';
import { startLoopbackServer, type LoopbackServer } from '../../../test/support/loopback-server';
import { createSelfSignedCert } from '../../../test/support/self-signed-cert';
import {
  createTransport,
  TransportError,
  type ScannerProfile,
  type ScannerTransport,
} from './transport';

const STATUS_XML = '<?xml version="1.0"?><status>Idle</status>';

function transportFor(
  server: Pick<LoopbackServer, 'host' | 'port' | 'cert'>,
  overrides: Partial<ScannerProfile> = {},
): ScannerTransport {
  const transport = createTransport({
    scheme: server.cert === null ? 'http' : 'https',
    host: server.host,
    port: server.port,
    basePath: '/eSCL',
    fingerprint: null,
    ...overrides,
  });
  onTestFinished(() => {
    transport.close();
  });
  return transport;
}

const respond =
  (status: number, body = '', headers: Record<string, string> = {}) =>
  (_request: unknown, response: ServerResponse): void => {
    response.writeHead(status, headers).end(body);
  };

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// Ответ мимо HTTP-сервера Node: так можно соврать в `Content-Length` и писать имена заголовков
// прописными, как это делает ET-3850.
const rawResponse =
  (raw: string) =>
  (_request: unknown, response: ServerResponse): void => {
    response.socket?.end(raw);
  };

async function collect(body: AsyncIterable<Uint8Array> | null): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body ?? []) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

describe('транспорт: запрос к сканеру', () => {
  it('запрос к серверу с самоподписанным сертификатом через транспорт профиля проходит', async () => {
    const server = await startLoopbackServer(
      { tls: true },
      respond(200, STATUS_XML, { 'Content-Type': 'text/xml' }),
    );

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe(200);
      expect(text(result.value.body)).toBe(STATUS_XML);
      expect(result.value.contentType).toBe('text/xml');
    }
    expect(server.requests).toEqual(['GET /eSCL/ScannerStatus']);
  });

  it('первое подключение без запомненного отпечатка возвращает отпечаток вызывающему', async () => {
    const server = await startLoopbackServer({ tls: true }, respond(200, STATUS_XML));

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
    });

    expect(result.ok && result.value.fingerprint).toBe(server.cert?.fingerprint);
    expect(server.cert?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('профиль на HTTP работает и отпечатка не имеет', async () => {
    const server = await startLoopbackServer({ tls: false }, respond(200, STATUS_XML));

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
    });

    expect(result.ok && result.value.fingerprint).toBeNull();
    expect(result.ok && text(result.value.body)).toBe(STATUS_XML);
  });

  it('POST несёт тело XML с длиной и типом; Location отдаётся сырым значением', async () => {
    let received = '';
    let contentType: string | undefined;
    let contentLength: string | undefined;
    const server = await startLoopbackServer({ tls: true }, (request, response) => {
      contentType = request.headers['content-type'];
      contentLength = request.headers['content-length'];
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        received += chunk;
      });
      request.on('end', () => {
        response.writeHead(201, { Location: 'https://192.0.2.10:443/eSCL/ScanJobs/abc' }).end();
      });
    });
    const body = '<scan:ScanSettings>страница</scan:ScanSettings>';

    const result = await transportFor(server).request({
      method: 'POST',
      path: '/eSCL/ScanJobs',
      body,
    });

    expect(result.ok && result.value.status).toBe(201);
    expect(result.ok && result.value.location).toBe('https://192.0.2.10:443/eSCL/ScanJobs/abc');
    expect(received).toBe(body);
    expect(contentType).toBe('text/xml');
    expect(contentLength).toBe(String(Buffer.byteLength(body)));
  });

  it('заголовки прописными, как у ET-3850, читаются', async () => {
    const server = await startLoopbackServer(
      { tls: true },
      rawResponse(
        'HTTP/1.1 201 Created\r\nLOCATION: /eSCL/ScanJobs/abc\r\nCONTENT-LENGTH: 0\r\nCONNECTION: close\r\n\r\n',
      ),
    );

    const result = await transportFor(server).request({ method: 'POST', path: '/eSCL/ScanJobs' });

    expect(result.ok && result.value.status).toBe(201);
    expect(result.ok && result.value.location).toBe('/eSCL/ScanJobs/abc');
  });

  it('сжатие не запрашивается', async () => {
    let acceptEncoding: string | undefined = 'не запрошен';
    const server = await startLoopbackServer({ tls: true }, (request, response) => {
      acceptEncoding = request.headers['accept-encoding'];
      response.end();
    });

    await transportFor(server).request({ method: 'GET', path: '/eSCL/ScannerStatus' });

    expect(acceptEncoding).toBeUndefined();
  });
});

describe('транспорт: привязка к origin и пути профиля', () => {
  it.each([
    'https://evil.example/eSCL/ScannerStatus',
    'http://127.0.0.1/eSCL/ScannerStatus',
    '//evil.example/eSCL/ScannerStatus',
    '/other/ScannerStatus',
    '/eSCLx/ScannerStatus',
    '/eSCL/../admin',
    '/eSCL/ScannerStatus?x=1',
    '/eSCL',
    '',
  ])('запрос к чужому origin или пути отклоняется без обращения к сети: %j', async (path) => {
    const server = await startLoopbackServer({ tls: true }, respond(200));
    const transport = transportFor(server);

    expect(await transport.request({ method: 'GET', path })).toEqual({
      ok: false,
      error: { code: 'scannerBadResponse', details: { reason: 'foreignPath' } },
    });
    expect(await transport.stream({ method: 'GET', path, maxBytes: 10 })).toMatchObject({
      ok: false,
      error: { details: { reason: 'foreignPath' } },
    });
    expect(server.connections()).toBe(0);
  });

  it('ответ 302 не приводит к запросу по новому адресу', async () => {
    const target = await startLoopbackServer({ tls: true }, respond(200, 'секрет'));
    const server = await startLoopbackServer(
      { tls: true },
      respond(302, '', { Location: `https://127.0.0.1:${target.port}/eSCL/ScannerStatus` }),
    );

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
    });

    expect(result.ok && result.value.status).toBe(302);
    expect(result.ok && text(result.value.body)).toBe('');
    expect(server.requests).toHaveLength(1);
    expect(target.connections()).toBe(0);
  });

  it('ответы 301, 307 и 308 тоже не исполняются — и на POST', async () => {
    for (const status of [301, 307, 308]) {
      const server = await startLoopbackServer(
        { tls: true },
        respond(status, '', { Location: '/eSCL/Elsewhere' }),
      );

      const result = await transportFor(server).request({
        method: 'POST',
        path: '/eSCL/ScanJobs',
        body: '<x/>',
      });

      expect(result.ok && result.value.status, String(status)).toBe(status);
      expect(server.requests, String(status)).toEqual(['POST /eSCL/ScanJobs']);
    }
  });
});

describe('транспорт: отпечаток сертификата', () => {
  it('запомненный отпечаток совпал — запрос проходит', async () => {
    const server = await startLoopbackServer({ tls: true }, respond(200, STATUS_XML));
    const transport = transportFor(server, { fingerprint: server.cert?.fingerprint ?? null });

    const result = await transport.request({ method: 'GET', path: '/eSCL/ScannerStatus' });

    expect(result.ok && result.value.status).toBe(200);
  });

  it('сменившийся сертификат на том же origin отклоняется до отправки запроса', async () => {
    const original = await startLoopbackServer({ tls: true }, respond(200, STATUS_XML));
    const remembered = original.cert?.fingerprint ?? null;
    await original.close();
    // Другое устройство на том же адресе и порту: свой ключ, свой сертификат.
    const impostor = await startLoopbackServer(
      { tls: true, port: original.port },
      respond(200, STATUS_XML),
    );

    const result = await transportFor(impostor, { fingerprint: remembered }).request({
      method: 'POST',
      path: '/eSCL/ScanJobs',
      body: '<scan:ScanSettings/>',
    });

    expect(result).toEqual({ ok: false, error: { code: 'scannerCertificateChanged' } });
    expect(impostor.connections()).toBe(1);
    expect(impostor.requests).toEqual([]);
  });

  it('сверка идёт на каждом соединении, а не один раз на транспорт', async () => {
    const original = await startLoopbackServer({ tls: true }, respond(200, STATUS_XML));
    const transport = transportFor(original, { fingerprint: original.cert?.fingerprint ?? null });
    expect((await transport.request({ method: 'GET', path: '/eSCL/ScannerStatus' })).ok).toBe(true);

    await original.close();
    const impostor = await startLoopbackServer(
      { tls: true, port: original.port },
      respond(200, STATUS_XML),
    );

    expect(await transport.request({ method: 'GET', path: '/eSCL/ScannerStatus' })).toEqual({
      ok: false,
      error: { code: 'scannerCertificateChanged' },
    });
    expect(impostor.requests).toEqual([]);
  });

  it('тот же сертификат на новом сервере принимается', async () => {
    const cert = createSelfSignedCert();
    const first = await startLoopbackServer({ tls: true, cert }, respond(200, STATUS_XML));
    await first.close();
    const second = await startLoopbackServer(
      { tls: true, cert, port: first.port },
      respond(200, STATUS_XML),
    );

    const result = await transportFor(second, { fingerprint: cert.fingerprint }).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
    });

    expect(result.ok).toBe(true);
  });
});

describe('транспорт: потолок размера ответа', () => {
  const tooLarge = {
    ok: false,
    error: { code: 'scannerBadResponse', details: { reason: 'tooLarge' } },
  };

  it('потолок держится при chunked-ответе', async () => {
    const server = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.writeHead(200);
      for (let index = 0; index < 64; index += 1) {
        response.write('x'.repeat(1024));
      }
      response.end();
    });

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerCapabilities',
      maxBytes: 4096,
    });

    expect(result).toEqual(tooLarge);
  });

  it('заявленный Content-Length больше потолка — отказ до чтения тела', async () => {
    const server = await startLoopbackServer(
      { tls: true },
      rawResponse(`HTTP/1.1 200 OK\r\nContent-Length: 5000000\r\n\r\n${'x'.repeat(100)}`),
    );

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerCapabilities',
      maxBytes: 4096,
    });

    expect(result).toEqual(tooLarge);
  });

  it('лживый Content-Length: тела приходит больше заявленного — лишнее не принимается', async () => {
    const server = await startLoopbackServer(
      { tls: true },
      rawResponse(`HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n${'x'.repeat(200_000)}`),
    );

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerCapabilities',
      maxBytes: 4096,
    });

    // Допустимы оба исхода: тело обрезано по заявленной длине или ответ отклонён целиком.
    if (result.ok) {
      expect(result.value.body.byteLength).toBeLessThanOrEqual(10);
    } else {
      expect(result.error.code).toBe('scannerBadResponse');
    }
  });

  it('ответ ровно на потолке принимается', async () => {
    const server = await startLoopbackServer({ tls: true }, respond(200, 'x'.repeat(4096)));

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerCapabilities',
      maxBytes: 4096,
    });

    expect(result.ok && result.value.body.byteLength).toBe(4096);
  });
});

describe('транспорт: отказы соединения, таймауты, отмена', () => {
  const unreachable = (reason: string) => ({
    ok: false,
    error: { code: 'scannerUnreachable', details: { reason } },
  });

  it('порт закрыт — «сканер не отвечает», причина «отказ соединения»', async () => {
    const server = await startLoopbackServer({ tls: true }, respond(200));
    await server.close();

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
    });

    expect(result).toEqual(unreachable('refused'));
  });

  it('HTTPS-профиль к серверу на HTTP — причина «рукопожатие», а не таймаут', async () => {
    const server = await startLoopbackServer({ tls: false }, respond(200));

    const result = await transportFor({ ...server, cert: createSelfSignedCert() }).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
    });

    expect(result).toEqual(unreachable('tls'));
  });

  it('рукопожатие, которое не завершается, обрывается таймаутом соединения', async () => {
    const sockets: net.Socket[] = [];
    const silent = net.createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => {
      for (const socket of sockets) {
        socket.destroy();
      }
      silent.close();
    });
    const { port } = silent.address() as net.AddressInfo;

    const result = await transportFor({
      host: '127.0.0.1',
      port,
      cert: createSelfSignedCert(),
    }).request({ method: 'GET', path: '/eSCL/ScannerStatus', connectTimeoutMs: 150 });

    expect(result).toEqual(unreachable('timeout'));
  });

  it('сервер молчит после запроса — таймаут тишины', async () => {
    const server = await startLoopbackServer({ tls: true }, () => undefined);

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
      idleTimeoutMs: 150,
    });

    expect(result).toEqual(unreachable('timeout'));
    expect(server.requests).toHaveLength(1);
  });

  it('соединение, закрытое без ответа, — «обрыв»', async () => {
    const server = await startLoopbackServer({ tls: true }, (request) => {
      request.socket.destroy();
    });

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
    });

    expect(result).toEqual(unreachable('reset'));
  });

  it('ответ, оборванный посреди тела, — отказ, а не усечённое тело', async () => {
    const server = await startLoopbackServer(
      { tls: true },
      rawResponse('HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nкусок'),
    );

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
    });

    expect(result).toEqual(unreachable('reset'));
  });

  it('не HTTP в ответ — «ответ не разобран»', async () => {
    const server = await startLoopbackServer({ tls: true }, rawResponse('SSH-2.0-OpenSSH\r\n'));

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'scannerBadResponse', details: { reason: 'http' } },
    });
  });

  it('сигнал, отменённый заранее, — отказ без обращения к сети', async () => {
    const server = await startLoopbackServer({ tls: true }, respond(200));

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
      signal: AbortSignal.abort(),
    });

    expect(result).toEqual({ ok: false, error: { code: 'canceled' } });
    expect(server.connections()).toBe(0);
  });

  it('отмена во время ожидания ответа обрывает запрос', async () => {
    const controller = new AbortController();
    const server = await startLoopbackServer({ tls: true }, () => {
      controller.abort();
    });

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: false, error: { code: 'canceled' } });
  });
});

describe('транспорт: страница потоком', () => {
  const PAGE = Buffer.from(Array.from({ length: 50_000 }, (_value, index) => index % 251));

  const pageInChunks = (_request: unknown, response: ServerResponse): void => {
    response.writeHead(200, { 'Content-Type': 'image/jpeg' });
    for (let offset = 0; offset < PAGE.byteLength; offset += 8192) {
      response.write(PAGE.subarray(offset, offset + 8192));
    }
    response.end();
  };

  it('тело 200 отдаётся потоком и приходит байт в байт', async () => {
    const server = await startLoopbackServer({ tls: true }, pageInChunks);

    const result = await transportFor(server).stream({
      method: 'GET',
      path: '/eSCL/ScanJobs/abc/NextDocument',
      maxBytes: 1_000_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe(200);
      expect(result.value.contentType).toBe('image/jpeg');
      expect(Buffer.from(await collect(result.value.body)).equals(PAGE)).toBe(true);
    }
  });

  it.each([404, 410, 503])('статус %d — тела нет, соединение закрыто', async (status) => {
    const server = await startLoopbackServer(
      { tls: true },
      respond(status, 'не страница', { 'Retry-After': '20' }),
    );

    const result = await transportFor(server).stream({
      method: 'GET',
      path: '/eSCL/ScanJobs/abc/NextDocument',
      maxBytes: 1_000_000,
    });

    expect(result.ok && result.value.status).toBe(status);
    expect(result.ok && result.value.body).toBeNull();
  });

  it('страница больше потолка обрывается на сосчитанных байтах', async () => {
    const server = await startLoopbackServer({ tls: true }, pageInChunks);

    const result = await transportFor(server).stream({
      method: 'GET',
      path: '/eSCL/ScanJobs/abc/NextDocument',
      maxBytes: 20_000,
    });

    expect(result.ok).toBe(true);
    const failure = await collect(result.ok ? result.value.body : null).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).failure).toEqual({
      code: 'scannerBadResponse',
      details: { reason: 'tooLarge' },
    });
  });

  it('соединение, оборванное посреди страницы, бросает ошибку транспорта', async () => {
    const server = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.writeHead(200);
      response.write(PAGE.subarray(0, 8192), () => {
        response.socket?.destroy();
      });
    });

    const result = await transportFor(server).stream({
      method: 'GET',
      path: '/eSCL/ScanJobs/abc/NextDocument',
      maxBytes: 1_000_000,
    });

    const failure = await collect(result.ok ? result.value.body : null).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).failure.code).toBe('scannerUnreachable');
  });

  it('тишина посреди страницы — таймаут тишины', async () => {
    const server = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.writeHead(200);
      response.write(PAGE.subarray(0, 8192));
    });

    const result = await transportFor(server).stream({
      method: 'GET',
      path: '/eSCL/ScanJobs/abc/NextDocument',
      maxBytes: 1_000_000,
      idleTimeoutMs: 150,
    });

    const failure = await collect(result.ok ? result.value.body : null).catch(
      (error: unknown) => error,
    );
    expect((failure as TransportError).failure).toEqual({
      code: 'scannerUnreachable',
      details: { reason: 'timeout' },
    });
  });

  it('общий срок приёма обрывает страницу, которая идёт без пауз, но слишком долго', async () => {
    const server = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.writeHead(200);
      const drip = setInterval(() => {
        response.write('x');
      }, 20);
      response.on('close', () => {
        clearInterval(drip);
      });
    });

    const result = await transportFor(server).stream({
      method: 'GET',
      path: '/eSCL/ScanJobs/abc/NextDocument',
      maxBytes: 1_000_000,
      idleTimeoutMs: 5000,
      deadlineMs: 300,
    });

    const failure = await collect(result.ok ? result.value.body : null).catch(
      (error: unknown) => error,
    );
    expect((failure as TransportError).failure).toEqual({
      code: 'scannerUnreachable',
      details: { reason: 'timeout' },
    });
  });

  it('отмена посреди страницы обрывает поток', async () => {
    const controller = new AbortController();
    const server = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.writeHead(200);
      response.write(PAGE.subarray(0, 8192));
    });

    const result = await transportFor(server).stream({
      method: 'GET',
      path: '/eSCL/ScanJobs/abc/NextDocument',
      maxBytes: 1_000_000,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 50);

    const failure = await collect(result.ok ? result.value.body : null).catch(
      (error: unknown) => error,
    );
    expect((failure as TransportError).failure).toEqual({ code: 'canceled' });
  });

  it('читатель, бросивший поток, закрывает соединение', async () => {
    let closed = false;
    const server = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.writeHead(200);
      response.write(PAGE.subarray(0, 8192));
      response.on('close', () => {
        closed = true;
      });
    });

    const result = await transportFor(server).stream({
      method: 'GET',
      path: '/eSCL/ScanJobs/abc/NextDocument',
      maxBytes: 1_000_000,
    });
    for await (const chunk of (result.ok ? result.value.body : null) ?? []) {
      expect(chunk.byteLength).toBeGreaterThan(0);
      break;
    }

    await expect.poll(() => closed).toBe(true);
  });
});
