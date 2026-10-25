import * as net from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  createConnector,
  parseScannerAddress,
  type ScannerAddress,
} from '../../src/core/escl/connect';
import type { DomainError, Result } from '../../src/shared';
import { startTestEmulator } from '../support/emulator';
import { startLoopbackServer } from '../support/loopback-server';

// Подключение по адресу на настоящей сети loopback (план M1, U11): эмулятор сканера, закрытый
// порт, молчащий сервер и сервер, который не сканер. Каждый код отказа воспроизводится своим
// сценарием.

function address(input: string): ScannerAddress {
  const parsed = parseScannerAddress(input);
  if (!parsed.ok) {
    throw new Error(`адрес не разобран: ${input}`);
  }
  return parsed.value;
}

const errorOf = (result: Result<unknown>): DomainError | null => (result.ok ? null : result.error);

/** Порт, на котором никто не слушает: соединение будет отклонено. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return port;
}

/** Сервер, который принимает соединение и молчит. */
async function silentPort(): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close();
  });
  return (server.address() as net.AddressInfo).port;
}

describe('подключение против эмулятора', () => {
  it('адрес эмулятора даёт профиль с вариантами из фикстуры и отпечатком', async () => {
    const emulator = await startTestEmulator();

    const result = await createConnector().connect(address(`https://127.0.0.1:${emulator.port}`));

    expect(errorOf(result)).toBeNull();
    if (result.ok) {
      expect(result.value.profile).toEqual({
        scheme: 'https',
        host: '127.0.0.1',
        port: emulator.port,
        basePath: '/eSCL',
        fingerprint: emulator.fingerprint,
      });
      expect(result.value.options).toEqual({
        colorModes: ['Grayscale8', 'RGB24'],
        resolutions: [100, 200, 300, 600],
        paperSizes: ['A4', 'Letter'],
      });
      expect(result.value.capabilities.makeAndModel).toContain('ET-3850');
    }
    expect(emulator.requests()).toEqual(['GET /eSCL/ScannerCapabilities 200']);
  });

  it('адрес без схемы находит HTTPS-эмулятор с первой попытки', async () => {
    const emulator = await startTestEmulator();

    const result = await createConnector().connect(address(`127.0.0.1:${emulator.port}`));

    expect(result.ok && result.value.profile.scheme).toBe('https');
  });

  it('адрес без схемы подключается к HTTP-эмулятору после отказа HTTPS', async () => {
    const emulator = await startTestEmulator({ http: true });

    const result = await createConnector().connect(address(`127.0.0.1:${emulator.port}`));

    expect(errorOf(result)).toBeNull();
    // Выбранная схема записана в профиль; отпечатка у профиля на HTTP нет.
    expect(result.ok && result.value.profile.scheme).toBe('http');
    expect(result.ok && result.value.profile.port).toBe(emulator.port);
    expect(result.ok && result.value.profile.fingerprint).toBeNull();
  });

  it('явная схема https к HTTP-эмулятору не повторяется по HTTP', async () => {
    const emulator = await startTestEmulator({ http: true });

    const result = await createConnector().connect(address(`https://127.0.0.1:${emulator.port}`));

    expect(errorOf(result)).toEqual({ code: 'scannerUnreachable', details: { reason: 'tls' } });
    expect(emulator.requests()).toEqual([]);
  });

  it('устройство без автоподачи отклоняется и не становится профилем', async () => {
    const emulator = await startTestEmulator({ scenario: { device: 'no-adf' } });

    const result = await createConnector().connect(address(`127.0.0.1:${emulator.port}`));

    expect(errorOf(result)).toEqual({ code: 'scannerNoAdf' });
  });

  it('capabilities занят дважды — подключение пережидает и проходит (M5, KTD6)', async () => {
    const emulator = await startTestEmulator({ scenario: { busyCapabilities: 2 } });

    // Пауза укорочена: ожидание идёт на настоящих часах, проверяется его ход, а не длительность.
    const result = await createConnector({ busyWait: { retryDelayMs: 20 } }).connect(
      address(`127.0.0.1:${emulator.port}`),
    );

    expect(errorOf(result)).toBeNull();
    expect(result.ok && result.value.profile.scheme).toBe('https');
    expect(emulator.requests()).toEqual([
      'GET /eSCL/ScannerCapabilities 503',
      'GET /eSCL/ScannerCapabilities 503',
      'GET /eSCL/ScannerCapabilities 200',
    ]);
  });

  it('базовый путь не тот — «не сканер eSCL»', async () => {
    const emulator = await startTestEmulator();

    const result = await createConnector().connect(
      address(`https://127.0.0.1:${emulator.port}/other`),
    );

    expect(errorOf(result)).toEqual({ code: 'notEsclScanner', details: { status: 404 } });
  });
});

describe('подключение: отказы сети', () => {
  it('закрытый порт: соединение отклонено — и по HTTPS, и по HTTP', async () => {
    const port = await closedPort();

    const explicit = await createConnector().connect(address(`https://127.0.0.1:${port}`));
    const fallback = await createConnector().connect(address(`127.0.0.1:${port}`));

    const refused = { code: 'scannerUnreachable', details: { reason: 'refused' } };
    expect(errorOf(explicit)).toEqual(refused);
    expect(errorOf(fallback)).toEqual(refused);
  });

  it('молчащий адрес: нет ответа, перехода на HTTP нет', async () => {
    const port = await silentPort();

    const result = await createConnector({ limits: { connectTimeoutMs: 150 } }).connect(
      address(`127.0.0.1:${port}`),
    );

    expect(errorOf(result)).toEqual({ code: 'scannerUnreachable', details: { reason: 'timeout' } });
  });

  it('по адресу отвечает не сканер: страница HTML', async () => {
    const server = await startLoopbackServer({ tls: true }, (_request, response) => {
      response
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<!DOCTYPE html><html><body>Router</body></html>');
    });

    const result = await createConnector().connect(address(`127.0.0.1:${server.port}`));

    expect(errorOf(result)).toEqual({ code: 'notEsclScanner' });
    // HTTPS ответил — по HTTP никто не ходил.
    expect(server.requests).toEqual(['GET /eSCL/ScannerCapabilities']);
  });

  it('второе подключение отменяет первое, зависшее на молчащем адресе', async () => {
    const silent = await silentPort();
    const emulator = await startTestEmulator();
    const connector = createConnector();

    const first = connector.connect(address(`https://127.0.0.1:${silent}`));
    const second = connector.connect(address(`https://127.0.0.1:${emulator.port}`));

    expect(errorOf(await first)).toEqual({ code: 'canceled' });
    expect(errorOf(await second)).toBeNull();
  });
});
