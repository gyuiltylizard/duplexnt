import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { ET_3850, fixturePath, readFixture } from '../support/fixtures.ts';
import { createSelfSignedCert } from '../support/self-signed-cert.ts';
import { scenarioOf, type Scenario } from './scenarios.ts';

// Эмулятор сканера eSCL (план M1, U9): устройство для тестов и ручного смоука без бумаги.
// Говорит по настоящему HTTP(S) на loopback, отдаёт фикстуры репозитория и ведёт задание
// автоподачи так, как его ведёт ET-3850 (журнал M1, U1).
//
// Код приложения сюда не импортируется (KTD-4, держит lint): клиент проверяется против эмулятора,
// и общее у них — только фикстуры. Импорты — с расширением `.ts`: `npm run emulator` запускает
// файлы напрямую Node, без сборки.

const DEVICE_DIRS = {
  'et-3850': ET_3850,
  'no-adf': ['escl', 'no-adf'],
} as const;
const PAGES_DIR = [...ET_3850, 'pages'] as const;

const NS_SCAN = 'http://schemas.hp.com/imaging/escl/2011/05/03';
const NS_PWG = 'http://www.pwg.org/schemas/2010/12/sm';

// Разрешения автоподачи ET-3850. Чего устройство не берёт, на то отвечает `409` (журнал U1).
const ACCEPTED_RESOLUTIONS = new Set(['100', '200', '300', '600']);
const REQUEST_BODY_LIMIT = 64 * 1024;
const PAGE_CHUNK_BYTES = 16 * 1024;
const NOT_JPEG = Buffer.from('<html><body>Service Unavailable</body></html>', 'utf8');

type JobState = 'Processing' | 'Completed' | 'Canceled' | 'Aborted';

interface Job {
  readonly id: string;
  readonly path: string;
  state: JobState;
  imagesCompleted: number;
  /** Устройство считает возраст задания от последнего обращения к нему. */
  lastAccessAt: number;
  notReadyLeft: number;
  transferring: boolean;
  /** Остаток лотка этого задания — номера фикстур (M2, U4); `null` — общий лоток `sheets`. */
  trayLeft: number[] | null;
}

export interface EmulatorExchange {
  readonly method: string;
  readonly path: string;
  /** `null` — ответа не было: соединение закрыто или запрос оставлен висеть. */
  status: number | null;
}

export interface EmulatorJob {
  readonly path: string;
  readonly state: JobState;
  readonly imagesCompleted: number;
}

export interface EmulatorOptions {
  readonly scenario?: Partial<Scenario>;
  /** Порт; по умолчанию — случайный свободный. */
  readonly port?: number;
  /** HTTP вместо HTTPS — для проверки перехода на HTTP (KTD-8). */
  readonly http?: boolean;
  /** Вызывается, когда обмен закончен, — для журнала в консоли. */
  readonly onExchange?: (exchange: EmulatorExchange) => void;
}

export interface Emulator {
  readonly scheme: 'https' | 'http';
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly basePath: string;
  /** SHA-256 сертификата; `null` на HTTP. */
  readonly fingerprint: string | null;
  /** Все запросы по порядку поступления. */
  readonly exchanges: readonly EmulatorExchange[];
  /** Запросы строками «метод путь статус»; идентификатор задания заменён на `<job>`. */
  requests(): string[];
  /** Задания, новые первыми. */
  jobs(): EmulatorJob[];
  /** Тела `POST /ScanJobs` по порядку. */
  readonly receivedSettings: readonly string[];
  /** Новый сценарий на том же адресе и с тем же сертификатом: лоток, счётчики и задания — заново. */
  load(scenario?: Partial<Scenario>): void;
  /**
   * Перезарядка лотка (M2, U4): кладёт содержимое для следующего задания, НЕ сбрасывая ни
   * сценарий, ни список заданий — брошенные задания остаются видны. Только при `trays`.
   */
  reloadTray(tray: readonly number[]): void;
  /** «Бумагу вынули»: состояние замятия снято. */
  clearJam(): void;
  close(): Promise<void>;
}

// Страницы читаются с диска один раз на процесс: тесты поднимают эмулятор десятками.
let cachedPages: Buffer[] | null = null;

function pageFixtures(): Buffer[] {
  if (cachedPages !== null) {
    return cachedPages;
  }
  const names = readdirSync(fixturePath(...PAGES_DIR))
    .filter((name) => /^page-\d+\.jpg$/.test(name))
    .sort();
  if (names.length === 0) {
    throw new Error('страниц-фикстур нет: node scripts/generate-page-fixtures.ts');
  }
  cachedPages = names.map((name) => readFixture(...PAGES_DIR, name));
  return cachedPages;
}

export async function startEmulator(options: EmulatorOptions = {}): Promise<Emulator> {
  const basePath = '/eSCL';
  const collection = `${basePath}/ScanJobs`;
  const cert = options.http === true ? null : createSelfSignedCert();
  const scheme = cert === null ? 'http' : 'https';
  const pages = pageFixtures();

  let scenario = scenarioOf(options.scenario);
  let trayQueue = (scenario.trays ?? []).map((tray) => [...tray]);
  let sheetsUsed = 0;
  let faultFired = false;
  let busyPostsLeft = scenario.busyPosts;
  let busyUntil = 0;
  let jam = false;
  let jobs: Job[] = [];
  let closed = false;
  let port = 0;

  const exchanges: EmulatorExchange[] = [];
  const receivedSettings: string[] = [];
  const timers = new Map<NodeJS.Timeout, () => void>();

  // Пауза, которую закрытие эмулятора обрывает: обработчик не остаётся висеть на таймере.
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.set(timer, resolve);
    });

  // Брошенное задание устройство снимает само, когда к нему долго не обращались.
  function expire(): void {
    for (const job of jobs) {
      if (job.state === 'Processing' && Date.now() - job.lastAccessAt >= scenario.abandonAfterMs) {
        job.state = 'Aborted';
      }
    }
  }

  const runningJob = (): Job | undefined => jobs.find((job) => job.state === 'Processing');

  /** В лотке задания ещё есть листы: общий счётчик — в прежнем режиме, свой остаток — в trays. */
  const sheetsLeft = (job: Job): boolean =>
    job.trayLeft === null ? sheetsUsed < scenario.sheets : job.trayLeft.length > 0;

  function statusXml(): Buffer {
    expire();
    const running = runningJob();
    const loaded =
      scenario.trayReportsLoaded ??
      (scenario.trays === null
        ? sheetsUsed < scenario.sheets
        : (running?.trayLeft?.length ?? 0) > 0 || trayQueue.length > 0);
    let adfState = loaded ? 'ScannerAdfLoaded' : 'ScannerAdfEmpty';
    if (jam) {
      adfState = 'ScannerAdfJam';
    } else if (running?.transferring === true) {
      adfState = 'ScannerAdfProcessing';
    }
    // Устройство держит в статусе два последних задания.
    const jobInfos = jobs
      .slice(0, 2)
      .map(
        (job) =>
          '<scan:JobInfo>' +
          `<pwg:JobUuid>${job.id}</pwg:JobUuid>` +
          `<pwg:JobUri>${job.path}</pwg:JobUri>` +
          `<scan:Age>${Math.floor((Date.now() - job.lastAccessAt) / 1000)}</scan:Age>` +
          `<pwg:ImagesCompleted>${job.imagesCompleted}</pwg:ImagesCompleted>` +
          `<pwg:JobState>${job.state}</pwg:JobState>` +
          '</scan:JobInfo>',
      );
    return Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        `<scan:ScannerStatus xmlns:scan="${NS_SCAN}" xmlns:pwg="${NS_PWG}">` +
        '<pwg:Version>2.9</pwg:Version>' +
        `<pwg:State>${running !== undefined || jam ? 'Processing' : 'Idle'}</pwg:State>` +
        `<scan:AdfState>${adfState}</scan:AdfState>` +
        (jobInfos.length === 0 ? '' : `<scan:Jobs>${jobInfos.join('')}</scan:Jobs>`) +
        '</scan:ScannerStatus>',
      'utf8',
    );
  }

  function locationOf(job: Job): Record<string, string> {
    const values: Record<Scenario['location'], string | null> = {
      absolute: `${scheme}://127.0.0.1:${port}${job.path}`,
      path: job.path,
      relative: `ScanJobs/${job.id}`,
      'foreign-host': `https://203.0.113.7:443${job.path}`,
      'http-scheme': `http://127.0.0.1:${port}${job.path}`,
      outside: `/other/ScanJobs/${job.id}`,
      traversal: `${collection}/../ScanJobs/${job.id}`,
      missing: null,
    };
    const value = values[scenario.location];
    return value === null ? {} : { Location: value };
  }

  const settingsRejected = (body: string): boolean => {
    if (scenario.rejectSettings || scenario.device === 'no-adf') {
      return true;
    }
    const resolution = /<scan:XResolution>([^<]*)</.exec(body)?.[1];
    return (
      body.includes('<scan:ColorMode>BlackAndWhite1<') ||
      (resolution !== undefined && !ACCEPTED_RESOLUTIONS.has(resolution))
    );
  };

  async function readBody(request: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      if (size > REQUEST_BODY_LIMIT) {
        break;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const method = request.method ?? '';
    const path = (request.url ?? '').split('?')[0] ?? '';
    const exchange: EmulatorExchange = { method, path, status: null };
    exchanges.push(exchange);
    const { socket } = request;
    const { onExchange } = options;
    if (onExchange !== undefined) {
      socket.once('close', () => {
        onExchange(exchange);
      });
    }

    // Заголовки — в том виде, в каком их шлёт ET-3850: часть имён прописными, каждое соединение
    // закрывается после ответа.
    const empty = (status: number, headers: Record<string, string> = {}): void => {
      exchange.status = status;
      response.writeHead(status, { ...headers, 'CONTENT-LENGTH': '0', Connection: 'close' }).end();
    };
    const busy = (): void => {
      empty(503, { 'Accept-Range': 'none', 'CONTENT-TYPE': '', 'RETRY-AFTER': '20' });
    };
    const xml = (body: Buffer): void => {
      exchange.status = 200;
      response
        .writeHead(200, {
          'Accept-Range': 'none',
          'CONTENT-TYPE': 'text/xml;charset="utf-8"',
          'CONTENT-LENGTH': String(body.byteLength),
          Connection: 'close',
        })
        .end(body);
    };

    if (path === `${basePath}/ScannerCapabilities` && method === 'GET') {
      xml(readFixture(...DEVICE_DIRS[scenario.device], 'ScannerCapabilities.xml'));
      return;
    }
    if (path === `${basePath}/ScannerStatus` && method === 'GET') {
      xml(statusXml());
      return;
    }

    if (path === collection && method === 'POST') {
      const body = await readBody(request);
      receivedSettings.push(body);
      expire();
      if (busyPostsLeft > 0) {
        busyPostsLeft -= 1;
        busy();
        return;
      }
      // Очереди у устройства нет: пока задание идёт, новое получает отказ.
      if (Date.now() < busyUntil || runningJob() !== undefined) {
        busy();
        return;
      }
      if (settingsRejected(body)) {
        empty(409);
        return;
      }
      const id = randomUUID();
      const job: Job = {
        id,
        path: `${collection}/${id}`,
        state: 'Processing',
        imagesCompleted: 0,
        lastAccessAt: Date.now(),
        notReadyLeft: 0,
        transferring: false,
        // Задание забирает следующий лоток очереди; пустая очередь — пустой лоток.
        trayLeft: scenario.trays === null ? null : (trayQueue.shift() ?? []),
      };
      jobs.unshift(job);
      jam = false;
      empty(201, locationOf(job));
      return;
    }

    if (!path.startsWith(`${collection}/`)) {
      empty(404);
      return;
    }
    const [id, resource, ...rest] = path.slice(collection.length + 1).split('/');
    const job = jobs.find((it) => it.id === id);

    if (resource === undefined && method === 'DELETE') {
      if (scenario.deleteHangs) {
        return;
      }
      // `200` — только идущему заданию; завершённому, оборванному и неизвестному — `404`.
      if (job?.state !== 'Processing') {
        empty(404);
        return;
      }
      job.state = 'Canceled';
      busyUntil = Date.now() + scenario.busyAfterCancelMs;
      // Остаток пачки устройство прогоняет через тракт несканированным: лоток пустеет.
      if (job.trayLeft !== null) {
        job.trayLeft = [];
      } else if (Number.isFinite(scenario.sheets)) {
        sheetsUsed = scenario.sheets;
      }
      empty(200);
      return;
    }

    if (resource !== 'NextDocument' || rest.length > 0 || method !== 'GET') {
      empty(404);
      return;
    }
    if (job === undefined) {
      empty(404);
      return;
    }
    if (job.state === 'Canceled') {
      empty(410);
      return;
    }
    if (job.state !== 'Processing') {
      empty(404);
      return;
    }
    job.lastAccessAt = Date.now();
    if (job.notReadyLeft > 0) {
      job.notReadyLeft -= 1;
      busy();
      return;
    }

    // Счёт листов — сквозной через все задания: сбой сценария привязан к нему и в M2.
    const sheet = sheetsUsed + 1;
    if (!sheetsLeft(job)) {
      // После `404` задание закрывается само: `Completed`, а без единой страницы — `Aborted`.
      job.state = job.imagesCompleted > 0 ? 'Completed' : 'Aborted';
      empty(404);
      return;
    }

    const fault = !faultFired && scenario.fault?.sheet === sheet ? scenario.fault.kind : null;
    if (fault !== null) {
      faultFired = true;
    }
    // Сбой подачи: лист остаётся в лотке, задание оборвано, статус показывает замятие.
    if (fault === 'gone' || fault === 'reset-before-headers') {
      job.state = 'Aborted';
      jam = true;
      if (fault === 'gone') {
        empty(410);
      } else {
        socket.destroy();
      }
      return;
    }

    const alive = (): boolean => !closed && !socket.destroyed && job.state === 'Processing';
    const write = (chunk: Uint8Array): Promise<void> =>
      new Promise((resolve) => {
        if (response.write(chunk)) {
          resolve();
          return;
        }
        // Соединение могло закрыться, пока буфер полон: `drain` тогда не придёт.
        const done = (): void => {
          response.off('drain', done);
          socket.off('close', done);
          resolve();
        };
        // Соединение уже закрыто — ни `drain`, ни `close` больше не придут.
        if (socket.destroyed) {
          resolve();
          return;
        }
        response.once('drain', done);
        socket.once('close', done);
      });

    // Лист считается поданным; из лотка задания уходит очередная фикстура (M2, U4).
    const fixtureNumber = job.trayLeft === null ? sheet : (job.trayLeft.shift() ?? sheet);
    sheetsUsed += 1;
    job.transferring = true;
    try {
      if (scenario.pageDelayMs > 0) {
        await pause(scenario.pageDelayMs);
        if (!alive()) {
          socket.destroy();
          return;
        }
      }

      const body = pages[(fixtureNumber - 1) % pages.length] ?? Buffer.alloc(0);
      const half = body.subarray(0, Math.floor(body.byteLength / 2));
      const chunkedHead = (): void => {
        exchange.status = 200;
        response.writeHead(200, {
          'Accept-Range': 'none',
          'Content-Location': `${job.path}/file-${job.imagesCompleted + 1}`,
          'CONTENT-TYPE': 'image/jpeg',
          'TRANSFER-ENCODING': 'CHUNKED',
          Connection: 'close',
        });
      };
      // Ответ мимо HTTP-сервера Node: только так можно соврать в длине или обрамить тело
      // закрытием соединения.
      const raw = (headers: string[], content: Uint8Array): void => {
        exchange.status = 200;
        socket.write(
          ['HTTP/1.1 200 OK', 'CONTENT-TYPE: image/jpeg', ...headers, 'Connection: close']
            .join('\r\n')
            .concat('\r\n\r\n'),
        );
        socket.end(content);
      };
      const delivered = (): void => {
        job.imagesCompleted += 1;
        job.notReadyLeft = sheetsLeft(job)
          ? scenario.notReady.betweenPages
          : scenario.notReady.beforeEnd;
      };

      switch (fault) {
        case null: {
          chunkedHead();
          for (let offset = 0; offset < body.byteLength; offset += PAGE_CHUNK_BYTES) {
            if (!alive()) {
              socket.destroy();
              return;
            }
            await write(body.subarray(offset, offset + PAGE_CHUNK_BYTES));
          }
          response.end();
          delivered();
          return;
        }
        case 'reset-mid-body':
          chunkedHead();
          await write(half);
          job.state = 'Aborted';
          socket.destroy();
          return;
        case 'stall':
          chunkedHead();
          await write(half);
          return;
        case 'drip':
          chunkedHead();
          for (let offset = 0; offset < body.byteLength && alive(); offset += 1) {
            await write(body.subarray(offset, offset + 1));
            await pause(scenario.dripIntervalMs);
          }
          if (alive()) {
            response.end();
            delivered();
          }
          return;
        case 'oversize': {
          chunkedHead();
          const filler = Buffer.alloc(64 * 1024);
          await write(body.subarray(0, 4));
          for (let sent = 0; sent < scenario.oversizeBytes && alive(); sent += filler.byteLength) {
            await write(filler);
          }
          if (alive()) {
            response.end(Buffer.from([0xff, 0xd9]));
            delivered();
          }
          return;
        }
        case 'not-jpeg':
          chunkedHead();
          response.end(NOT_JPEG);
          delivered();
          return;
        case 'empty':
          chunkedHead();
          response.end();
          delivered();
          return;
        case 'close-mid-body':
          raw([], half);
          delivered();
          return;
        case 'length-longer':
          raw([`CONTENT-LENGTH: ${body.byteLength}`], half);
          delivered();
          return;
        case 'length-shorter':
          raw([`CONTENT-LENGTH: ${half.byteLength}`], body);
          delivered();
          return;
      }
    } finally {
      job.transferring = false;
    }
  }

  const listener: http.RequestListener = (request, response) => {
    handle(request, response).catch(() => {
      request.socket.destroy();
    });
  };
  const server =
    cert === null
      ? http.createServer(listener)
      : https.createServer({ key: cert.keyPem, cert: cert.certPem }, listener);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;

  const maskJob = (path: string): string =>
    path.startsWith(`${collection}/`)
      ? `${collection}/<job>${path.slice(collection.length + 1).replace(/^[^/]*/, '')}`
      : path;

  return {
    scheme,
    host: '127.0.0.1',
    port,
    basePath,
    fingerprint: cert?.fingerprint ?? null,
    exchanges,
    requests: () =>
      exchanges.map((it) => `${it.method} ${maskJob(it.path)} ${it.status ?? 'нет ответа'}`),
    jobs: () => jobs.map(({ path, state, imagesCompleted }) => ({ path, state, imagesCompleted })),
    receivedSettings,
    load(next = {}) {
      scenario = scenarioOf(next);
      trayQueue = (scenario.trays ?? []).map((tray) => [...tray]);
      sheetsUsed = 0;
      faultFired = false;
      busyPostsLeft = scenario.busyPosts;
      busyUntil = 0;
      jam = false;
      jobs = [];
    },
    reloadTray(tray) {
      if (scenario.trays === null) {
        throw new Error('reloadTray — только при сценарии с лотками по заданиям (trays)');
      }
      trayQueue.push([...tray]);
    },
    clearJam() {
      jam = false;
    },
    close() {
      return new Promise((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        for (const [timer, wake] of timers) {
          clearTimeout(timer);
          wake();
        }
        timers.clear();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
