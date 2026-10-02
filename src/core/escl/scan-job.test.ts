import { describe, expect, it } from 'vitest';
import { fail, ok, type DomainError } from '@shared';
import { ET_3850, readFixture } from '../../../test/support/fixtures';
import {
  runScanJob,
  SCAN_JOB_LIMITS,
  type IncomingPage,
  type ScanJobEnd,
  type ScanJobRequest,
} from './scan-job';
import { TransportError, type ResponseHead, type ScannerTransport } from './transport';

// Логика задания на подставном транспорте: ответы идут по сценарию, время — подставное. Настоящая
// цепочка «транспорт → эмулятор → диск» — в test/integration/scan-job.emulator.test.ts.

const JOB = '/eSCL/ScanJobs/job-1';
const POST = 'POST /eSCL/ScanJobs';
const NEXT = `GET ${JOB}/NextDocument`;
const DELETE = `DELETE ${JOB}`;

const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 0xff, 0xd9);

interface Step {
  readonly status?: number;
  readonly location?: string | null;
  readonly body?: Uint8Array;
  /** Части тела страницы; по умолчанию — целый JPEG одним куском. */
  readonly chunks?: readonly Uint8Array[];
  /** Сбой чтения после отданных частей. */
  readonly bodyError?: TransportError;
  /** Отказ обмена вместо ответа. */
  readonly failure?: DomainError;
  /** Выполняется, пока запрос «в полёте». */
  readonly during?: () => void;
}

const created: Step = { status: 201, location: `https://192.0.2.10:443${JOB}` };
const page: Step = { status: 200 };
const notReady: Step = { status: 503 };
const end: Step = { status: 404 };
const deleted: Step = { status: 200 };

function fakeTransport(steps: readonly Step[]) {
  const queue = [...steps];
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];

  const next = (label: string, signal: AbortSignal | undefined): Step => {
    const step = queue.shift();
    if (step === undefined) {
      throw new Error(`запрос сверх сценария: ${label}`);
    }
    calls.push(label);
    signals.push(signal);
    step.during?.();
    return step;
  };
  const headOf = (step: Step): ResponseHead => ({
    status: step.status ?? 0,
    location: step.location ?? null,
    contentType: null,
    fingerprint: null,
  });
  async function* bodyOf(step: Step): AsyncGenerator<Uint8Array> {
    await Promise.resolve();
    yield* step.chunks ?? [JPEG];
    if (step.bodyError !== undefined) {
      throw step.bodyError;
    }
  }

  const transport: ScannerTransport = {
    request(options) {
      const step = next(`${options.method} ${options.path}`, options.signal);
      return Promise.resolve(
        step.failure === undefined
          ? ok({ ...headOf(step), body: step.body ?? new Uint8Array() })
          : fail(step.failure.code, step.failure.details),
      );
    },
    async stream(options, consume) {
      if (options.signal?.aborted === true) {
        return fail('canceled');
      }
      const step = next(`${options.method} ${options.path}`, options.signal);
      if (step.failure !== undefined) {
        return fail(step.failure.code, step.failure.details);
      }
      try {
        return ok(await consume(headOf(step), step.status === 200 ? bodyOf(step) : null));
      } catch (error) {
        if (error instanceof TransportError) {
          return fail(error.failure.code, error.failure.details);
        }
        throw error;
      }
    },
    close: () => undefined,
  };
  return { transport, calls, signals, left: queue };
}

function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: {
      now: () => now,
      sleep: (ms: number) => {
        now += ms;
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  };
}

interface Received {
  readonly index: number;
  readonly bytes: number[];
}

function collector() {
  const received: Received[] = [];
  const sink = async ({ index, body }: IncomingPage): Promise<void> => {
    const entry: Received = { index, bytes: [] };
    received.push(entry);
    for await (const chunk of body) {
      entry.bytes.push(...chunk);
    }
  };
  return { received, sink };
}

async function run(steps: readonly Step[], overrides: Partial<ScanJobRequest> = {}) {
  const fake = fakeTransport(steps);
  const { clock, sleeps } = fakeClock();
  const { received, sink } = collector();
  const result = await runScanJob({
    transport: fake.transport,
    basePath: '/eSCL',
    settings: '<settings/>',
    sink,
    clock,
    ...overrides,
  });
  return { ...fake, sleeps, received, result, report: result.ok ? result.value : null };
}

const deviceError = (ended: ScanJobEnd | undefined): DomainError | null =>
  ended?.kind === 'interrupted' && ended.reason.source === 'device' ? ended.reason.error : null;

describe('задание автоподачи: обычный проход', () => {
  it('страницы идут приёмнику по порядку; 404 после страниц — конец; DELETE отправлен', async () => {
    const { report, calls, received, left } = await run([
      created,
      page,
      notReady,
      page,
      notReady,
      end,
      { status: 404 },
    ]);

    expect(report).toEqual({
      end: { kind: 'completed' },
      pages: 2,
      job: { path: JOB, closed: true },
    });
    expect(calls).toEqual([POST, NEXT, NEXT, NEXT, NEXT, NEXT, DELETE]);
    expect(received).toEqual([
      { index: 1, bytes: [...JPEG] },
      { index: 2, bytes: [...JPEG] },
    ]);
    expect(left).toEqual([]);
  });

  it('404 на первой странице — пустой проход; DELETE отправлен', async () => {
    const { report, calls, received } = await run([created, end, { status: 404 }]);

    expect(report).toEqual({ end: { kind: 'empty' }, pages: 0, job: { path: JOB, closed: true } });
    expect(calls).toEqual([POST, NEXT, DELETE]);
    expect(received).toEqual([]);
  });

  it('из Location берётся только путь: чужой хост и схема отбрасываются', async () => {
    const { report } = await run([
      { status: 201, location: `http://203.0.113.7:8080${JOB}` },
      end,
      deleted,
    ]);

    expect(report?.job).toEqual({ path: JOB, closed: true });
  });

  it('тело POST — переданные параметры; пределы страницы уходят в транспорт', async () => {
    const seen: unknown[] = [];
    const { transport } = fakeTransport([created, end, deleted]);
    const spy: ScannerTransport = {
      ...transport,
      request: (options) => {
        seen.push(options.body);
        return transport.request(options);
      },
      stream: (options, consume) => {
        seen.push([options.maxBytes, options.idleTimeoutMs, options.deadlineMs]);
        return transport.stream(options, consume);
      },
    };

    await runScanJob({
      transport: spy,
      basePath: '/eSCL',
      settings: '<settings/>',
      sink: collector().sink,
    });

    expect(seen[0]).toBe('<settings/>');
    expect(seen[1]).toEqual([
      SCAN_JOB_LIMITS.maxPageBytes,
      SCAN_JOB_LIMITS.pageIdleTimeoutMs,
      SCAN_JOB_LIMITS.pageDeadlineMs,
    ]);
  });
});

describe('задание автоподачи: занятость и отказ создать задание', () => {
  it('занятость, затем успех: вызывающий видит ожидание, повтор — раз в секунду', async () => {
    const phases: string[] = [];
    const { report, sleeps } = await run(
      [{ status: 503 }, { status: 503 }, created, page, end, deleted],
      { onPhase: (phase) => phases.push(phase) },
    );

    expect(report?.end).toEqual({ kind: 'completed' });
    expect(phases).toEqual(['busy', 'scanning']);
    expect(sleeps.slice(0, 2)).toEqual([1000, 1000]);
  });

  it('занятость без конца — отказ «занят» после потолка ожидания, задания нет', async () => {
    const { result, calls } = await run(Array.from({ length: 100 }, () => ({ status: 503 })));

    expect(result).toEqual(fail('scannerBusy'));
    // Потолок 60 с при повторе раз в секунду: попытки на 0…60-й секунде.
    expect(calls).toHaveLength(61);
    expect(calls.every((call) => call === POST)).toBe(true);
  });

  it('409 — параметры отклонены устройством; повтора нет', async () => {
    const { result, calls } = await run([{ status: 409 }]);

    expect(result).toEqual(fail('scanParamsRejected'));
    expect(calls).toEqual([POST]);
  });

  it('другой статус на POST — отказ с этим статусом в деталях', async () => {
    const { result } = await run([{ status: 500 }]);

    expect(result).toEqual(fail('scannerBadResponse', { reason: 'status', status: 500 }));
  });

  it('сбой сети на POST возвращается как есть', async () => {
    const failure: DomainError = { code: 'scannerUnreachable', details: { reason: 'refused' } };
    const { result, calls } = await run([{ failure }]);

    expect(result).toEqual(fail(failure.code, failure.details));
    expect(calls).toEqual([POST]);
  });
});

describe('задание автоподачи: обрыв', () => {
  it('410 — сбой подачи: прервано, целые страницы сосчитаны, DELETE отправлен', async () => {
    const { report, calls } = await run([created, page, notReady, { status: 410 }, end]);

    expect(report?.pages).toBe(1);
    expect(deviceError(report?.end)).toEqual({
      code: 'scanFeedFailed',
      details: { reason: 'gone' },
    });
    expect(report?.job).toEqual({ path: JOB, closed: true });
    expect(calls.at(-1)).toBe(DELETE);
  });

  it('серия 503 дольше потолка — прервано; серия короче потолка — штатное ожидание', async () => {
    const endless = await run([
      created,
      page,
      ...Array.from({ length: 100 }, () => notReady),
      deleted,
    ]);
    const patient = await run([
      created,
      ...Array.from({ length: 25 }, () => notReady),
      page,
      ...Array.from({ length: 25 }, () => notReady),
      end,
      deleted,
    ]);

    expect(deviceError(endless.report?.end)).toEqual({
      code: 'scanFeedFailed',
      details: { reason: 'notReady' },
    });
    // Потолок 30 с: 31 ответ `503`, затем сразу DELETE.
    expect(endless.calls.filter((call) => call === NEXT)).toHaveLength(32);
    expect(endless.calls.at(-1)).toBe(DELETE);
    // После страницы серия считается заново.
    expect(patient.report?.end).toEqual({ kind: 'completed' });
  });

  it('неожиданный статус на NextDocument — прервано', async () => {
    const { report } = await run([created, { status: 500 }, deleted]);

    expect(deviceError(report?.end)).toEqual({
      code: 'scannerBadResponse',
      details: { reason: 'status', status: 500 },
    });
  });

  it('отказ обмена на странице — прервано с причиной транспорта', async () => {
    const failure: DomainError = { code: 'scannerUnreachable', details: { reason: 'timeout' } };
    const { report, calls } = await run([created, page, { failure }, deleted]);

    expect(report?.pages).toBe(1);
    expect(deviceError(report?.end)).toEqual(failure);
    expect(calls.at(-1)).toBe(DELETE);
  });

  it('обрыв посреди тела: недописанная страница целой не считается', async () => {
    const reset = new TransportError({ code: 'scannerUnreachable', details: { reason: 'reset' } });
    const { report } = await run([
      created,
      page,
      { status: 200, chunks: [JPEG.subarray(0, 5)], bodyError: reset },
      deleted,
    ]);

    expect(report?.pages).toBe(1);
    expect(deviceError(report?.end)).toEqual(reset.failure);
  });

  it('потолок числа страниц: лишняя страница не запрашивается', async () => {
    const { report, calls } = await run([created, page, page, deleted], {
      limits: { maxPages: 2 },
    });

    expect(report?.pages).toBe(2);
    expect(deviceError(report?.end)).toEqual({
      code: 'scannerBadResponse',
      details: { reason: 'tooManyPages' },
    });
    expect(calls).toEqual([POST, NEXT, NEXT, DELETE]);
  });
});

describe('задание автоподачи: страница — только JPEG', () => {
  const oneByOne = Array.from(JPEG, (byte) => Uint8Array.of(byte));

  it('страница, пришедшая по байту, принимается', async () => {
    const { report, received } = await run([
      created,
      { status: 200, chunks: oneByOne },
      end,
      deleted,
    ]);

    expect(report?.end).toEqual({ kind: 'completed' });
    expect(received[0]?.bytes).toEqual([...JPEG]);
  });

  it('тело не JPEG отклоняется раньше, чем первый байт уйдёт приёмнику', async () => {
    const html = new TextEncoder().encode('<html>');
    const { report, received } = await run([created, { status: 200, chunks: [html] }, deleted]);

    expect(report?.pages).toBe(0);
    expect(deviceError(report?.end)).toEqual({
      code: 'scannerBadResponse',
      details: { reason: 'notJpeg' },
    });
    expect(received[0]?.bytes).toEqual([]);
  });

  it('второй байт не тот — отказ, даже когда он пришёл отдельной частью', async () => {
    const { report } = await run([
      created,
      { status: 200, chunks: [Uint8Array.of(0xff), Uint8Array.of(0x00, 0xff, 0xd9)] },
      deleted,
    ]);

    expect(deviceError(report?.end)?.details).toEqual({ reason: 'notJpeg' });
  });

  it('страница без маркера конца — обрыв: тело, обрамлённое закрытием соединения', async () => {
    const { report } = await run([
      created,
      { status: 200, chunks: [JPEG.subarray(0, JPEG.length - 2)] },
      deleted,
    ]);

    expect(report?.pages).toBe(0);
    expect(deviceError(report?.end)?.details).toEqual({ reason: 'notJpeg' });
  });

  it('пустой ответ 200 — не страница', async () => {
    const { report } = await run([created, { status: 200, chunks: [] }, deleted]);

    expect(report?.pages).toBe(0);
    expect(deviceError(report?.end)?.details).toEqual({ reason: 'emptyPage' });
  });

  it('одних маркеров мало: SOI и EOI без содержимого между ними проходят, один маркер — нет', async () => {
    const bare = await run([
      created,
      { status: 200, chunks: [Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)] },
      end,
      deleted,
    ]);
    const lone = await run([
      created,
      { status: 200, chunks: [Uint8Array.of(0xff, 0xd8)] },
      deleted,
    ]);

    expect(bare.report?.pages).toBe(1);
    expect(deviceError(lone.report?.end)?.details).toEqual({ reason: 'notJpeg' });
  });
});

describe('задание автоподачи: приёмник и обработчики вызывающего', () => {
  const diskFull = Object.assign(new Error('нет места'), { code: 'ENOSPC' });

  it('исключение приёмника — прервано с его ошибкой; DELETE отправлен', async () => {
    let seen = 0;
    const { report, calls } = await run([created, page, page, deleted], {
      sink: async ({ body }) => {
        seen += 1;
        if (seen === 2) {
          throw diskFull;
        }
        await collector().sink({ index: seen, body });
      },
    });

    expect(report?.pages).toBe(1);
    expect(report?.end).toEqual({
      kind: 'interrupted',
      reason: { source: 'sink', error: diskFull },
    });
    expect(calls).toEqual([POST, NEXT, NEXT, DELETE]);
  });

  it('приёмник, не дочитавший тело, страницу не получает: она не проверена', async () => {
    const { report } = await run([created, page, deleted], { sink: () => Promise.resolve() });

    expect(report?.pages).toBe(0);
    expect(report?.end.kind).toBe('interrupted');
    expect(report?.end.kind === 'interrupted' && report.end.reason.source).toBe('sink');
  });

  it('адрес задания сообщается до первой страницы, исход — до DELETE', async () => {
    const order: string[] = [];
    const fake = fakeTransport([created, page, end, deleted]);
    const logged: ScannerTransport = {
      ...fake.transport,
      request: (options) => {
        order.push(options.method);
        return fake.transport.request(options);
      },
      stream: (options, consume) => {
        order.push('NextDocument');
        return fake.transport.stream(options, consume);
      },
    };

    await runScanJob({
      transport: logged,
      basePath: '/eSCL',
      settings: '<settings/>',
      sink: collector().sink,
      onJobCreated: (path) => {
        order.push(`создано ${path}`);
      },
      onEnd: (ended, pages) => {
        order.push(`исход ${ended.kind} ${pages}`);
      },
    });

    expect(order).toEqual([
      'POST',
      `создано ${JOB}`,
      'NextDocument',
      'NextDocument',
      'исход completed 1',
      'DELETE',
    ]);
  });

  it('отказ записать адрес задания: страницы не запрашиваются, задание закрыто', async () => {
    const { report, calls } = await run([created, deleted], {
      onJobCreated: () => Promise.reject(diskFull),
    });

    expect(report?.end).toEqual({
      kind: 'interrupted',
      reason: { source: 'sink', error: diskFull },
    });
    expect(calls).toEqual([POST, DELETE]);
  });

  it('исключение onPhase после создания задания: страницы не запрашиваются, задание закрыто', async () => {
    const { report, calls } = await run([created, deleted], {
      onPhase: () => {
        throw diskFull;
      },
    });

    expect(report?.end).toEqual({
      kind: 'interrupted',
      reason: { source: 'sink', error: diskFull },
    });
    expect(report?.job).toEqual({ path: JOB, closed: true });
    expect(calls).toEqual([POST, DELETE]);
  });

  it('исключение onPhase при занятости пробрасывается: задания ещё нет', async () => {
    const fake = fakeTransport([{ status: 503 }]);

    await expect(
      runScanJob({
        transport: fake.transport,
        basePath: '/eSCL',
        settings: '<settings/>',
        sink: collector().sink,
        clock: fakeClock().clock,
        onPhase: () => {
          throw diskFull;
        },
      }),
    ).rejects.toBe(diskFull);
    expect(fake.calls).toEqual([POST]);
  });

  it('при негодном Location обработчики не вызываются: исход несёт только отчёт', async () => {
    const called: string[] = [];
    const { report } = await run([{ status: 201 }, { status: 500 }], {
      onPhase: (phase) => called.push(phase),
      onJobCreated: () => {
        called.push('создано');
      },
      onEnd: () => {
        called.push('исход');
      },
    });

    expect(called).toEqual([]);
    expect(report?.job).toEqual({ path: null, closed: false });
  });

  it('отказ записать исход: задание всё равно закрыто, отчёт несёт ошибку', async () => {
    const { report, calls } = await run([created, page, end, deleted], {
      onEnd: () => {
        throw diskFull;
      },
    });

    expect(report?.pages).toBe(1);
    expect(report?.end.kind).toBe('interrupted');
    expect(report?.job?.closed).toBe(true);
    expect(calls.at(-1)).toBe(DELETE);
  });
});

describe('задание автоподачи: отмена', () => {
  it('отмена до старта — задания нет, запросов нет', async () => {
    const controller = new AbortController();
    controller.abort();

    const { report, calls } = await run([], { signal: controller.signal });

    expect(report).toEqual({ end: { kind: 'canceled' }, pages: 0, job: null });
    expect(calls).toEqual([]);
  });

  it('отмена во время ожидания занятости без запроса в полёте не создаёт задания', async () => {
    const controller = new AbortController();
    const { clock } = fakeClock();

    const { report, calls } = await run([{ status: 503 }], {
      signal: controller.signal,
      clock: {
        now: clock.now,
        sleep: () => {
          controller.abort();
          return Promise.resolve();
        },
      },
    });

    expect(report).toEqual({ end: { kind: 'canceled' }, pages: 0, job: null });
    expect(calls).toEqual([POST]);
  });

  it('отмена при POST в полёте дожидается ответа и закрывает задание', async () => {
    const controller = new AbortController();

    const { report, calls, signals } = await run(
      [
        {
          ...created,
          during: () => {
            controller.abort();
          },
        },
        deleted,
      ],
      { signal: controller.signal },
    );

    expect(report).toEqual({
      end: { kind: 'canceled' },
      pages: 0,
      job: { path: JOB, closed: true },
    });
    expect(calls).toEqual([POST, DELETE]);
    // Ни `POST`, ни `DELETE` сигнала отмены не получают: оборвать их нельзя.
    expect(signals).toEqual([undefined, undefined]);
  });

  it('отмена во время страницы — отменено, целые страницы сосчитаны, DELETE отправлен', async () => {
    const controller = new AbortController();

    const { report, calls, signals } = await run(
      [created, page, { failure: { code: 'canceled' } }, deleted],
      { signal: controller.signal },
    );

    expect(report).toEqual({
      end: { kind: 'canceled' },
      pages: 1,
      job: { path: JOB, closed: true },
    });
    expect(calls.at(-1)).toBe(DELETE);
    expect(signals[1]).toBe(controller.signal);
  });
});

describe('задание автоподачи: закрытие', () => {
  it.each([
    [{ status: 200 }, true],
    [{ status: 404 }, true],
    [{ status: 500 }, false],
    [{ failure: { code: 'scannerUnreachable', details: { reason: 'timeout' } } }, false],
  ] as const)('ответ DELETE %j — закрыто: %s', async (step, closed) => {
    const { report } = await run([created, page, end, step]);

    expect(report?.end).toEqual({ kind: 'completed' });
    expect(report?.job).toEqual({ path: JOB, closed });
  });

  const statusWith = (...states: string[]): Uint8Array => {
    const jobs = states
      .map(
        (state, index) =>
          `<scan:JobInfo><pwg:JobUri>/eSCL/ScanJobs/job-${index + 1}</pwg:JobUri>` +
          `<pwg:JobState>${state}</pwg:JobState></scan:JobInfo>`,
      )
      .join('');
    const idle = readFixture(...ET_3850, 'ScannerStatus.xml').toString('utf8');
    return new TextEncoder().encode(
      idle.replace('</scan:ScannerStatus>', `<scan:Jobs>${jobs}</scan:Jobs></scan:ScannerStatus>`),
    );
  };

  it.each([
    ['отсутствует', null],
    ['вне коллекции заданий', '/other/ScanJobs/job-1'],
    ['с точечным сегментом', '/eSCL/ScanJobs/../ScanJobs/job-1'],
    ['с запросом', `${JOB}?x=1`],
  ])(
    'Location %s: адрес идущего задания берётся из статуса, задание закрыто',
    async (_, location) => {
      const { report, calls } = await run([
        { status: 201, location },
        { status: 200, body: statusWith('Processing', 'Completed') },
        deleted,
      ]);

      expect(report?.pages).toBe(0);
      expect(deviceError(report?.end)?.details).toEqual({ reason: 'location' });
      expect(report?.job).toEqual({ path: JOB, closed: true });
      expect(calls).toEqual([POST, 'GET /eSCL/ScannerStatus', DELETE]);
    },
  );

  it('Location негоден, а статус идущего задания не показывает — задание не закрыть', async () => {
    const none = await run([{ status: 201 }, { status: 200, body: statusWith('Completed') }]);
    const two = await run([
      { status: 201 },
      { status: 200, body: statusWith('Processing', 'Processing') },
    ]);
    const unreadable = await run([{ status: 201 }, { status: 500 }]);

    for (const { report, calls } of [none, two, unreadable]) {
      expect(report?.job).toEqual({ path: null, closed: false });
      expect(calls).toEqual([POST, 'GET /eSCL/ScannerStatus']);
    }
  });
});
