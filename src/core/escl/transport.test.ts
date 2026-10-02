import { getEventListeners } from 'node:events';
import * as net from 'node:net';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, onTestFinished } from 'vitest';
import { startLoopbackServer, type LoopbackServer } from '../../../test/support/loopback-server';
import { createSelfSignedCert } from '../../../test/support/self-signed-cert';
import {
  createTransport,
  TRANSPORT_DEFAULTS,
  TransportError,
  type ResponseHead,
  type ScannerProfile,
  type ScannerTransport,
} from './transport';

const STATUS_XML = '<?xml version="1.0"?><status>Idle</status>';

// Пределы страницы: у потокового запроса умолчаний нет.
const PAGE_LIMITS = { maxBytes: 1_000_000, idleTimeoutMs: 5000, deadlineMs: 10_000 };

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
    expect(
      await transport.stream({ method: 'GET', path, ...PAGE_LIMITS }, () => Promise.resolve(1)),
    ).toMatchObject({ ok: false, error: { details: { reason: 'foreignPath' } } });
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

  it('лживый Content-Length: тела приходит больше заявленного — принято ровно заявленное', async () => {
    const server = await startLoopbackServer(
      { tls: true },
      rawResponse(`HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n${'x'.repeat(200_000)}`),
    );

    const result = await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerCapabilities',
      maxBytes: 4096,
    });

    // Разборщик HTTP отдаёт ровно заявленные десять байт; остальное до вызывающего не доходит.
    // Сам потолок по сосчитанным байтам доказывает тест с chunked-ответом выше.
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.body.byteLength).toBe(10);
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

describe('транспорт: возобновление сессии TLS', () => {
  it('несколько запросов подряд через транспорт с запомненным отпечатком проходят', async () => {
    const server = await startLoopbackServer({ tls: true }, respond(200, STATUS_XML));
    const transport = transportFor(server, { fingerprint: server.cert?.fingerprint ?? null });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await transport.request({ method: 'GET', path: '/eSCL/ScannerStatus' });

      expect(result.ok, `запрос ${attempt}`).toBe(true);
      expect(result.ok && result.value.fingerprint, `запрос ${attempt}`).toBe(
        server.cert?.fingerprint,
      );
    }
    expect(server.requests).toHaveLength(4);
  });

  it('без запомненного отпечатка каждый ответ несёт один и тот же отпечаток', async () => {
    const server = await startLoopbackServer({ tls: true }, respond(200, STATUS_XML));
    const transport = transportFor(server);

    const fingerprints: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await transport.request({ method: 'GET', path: '/eSCL/ScannerStatus' });
      fingerprints.push(result.ok ? result.value.fingerprint : result.error);
    }

    expect(fingerprints).toEqual(Array(3).fill(server.cert?.fingerprint));
  });

  it('подмена после возобновлённых соединений отклоняется, вернувшийся сканер принимается', async () => {
    const cert = createSelfSignedCert();
    const genuine = await startLoopbackServer({ tls: true, cert }, respond(200, STATUS_XML));
    const transport = transportFor(genuine, { fingerprint: cert.fingerprint });
    const get = () => transport.request({ method: 'GET', path: '/eSCL/ScannerStatus' });
    expect((await get()).ok).toBe(true);
    expect((await get()).ok).toBe(true);

    await genuine.close();
    const impostor = await startLoopbackServer(
      { tls: true, port: genuine.port },
      respond(200, STATUS_XML),
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await get()).toEqual({ ok: false, error: { code: 'scannerCertificateChanged' } });
    }
    expect(impostor.requests).toEqual([]);

    await impostor.close();
    const returned = await startLoopbackServer(
      { tls: true, cert, port: genuine.port },
      respond(200, STATUS_XML),
    );
    expect((await get()).ok).toBe(true);
    expect((await get()).ok).toBe(true);
    expect(returned.requests).toHaveLength(2);
  });

  it('первое подключение к подменному устройству не отравляет следующее', async () => {
    // Отпечаток не совпал — сессия этого соединения не запоминается и следующему не предлагается.
    const cert = createSelfSignedCert();
    const impostor = await startLoopbackServer({ tls: true }, respond(200, STATUS_XML));
    const transport = transportFor(impostor, { fingerprint: cert.fingerprint });
    const get = () => transport.request({ method: 'GET', path: '/eSCL/ScannerStatus' });

    expect(await get()).toEqual({ ok: false, error: { code: 'scannerCertificateChanged' } });
    expect(await get()).toEqual({ ok: false, error: { code: 'scannerCertificateChanged' } });
    expect(impostor.requests).toEqual([]);
  });
});

describe('транспорт: обмен, который не кончается сам', () => {
  const timeout = {
    ok: false,
    error: { code: 'scannerUnreachable', details: { reason: 'timeout' } },
  };

  it('ответ 101 Switching Protocols — отказ, а не вечное ожидание', async () => {
    const server = await startLoopbackServer(
      { tls: true },
      rawResponse('HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n'),
    );
    const transport = transportFor(server);
    const failure = {
      ok: false,
      error: { code: 'scannerBadResponse', details: { reason: 'http' } },
    };

    expect(await transport.request({ method: 'GET', path: '/eSCL/ScannerStatus' })).toEqual(
      failure,
    );
    expect(
      await transport.stream(
        { method: 'GET', path: '/eSCL/ScanJobs/abc/NextDocument', ...PAGE_LIMITS },
        () => Promise.resolve('не должно дойти'),
      ),
    ).toEqual(failure);
  });

  it('ответ, который цедят по байту, обрывается сроком запроса по умолчанию', async () => {
    const server = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.writeHead(200);
      const drip = setInterval(() => {
        response.write('x');
      }, 20);
      response.on('close', () => {
        clearInterval(drip);
      });
    });
    // Срок по умолчанию — 10 с; тест сжимает его, не передавая срок в сам запрос.
    const transport = createTransport(
      {
        scheme: 'https',
        host: server.host,
        port: server.port,
        basePath: '/eSCL',
        fingerprint: null,
      },
      { requestDeadlineMs: 300 },
    );
    onTestFinished(() => {
      transport.close();
    });

    const result = await transport.request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
      idleTimeoutMs: 5000,
    });

    expect(result).toEqual(timeout);
  });

  it('срок по умолчанию у запроса с телом в памяти задан и конечен', () => {
    expect(TRANSPORT_DEFAULTS.requestDeadlineMs).toBe(10_000);
  });
});

describe('транспорт: страница потоком', () => {
  const PAGE = Buffer.from(Array.from({ length: 50_000 }, (_value, index) => index % 251));
  const PAGE_PATH = '/eSCL/ScanJobs/abc/NextDocument';

  const pageInChunks = (_request: unknown, response: ServerResponse): void => {
    response.writeHead(200, { 'Content-Type': 'image/jpeg' });
    for (let offset = 0; offset < PAGE.byteLength; offset += 8192) {
      response.write(PAGE.subarray(offset, offset + 8192));
    }
    response.end();
  };
  const firstChunkThenSilence = (_request: unknown, response: ServerResponse): void => {
    response.writeHead(200);
    response.write(PAGE.subarray(0, 8192));
  };

  // Получатель страницы, какой будет у задания: читает тело целиком.
  const readAll = async (
    head: ResponseHead,
    body: AsyncIterable<Uint8Array> | null,
  ): Promise<{ head: ResponseHead; bytes: Uint8Array | null }> => ({
    head,
    bytes: body === null ? null : await collect(body),
  });

  it('тело 200 отдаётся получателю потоком и приходит байт в байт', async () => {
    const server = await startLoopbackServer({ tls: true }, pageInChunks);

    const result = await transportFor(server).stream(
      { method: 'GET', path: PAGE_PATH, ...PAGE_LIMITS },
      readAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.head.status).toBe(200);
      expect(result.value.head.contentType).toBe('image/jpeg');
      expect(result.value.head.fingerprint).toBe(server.cert?.fingerprint);
      expect(Buffer.from(result.value.bytes ?? []).equals(PAGE)).toBe(true);
    }
  });

  it.each([404, 410, 503])('статус %d — получатель вызван без тела', async (status) => {
    const server = await startLoopbackServer(
      { tls: true },
      respond(status, 'не страница', { 'Retry-After': '20' }),
    );

    const result = await transportFor(server).stream(
      { method: 'GET', path: PAGE_PATH, ...PAGE_LIMITS },
      readAll,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.head.status).toBe(status);
    expect(result.ok && result.value.bytes).toBeNull();
  });

  it('страница больше потолка обрывается на сосчитанных байтах', async () => {
    const server = await startLoopbackServer({ tls: true }, pageInChunks);

    const result = await transportFor(server).stream(
      { method: 'GET', path: PAGE_PATH, ...PAGE_LIMITS, maxBytes: 20_000 },
      readAll,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'scannerBadResponse', details: { reason: 'tooLarge' } },
    });
  });

  it('сбой чтения виден получателю как TransportError — он может убрать за собой', async () => {
    const server = await startLoopbackServer({ tls: true }, pageInChunks);
    let seen: unknown = null;

    const result = await transportFor(server).stream(
      { method: 'GET', path: PAGE_PATH, ...PAGE_LIMITS, maxBytes: 20_000 },
      async (_head, body) => {
        try {
          await collect(body);
        } catch (error) {
          seen = error;
          throw error;
        }
      },
    );

    expect(result.ok).toBe(false);
    expect(seen).toBeInstanceOf(TransportError);
    expect((seen as TransportError).failure.details).toEqual({ reason: 'tooLarge' });
  });

  it('соединение, оборванное посреди страницы, — «обрыв»', async () => {
    const server = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.writeHead(200);
      response.write(PAGE.subarray(0, 8192), () => {
        response.socket?.destroy();
      });
    });

    const result = await transportFor(server).stream(
      { method: 'GET', path: PAGE_PATH, ...PAGE_LIMITS },
      readAll,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'scannerUnreachable', details: { reason: 'reset' } },
    });
  });

  it('тишина посреди страницы — таймаут тишины', async () => {
    const server = await startLoopbackServer({ tls: true }, firstChunkThenSilence);

    const result = await transportFor(server).stream(
      { method: 'GET', path: PAGE_PATH, ...PAGE_LIMITS, idleTimeoutMs: 200 },
      readAll,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'scannerUnreachable', details: { reason: 'timeout' } },
    });
  });

  it('общий срок обрывает страницу, которая идёт без пауз, но слишком долго', async () => {
    const server = await startLoopbackServer({ tls: true }, (_request, response) => {
      response.writeHead(200);
      const drip = setInterval(() => {
        response.write('x');
      }, 20);
      response.on('close', () => {
        clearInterval(drip);
      });
    });

    const result = await transportFor(server).stream(
      { method: 'GET', path: PAGE_PATH, ...PAGE_LIMITS, deadlineMs: 1000 },
      readAll,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'scannerUnreachable', details: { reason: 'timeout' } },
    });
  });

  it('отмена посреди страницы обрывает поток', async () => {
    const controller = new AbortController();
    const server = await startLoopbackServer({ tls: true }, firstChunkThenSilence);

    const result = await transportFor(server).stream(
      { method: 'GET', path: PAGE_PATH, ...PAGE_LIMITS, signal: controller.signal },
      async (head, body) => {
        setTimeout(() => {
          controller.abort();
        }, 50);
        return readAll(head, body);
      },
    );

    expect(result).toEqual({ ok: false, error: { code: 'canceled' } });
  });

  it('получатель, упавший до чтения тела: ошибка проброшена, соединение и подписки сняты', async () => {
    let closed = false;
    const controller = new AbortController();
    const server = await startLoopbackServer({ tls: true }, (_request, response) => {
      firstChunkThenSilence(_request, response);
      response.on('close', () => {
        closed = true;
      });
    });
    // Так падает запись на диск, не открыв временный файл: до чтения тела дело не доходит.
    const diskFull = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });

    await expect(
      transportFor(server).stream(
        { method: 'GET', path: PAGE_PATH, ...PAGE_LIMITS, signal: controller.signal },
        () => Promise.reject(diskFull),
      ),
    ).rejects.toBe(diskFull);

    await expect.poll(() => closed).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('получатель, вернувший значение, не дочитав тело, закрывает соединение', async () => {
    let closed = false;
    const controller = new AbortController();
    const server = await startLoopbackServer({ tls: true }, (_request, response) => {
      firstChunkThenSilence(_request, response);
      response.on('close', () => {
        closed = true;
      });
    });

    const result = await transportFor(server).stream(
      { method: 'GET', path: PAGE_PATH, ...PAGE_LIMITS, signal: controller.signal },
      async (_head, body) => {
        for await (const chunk of body ?? []) {
          return chunk.byteLength;
        }
        return 0;
      },
    );

    expect(result.ok && result.value).toBeGreaterThan(0);
    await expect.poll(() => closed).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('после обычного запроса подписка на сигнал отмены снята', async () => {
    const controller = new AbortController();
    const server = await startLoopbackServer({ tls: true }, respond(200, STATUS_XML));

    await transportFor(server).request({
      method: 'GET',
      path: '/eSCL/ScannerStatus',
      signal: controller.signal,
    });

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
