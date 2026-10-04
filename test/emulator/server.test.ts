import * as http from 'node:http';
import * as https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { startTestEmulator } from '../support/emulator';
import { ET_3850, readFixture, readFixtureText } from '../support/fixtures';
import type { Emulator } from './server';

// Эмулятор проверяется голым клиентом Node: код приложения сюда не импортируется (KTD-4).
// Главная проверка — повтор живых следов ET-3850: та же последовательность запросов обязана
// получить от эмулятора те же статусы, что получила от устройства.

interface Reply {
  /** `null` — ответа не было: соединение закрыто. */
  readonly status: number | null;
  readonly headers: http.IncomingHttpHeaders;
  readonly rawHeaders: readonly string[];
  readonly body: Buffer;
  /** Тело оборвалось до конца обрамления. */
  readonly truncated: boolean;
}

function send(emulator: Emulator, method: string, path: string, body?: string): Promise<Reply> {
  return new Promise((resolve) => {
    const options = { host: emulator.host, port: emulator.port, method, path, agent: false };
    const request =
      emulator.scheme === 'https'
        ? https.request({ ...options, rejectUnauthorized: false })
        : http.request(options);
    let answered = false;
    request.once('response', (response) => {
      answered = true;
      const chunks: Buffer[] = [];
      const done = (truncated: boolean): void => {
        resolve({
          status: response.statusCode ?? null,
          headers: response.headers,
          rawHeaders: response.rawHeaders,
          body: Buffer.concat(chunks),
          truncated,
        });
      };
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => {
        done(false);
      });
      // Соединение закрылось раньше конца обрамления; после `end` повторный вызов ничего не меняет.
      response.once('error', () => undefined);
      response.once('close', () => {
        done(true);
      });
    });
    // После заголовков ошибка сокета приходит и в запрос — исход тогда сообщает поток ответа.
    request.on('error', () => {
      if (!answered) {
        resolve({
          status: null,
          headers: {},
          rawHeaders: [],
          body: Buffer.alloc(0),
          truncated: true,
        });
      }
    });
    request.end(body);
  });
}

const SETTINGS = readFixtureText(...ET_3850, 'ScanSettings.a4-gray-300.xml');
const CAPABILITIES = '/eSCL/ScannerCapabilities';
const STATUS = '/eSCL/ScannerStatus';
const JOBS = '/eSCL/ScanJobs';

async function createJob(emulator: Emulator): Promise<string> {
  const reply = await send(emulator, 'POST', JOBS, SETTINGS);
  expect(reply.status).toBe(201);
  return new URL(reply.headers.location ?? '').pathname;
}

/** Запрашивает страницу, повторяя `503`, как это делает клиент. */
async function nextDocument(emulator: Emulator, job: string): Promise<Reply> {
  for (;;) {
    const reply = await send(emulator, 'GET', `${job}/NextDocument`);
    if (reply.status !== 503) {
      return reply;
    }
  }
}

describe('эмулятор сканера: ресурсы', () => {
  it('файл фикстуры отдаётся побайтово: capabilities и страница', async () => {
    const emulator = await startTestEmulator();

    const capabilities = await send(emulator, 'GET', CAPABILITIES);
    const page = await nextDocument(emulator, await createJob(emulator));

    expect(capabilities.status).toBe(200);
    expect(capabilities.body.equals(readFixture(...ET_3850, 'ScannerCapabilities.xml'))).toBe(true);
    expect(page.status).toBe(200);
    expect(page.body.equals(readFixture(...ET_3850, 'pages', 'page-01.jpg'))).toBe(true);
  });

  it('статус в покое с пустым лотком совпадает с фикстурой байт в байт', async () => {
    const emulator = await startTestEmulator({ scenario: { sheets: 0 } });

    const status = await send(emulator, 'GET', STATUS);

    expect(status.body.equals(readFixture(...ET_3850, 'ScannerStatus.xml'))).toBe(true);
  });

  it('заголовки — в том виде, в каком их шлёт ET-3850', async () => {
    const emulator = await startTestEmulator();

    const status = await send(emulator, 'GET', STATUS);
    const page = await nextDocument(emulator, await createJob(emulator));

    expect(status.rawHeaders).toContain('CONTENT-LENGTH');
    expect(status.headers['content-type']).toBe('text/xml;charset="utf-8"');
    expect(status.headers.connection).toBe('close');
    expect(page.rawHeaders).toContain('TRANSFER-ENCODING');
    expect(page.rawHeaders).toContain('CHUNKED');
    expect(page.headers['content-length']).toBeUndefined();
    expect(page.headers['content-location']).toMatch(/^\/eSCL\/ScanJobs\/[0-9a-f-]+\/file-1$/);
  });

  it('устройство без автоподачи отдаёт свои capabilities и задание не принимает', async () => {
    const emulator = await startTestEmulator({ scenario: { device: 'no-adf' } });

    const capabilities = await send(emulator, 'GET', CAPABILITIES);

    expect(capabilities.body.toString('utf8')).not.toContain('AdfSimplexInputCaps');
    expect((await send(emulator, 'POST', JOBS, SETTINGS)).status).toBe(409);
  });

  it('HTTP включается параметром; отпечатка у такого эмулятора нет', async () => {
    const emulator = await startTestEmulator({ http: true });

    expect(emulator.scheme).toBe('http');
    expect(emulator.fingerprint).toBeNull();
    expect((await send(emulator, 'GET', STATUS)).status).toBe(200);
  });

  it('чужой путь и неизвестное задание — 404', async () => {
    const emulator = await startTestEmulator();

    expect((await send(emulator, 'GET', '/')).status).toBe(404);
    expect((await send(emulator, 'GET', '/eSCLx/ScannerStatus')).status).toBe(404);
    expect((await send(emulator, 'GET', `${JOBS}/unknown/NextDocument`)).status).toBe(404);
    expect((await send(emulator, 'DELETE', `${JOBS}/unknown`)).status).toBe(404);
  });
});

describe('эмулятор сканера: задание', () => {
  it('задание на N страниц отдаёт N ответов 200 и затем 404', async () => {
    const emulator = await startTestEmulator({ scenario: { sheets: 5 } });
    const job = await createJob(emulator);

    const statuses: (number | null)[] = [];
    for (let index = 0; index < 6; index += 1) {
      statuses.push((await nextDocument(emulator, job)).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 404]);
    expect(emulator.jobs()).toEqual([{ path: job, state: 'Completed', imagesCompleted: 5 }]);
  });

  it('страницы идут по порядку фикстур, а за последней фикстурой — снова с первой', async () => {
    const emulator = await startTestEmulator({ scenario: { sheets: 31 } });
    const job = await createJob(emulator);

    const bodies: Buffer[] = [];
    for (let index = 0; index < 31; index += 1) {
      bodies.push((await nextDocument(emulator, job)).body);
    }

    expect(bodies[1]?.equals(readFixture(...ET_3850, 'pages', 'page-02.jpg'))).toBe(true);
    expect(bodies[29]?.equals(readFixture(...ET_3850, 'pages', 'page-30.jpg'))).toBe(true);
    expect(bodies[30]?.equals(readFixture(...ET_3850, 'pages', 'page-01.jpg'))).toBe(true);
  });

  it('DELETE закрывает задание; следующее создаётся без занятости', async () => {
    const emulator = await startTestEmulator();
    const job = await createJob(emulator);

    expect((await send(emulator, 'DELETE', job)).status).toBe(200);
    expect((await send(emulator, 'GET', `${job}/NextDocument`)).status).toBe(410);
    expect((await send(emulator, 'DELETE', job)).status).toBe(404);
    expect((await send(emulator, 'POST', JOBS, SETTINGS)).status).toBe(201);
  });

  it('незакрытое задание делает следующий POST занятым — как на устройстве', async () => {
    const emulator = await startTestEmulator();
    const job = await createJob(emulator);
    await nextDocument(emulator, job);

    const refused = await send(emulator, 'POST', JOBS, SETTINGS);

    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBe('20');
    expect((await send(emulator, 'GET', STATUS)).body.toString('utf8')).toContain(
      `<pwg:JobUri>${job}</pwg:JobUri>`,
    );
  });

  it('брошенное задание устройство снимает само, и занятость проходит', async () => {
    const emulator = await startTestEmulator({ scenario: { abandonAfterMs: 30 } });
    const job = await createJob(emulator);

    await delay(60);

    expect((await send(emulator, 'POST', JOBS, SETTINGS)).status).toBe(201);
    expect((await send(emulator, 'DELETE', job)).status).toBe(404);
    expect(emulator.jobs()[1]).toEqual({ path: job, state: 'Aborted', imagesCompleted: 0 });
  });

  it('после DELETE идущего задания устройство ещё занято: оно гонит остаток пачки', async () => {
    // Окно с запасом: первый POST обязан попасть в него и на медленной машине.
    const emulator = await startTestEmulator({ scenario: { busyAfterCancelMs: 400 } });
    await send(emulator, 'DELETE', await createJob(emulator));

    expect((await send(emulator, 'POST', JOBS, SETTINGS)).status).toBe(503);
    // Статус при этом уже показывает покой — как на устройстве (журнал M1, U1).
    expect((await send(emulator, 'GET', STATUS)).body.toString('utf8')).toContain('>Idle<');
    // Конца окна тест ждёт повторами, как клиент, а не фиксированной паузой.
    let status: number | null = 503;
    for (let attempt = 0; attempt < 200 && status === 503; attempt += 1) {
      await delay(20);
      status = (await send(emulator, 'POST', JOBS, SETTINGS)).status;
    }
    expect(status).toBe(201);
  });

  it('после DELETE идущего задания лоток пуст: остаток пачки ушёл через тракт', async () => {
    const emulator = await startTestEmulator({ scenario: { sheets: 3 } });
    const first = await createJob(emulator);
    await nextDocument(emulator, first);
    await send(emulator, 'DELETE', first);

    const second = await createJob(emulator);

    expect((await nextDocument(emulator, second)).status).toBe(404);
    expect(emulator.jobs()[0]?.state).toBe('Aborted');
  });

  it('занятость: первые POST получают 503, затем задание создаётся', async () => {
    const emulator = await startTestEmulator({ scenario: { busyPosts: 2 } });

    const statuses = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await send(emulator, 'POST', JOBS, SETTINGS)).status);
    }

    expect(statuses).toEqual([503, 503, 201]);
  });

  it('новый сценарий перезаряжает лоток на том же адресе', async () => {
    const emulator = await startTestEmulator({ scenario: { sheets: 0 } });
    expect((await nextDocument(emulator, await createJob(emulator))).status).toBe(404);

    emulator.load({ sheets: 1 });

    expect((await nextDocument(emulator, await createJob(emulator))).status).toBe(200);
    expect(emulator.requests().at(-1)).toBe('GET /eSCL/ScanJobs/<job>/NextDocument 200');
  });

  it.each([
    ['absolute', /^https:\/\/127\.0\.0\.1:\d+\/eSCL\/ScanJobs\/[0-9a-f-]+$/],
    ['path', /^\/eSCL\/ScanJobs\/[0-9a-f-]+$/],
    ['relative', /^ScanJobs\/[0-9a-f-]+$/],
    ['foreign-host', /^https:\/\/203\.0\.113\.7:443\/eSCL\/ScanJobs\//],
    ['http-scheme', /^http:\/\/127\.0\.0\.1:\d+\/eSCL\/ScanJobs\//],
    ['outside', /^\/other\/ScanJobs\//],
    ['traversal', /\/\.\.\//],
  ] as const)('Location в форме «%s»', async (location, pattern) => {
    const emulator = await startTestEmulator({ scenario: { location } });

    const reply = await send(emulator, 'POST', JOBS, SETTINGS);

    expect(reply.headers.location).toMatch(pattern);
  });

  it('Location может отсутствовать — задание при этом создано и видно в статусе', async () => {
    const emulator = await startTestEmulator({ scenario: { location: 'missing' } });

    const reply = await send(emulator, 'POST', JOBS, SETTINGS);

    expect(reply.status).toBe(201);
    expect(reply.headers.location).toBeUndefined();
    expect(emulator.jobs()[0]?.state).toBe('Processing');
  });
});

describe('эмулятор сканера: сбои страницы', () => {
  const page = readFixture(...ET_3850, 'pages', 'page-01.jpg');
  const half = Math.floor(page.byteLength / 2);

  async function faulty(kind: NonNullable<Parameters<typeof startTestEmulator>[0]>['scenario']) {
    const emulator = await startTestEmulator({ scenario: kind ?? {} });
    const job = await createJob(emulator);
    return { emulator, job, reply: await nextDocument(emulator, job) };
  }

  it('сбой подачи между страницами — 410, задание оборвано, статус показывает замятие', async () => {
    const { emulator, job, reply } = await faulty({ fault: { sheet: 1, kind: 'gone' } });

    expect(reply.status).toBe(410);
    expect((await send(emulator, 'DELETE', job)).status).toBe(404);
    expect((await send(emulator, 'GET', STATUS)).body.toString('utf8')).toContain('ScannerAdfJam');

    emulator.clearJam();
    expect((await send(emulator, 'GET', STATUS)).body.toString('utf8')).toContain(
      'ScannerAdfLoaded',
    );
  });

  it('сбой подачи при висящем запросе — соединение закрыто без ответа', async () => {
    const { emulator, reply } = await faulty({ fault: { sheet: 1, kind: 'reset-before-headers' } });

    expect(reply.status).toBeNull();
    expect(emulator.jobs()[0]?.state).toBe('Aborted');
  });

  it('обрыв посреди тела: половина страницы и оборванное обрамление', async () => {
    const { reply } = await faulty({ fault: { sheet: 1, kind: 'reset-mid-body' } });

    expect(reply.status).toBe(200);
    expect(reply.truncated).toBe(true);
    expect(reply.body.byteLength).toBeLessThan(page.byteLength);
  });

  it('тело, обрамлённое закрытием соединения, кончается посреди страницы без ошибки', async () => {
    const { reply } = await faulty({ fault: { sheet: 1, kind: 'close-mid-body' } });

    expect(reply.truncated).toBe(false);
    expect(reply.body.equals(page.subarray(0, half))).toBe(true);
  });

  it('Content-Length длиннее тела — обрыв; короче тела — страницы целиком клиент не получает', async () => {
    const longer = await faulty({ fault: { sheet: 1, kind: 'length-longer' } });
    const shorter = await faulty({ fault: { sheet: 1, kind: 'length-shorter' } });

    expect(longer.reply.headers['content-length']).toBe(String(page.byteLength));
    expect(longer.reply.truncated).toBe(true);
    expect(shorter.reply.headers['content-length']).toBe(String(half));
    expect(shorter.reply.body.byteLength).toBeLessThanOrEqual(half);
  });

  it('пустой ответ 200 и тело не JPEG', async () => {
    const empty = await faulty({ fault: { sheet: 1, kind: 'empty' } });
    const notJpeg = await faulty({ fault: { sheet: 1, kind: 'not-jpeg' } });

    expect(empty.reply.status).toBe(200);
    expect(empty.reply.body.byteLength).toBe(0);
    expect(notJpeg.reply.headers['content-type']).toBe('image/jpeg');
    expect(notJpeg.reply.body.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(false);
  });

  it('страница больше потолка несёт заявленный сценарием размер', async () => {
    const { reply } = await faulty({
      fault: { sheet: 1, kind: 'oversize' },
      oversizeBytes: 300_000,
    });

    expect(reply.body.byteLength).toBeGreaterThan(300_000);
    expect(reply.body.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
  });

  it('сбой срабатывает один раз: следующее задание получает тот же лист целым', async () => {
    const { emulator } = await faulty({ sheets: 2, fault: { sheet: 1, kind: 'gone' } });

    const reply = await nextDocument(emulator, await createJob(emulator));

    expect(reply.body.equals(page)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Повтор живых следов: эмулятор не расходится с устройством.
// ---------------------------------------------------------------------------------------------

interface TraceExchange {
  readonly label: string;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly scannerStatus?: {
    readonly jobs: readonly { readonly jobState: string; readonly imagesCompleted: number }[];
  };
}

const PLACEHOLDER_JOB = /\/eSCL\/ScanJobs\/[0-9a-f-]{36}/;
const REJECTED_SETTINGS = SETTINGS.replace('Grayscale8', 'BlackAndWhite1');

async function replay(
  trace: string,
  emulator: Emulator,
  settings = SETTINGS,
): Promise<{ expected: string[]; actual: string[] }> {
  const { exchanges } = JSON.parse(readFixtureText(...ET_3850, 'traces', `${trace}.json`)) as {
    exchanges: TraceExchange[];
  };
  const expected: string[] = [];
  const actual: string[] = [];
  let job = '';

  for (const exchange of exchanges) {
    const path = exchange.path.replace(PLACEHOLDER_JOB, job);
    const reply = await send(
      emulator,
      exchange.method,
      path,
      exchange.method === 'POST' ? settings : undefined,
    );
    if (reply.status === 201) {
      job = new URL(reply.headers.location ?? '').pathname;
    }

    // Состояние задания сравнивается, только пока в статусе есть наше задание: история прежних
    // заданий у устройства своя.
    const device = exchange.scannerStatus?.jobs[0];
    const ours = job !== '' && device !== undefined;
    const state = (value: string, images: number | string): string =>
      ours ? ` ${value}/${images}` : '';
    const xml = reply.body.toString('utf8');
    expected.push(
      `${exchange.label} ${exchange.status}${state(device?.jobState ?? '', device?.imagesCompleted ?? 0)}`,
    );
    actual.push(
      `${exchange.label} ${reply.status}${state(
        /<pwg:JobState>(\w+)</.exec(xml)?.[1] ?? '',
        /<pwg:ImagesCompleted>(\d+)</.exec(xml)?.[1] ?? '',
      )}`,
    );
  }
  return { expected, actual };
}

describe('эмулятор сканера: повтор следов ET-3850', () => {
  it('проход на три страницы', async () => {
    const emulator = await startTestEmulator({ scenario: { sheets: 3 } });

    const { expected, actual } = await replay('pass-three-pages', emulator);

    expect(actual).toEqual(expected);
    expect(actual).toContain('page-4 404');
  });

  it('пустой лоток', async () => {
    const emulator = await startTestEmulator({ scenario: { sheets: 0 } });

    const { expected, actual } = await replay('empty-tray', emulator);

    expect(actual).toEqual(expected);
  });

  it('DELETE посреди задания', async () => {
    const emulator = await startTestEmulator({ scenario: { sheets: 3 } });

    const { expected, actual } = await replay('delete-mid-job', emulator);

    expect(actual).toEqual(expected);
    expect(actual).toContain('page-after-delete 410');
  });

  it('сбой подачи между страницами', async () => {
    const emulator = await startTestEmulator({
      scenario: {
        sheets: 3,
        notReady: { betweenPages: 6, beforeEnd: 4 },
        fault: { sheet: 2, kind: 'gone' },
      },
    });

    const { expected, actual } = await replay('feed-failure-between-pages', emulator);

    expect(actual).toEqual(expected);
  });

  it('сбой подачи при висящем запросе', async () => {
    const emulator = await startTestEmulator({
      scenario: { fault: { sheet: 1, kind: 'reset-before-headers' } },
    });

    const { expected, actual } = await replay('feed-failure-during-page', emulator);

    expect(actual).toEqual(expected);
    expect(actual).toContain('page-1 null');
  });

  it('отклонённые параметры', async () => {
    const emulator = await startTestEmulator({ scenario: { sheets: 0 } });

    const { expected, actual } = await replay('settings-rejected', emulator, REJECTED_SETTINGS);

    expect(actual).toEqual(expected);
    expect(actual).toContain('post-1 409');
  });
});
