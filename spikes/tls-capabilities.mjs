// Спайк M0, критерий 2 ADR 0003: HTTPS к сканеру с самоподписанным сертификатом проходит
// через ВЫДЕЛЕННЫЙ агент, а всё остальное в том же процессе по-прежнему отклоняет плохие
// сертификаты. Одноразовый код: не рефакторится, тестами не покрывается.
//
// Запуск под Node:      node spikes/tls-capabilities.mjs <адрес сканера>
// Запуск под Electron:  см. spikes/tls-electron-main.cjs
//
// Адрес приходит аргументом или из DUPLEXNT_SCANNER_HOST — в файле его нет. Сырые ответы и
// полный отчёт пишутся в local-test-data/device/ (вне git); в stdout — только то, что не
// идентифицирует устройство.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OPENSSL_CANDIDATES = [
  'C:/Program Files/Git/usr/bin/openssl.exe',
  'C:/Program Files/Git/mingw64/bin/openssl.exe',
];
const RAW_DIR = resolve('local-test-data/device');

// --- Инвариант KTD-20: агент приватен, цепляется только к origin профиля ---------------------

function createScannerTransport(origin) {
  // Единственное место ослабления. Наружу агент не уходит — только функция запроса.
  const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
  const profile = new URL(origin);

  return function requestScanner(url) {
    const target = new URL(url);
    if (target.protocol !== profile.protocol || target.host !== profile.host) {
      return Promise.reject(
        new Error('ORIGIN_MISMATCH: агент сканера не обслуживает чужой origin'),
      );
    }
    return get(target, agent);
  };
}

function get(url, agent) {
  return new Promise((resolvePromise, reject) => {
    const request = https.get(url, { agent, timeout: 15000 }, (response) => {
      const socket = response.socket;
      const tls = { protocol: socket.getProtocol?.(), cipher: socket.getCipher?.().name };
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolvePromise({
          status: response.statusCode,
          location: response.headers.location,
          tls,
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.on('timeout', () => request.destroy(new Error('TIMEOUT')));
    request.on('error', reject);
  });
}

// --- Локальный сервер с плохим сертификатом --------------------------------------------------

function makeBadCertificate() {
  const openssl = OPENSSL_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!openssl) throw new Error('openssl из поставки Git for Windows не найден');
  const dir = mkdtempSync(join(tmpdir(), 'duplexnt-spike-'));
  try {
    execFileSync(
      openssl,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=bad.invalid',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' } },
    );
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } finally {
    // Ключ живёт только в памяти процесса: на диске и в git его нет.
    rmSync(dir, { recursive: true, force: true });
  }
}

function startBadServer() {
  const server = https.createServer(makeBadCertificate(), (_request, response) => {
    response.end('плохой сервер ответил — этого не должно было случиться');
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({ server, url: `https://127.0.0.1:${server.address().port}/` });
    });
  });
}

// --- Негативные проверки: каждая ОБЯЗАНА кончиться отказом -----------------------------------

const errorCode = (error) =>
  error?.code ?? error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error);

async function mustReject(label, attempt) {
  try {
    await attempt();
    return { label, rejected: false, detail: 'ЗАПРОС ПРОШЁЛ — изоляция нарушена' };
  } catch (error) {
    return { label, rejected: true, detail: errorCode(error) };
  }
}

export async function run({ host, electronNet } = {}) {
  if (!host) throw new Error('Нужен адрес сканера: аргументом или в DUPLEXNT_SCANNER_HOST');
  const runtime = process.versions.electron ? 'electron' : 'node';
  const origin = `https://${host}`;
  const requestScanner = createScannerTransport(origin);
  mkdirSync(RAW_DIR, { recursive: true });

  // 1. Позитив: capabilities и status через выделенный агент.
  const capabilities = await requestScanner(`${origin}/eSCL/ScannerCapabilities`);
  const status = await requestScanner(`${origin}/eSCL/ScannerStatus`);
  writeFileSync(join(RAW_DIR, 'ScannerCapabilities.xml'), capabilities.body);
  writeFileSync(join(RAW_DIR, 'ScannerStatus.xml'), status.body);

  // 2. Негатив — в ТОМ ЖЕ процессе, после успешного запроса к сканеру.
  const bad = await startBadServer();
  const checks = [];
  try {
    checks.push(await mustReject('чужой хост / агент по умолчанию', () => get(new URL(bad.url))));
    checks.push(await mustReject('чужой хост / глобальный fetch', () => fetch(bad.url)));
    checks.push(
      await mustReject('чужой хост / транспорт сканера (origin)', () => requestScanner(bad.url)),
    );
    checks.push(
      await mustReject('сам сканер / агент по умолчанию', () =>
        get(new URL(`${origin}/eSCL/ScannerStatus`)),
      ),
    );
    checks.push(
      await mustReject('сам сканер / глобальный fetch', () =>
        fetch(`${origin}/eSCL/ScannerStatus`),
      ),
    );
    if (electronNet) {
      checks.push(
        await mustReject('чужой хост / сетевой стек Chromium', () => electronNet.fetch(bad.url)),
      );
      checks.push(
        await mustReject('сам сканер / сетевой стек Chromium', () =>
          electronNet.fetch(`${origin}/eSCL/ScannerStatus`),
        ),
      );
    }
  } finally {
    bad.server.close();
  }

  // 3. После негативов выделенный агент всё ещё работает.
  const again = await requestScanner(`${origin}/eSCL/ScannerStatus`);

  const report = {
    runtime,
    versions: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      openssl: process.versions.openssl,
    },
    positive: {
      capabilities: { status: capabilities.status, bytes: capabilities.body.length },
      scannerStatus: { status: status.status, bytes: status.body.length },
      afterNegatives: again.status,
      tls: capabilities.tls,
    },
    negative: checks,
    passed:
      capabilities.status === 200 &&
      status.status === 200 &&
      again.status === 200 &&
      checks.every((check) => check.rejected),
  };
  writeFileSync(join(RAW_DIR, `tls-report-${runtime}.json`), JSON.stringify(report, null, 2));
  return report;
}

// Прямой запуск под Node.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const report = await run({ host: process.argv[2] ?? process.env.DUPLEXNT_SCANNER_HOST });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
