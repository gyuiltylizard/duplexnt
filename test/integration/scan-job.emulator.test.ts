import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  runScanJob,
  type PageSink,
  type ScanJobEnd,
  type ScanJobLimits,
  type ScanJobRequest,
} from '../../src/core/escl/scan-job';
import { createTransport } from '../../src/core/escl/transport';
import { writeStreamAtomic } from '../../src/core/storage/atomic-file';
import type { DomainError } from '../../src/shared';
import type { Scenario } from '../emulator/scenarios';
import { startTestEmulator } from '../support/emulator';
import { ET_3850, readFixture, readFixtureText } from '../support/fixtures';
import { makeTempDataRoot } from '../support/temp-data-root';

// Задание автоподачи на настоящей цепочке: продуктовый транспорт по HTTPS → эмулятор сканера →
// атомарная запись на диск (план M1, U10). В каждом сценарии эмулятор видел `DELETE`, либо тест
// знает незакрытый адрес.

const SETTINGS = readFixtureText(...ET_3850, 'ScanSettings.a4-gray-300.xml');
const pageFixture = (number: number): Buffer =>
  readFixture(...ET_3850, 'pages', `page-${String(number).padStart(2, '0')}.jpg`);

// Те же правила, что в продукте, но время сжато: тесты не ждут секундами.
const FAST: Partial<ScanJobLimits> = {
  retryDelayMs: 5,
  busyCeilingMs: 80,
  notReadyCeilingMs: 2000,
  pageIdleTimeoutMs: 300,
  pageDeadlineMs: 2000,
  deleteDeadlineMs: 300,
};

async function setup(scenario: Partial<Scenario>, overrides: Partial<ScanJobRequest> = {}) {
  const emulator = await startTestEmulator({ scenario });
  // Отпечаток запомнен: каждое соединение задания проходит сверку, включая возобновлённые.
  const transport = createTransport({
    scheme: emulator.scheme,
    host: emulator.host,
    port: emulator.port,
    basePath: emulator.basePath,
    fingerprint: emulator.fingerprint,
  });
  onTestFinished(() => {
    transport.close();
  });
  const directory = await makeTempDataRoot();
  const sink: PageSink = async ({ index, body }) => {
    await writeStreamAtomic(join(directory, `page-${index}.jpg`), body);
  };

  const run = () =>
    runScanJob({
      transport,
      basePath: emulator.basePath,
      settings: SETTINGS,
      sink,
      ...overrides,
      limits: { ...FAST, ...overrides.limits },
    });
  const files = async (): Promise<string[]> => (await readdir(directory)).sort();
  return { emulator, directory, run, files };
}

async function reportOf(job: ReturnType<typeof runScanJob>) {
  const result = await job;
  if (!result.ok) {
    throw new Error(`задание не создано: ${result.error.code}`);
  }
  return result.value;
}

const deviceError = (end: ScanJobEnd): DomainError | null =>
  end.kind === 'interrupted' && end.reason.source === 'device' ? end.reason.error : null;

const DELETE_SEEN = /^DELETE \/eSCL\/ScanJobs\/<job> (200|404)$/;

describe('задание против эмулятора: проход', () => {
  it('N страниц приходят по порядку и побайтово равны фикстурам; DELETE отправлен', async () => {
    const { emulator, directory, run, files } = await setup({ sheets: 12 });

    const report = await reportOf(run());

    expect(report.end).toEqual({ kind: 'completed' });
    expect(report.pages).toBe(12);
    expect(report.job?.closed).toBe(true);
    expect(await files()).toHaveLength(12);
    for (let number = 1; number <= 12; number += 1) {
      const written = await readFile(join(directory, `page-${number}.jpg`));
      expect(written.equals(pageFixture(number))).toBe(true);
    }
    expect(emulator.requests().at(-1)).toMatch(DELETE_SEEN);
    expect(emulator.receivedSettings).toEqual([SETTINGS]);
  });

  it('404 на первой странице даёт «пусто»; DELETE отправлен', async () => {
    const { emulator, run, files } = await setup({ sheets: 0 });

    const report = await reportOf(run());

    expect(report.end).toEqual({ kind: 'empty' });
    expect(report.pages).toBe(0);
    expect(await files()).toEqual([]);
    expect(emulator.requests().slice(-2)).toEqual([
      'GET /eSCL/ScanJobs/<job>/NextDocument 404',
      'DELETE /eSCL/ScanJobs/<job> 404',
    ]);
  });

  it('следующая страница не запрашивается, пока приёмник не завершил запись', async () => {
    const seen: number[][] = [];
    const { emulator, run } = await setup(
      { sheets: 3 },
      {
        sink: async ({ body }) => {
          const before = emulator.exchanges.length;
          let bytes = 0;
          for await (const chunk of body) {
            bytes += chunk.byteLength;
          }
          expect(bytes).toBeGreaterThan(0);
          await delay(40);
          seen.push([before, emulator.exchanges.length]);
        },
      },
    );

    const report = await reportOf(run());

    expect(report.pages).toBe(3);
    expect(seen).toHaveLength(3);
    // Пока приёмник занят страницей, к устройству не ушло ни одного запроса.
    for (const [before, after] of seen) {
      expect(after).toBe(before);
    }
  });

  it.each(['path', 'relative', 'foreign-host', 'http-scheme'] as const)(
    'Location в форме «%s» приводится к пути под базой: задание проходит',
    async (location) => {
      const { emulator, run } = await setup({ sheets: 1, location });

      const report = await reportOf(run());

      expect(report.end).toEqual({ kind: 'completed' });
      expect(report.job).toEqual({ path: emulator.jobs()[0]?.path, closed: true });
    },
  );

  it.each(['outside', 'traversal', 'missing'] as const)(
    'Location в форме «%s» негоден: задание найдено по статусу и закрыто',
    async (location) => {
      const { emulator, run, files } = await setup({ sheets: 2, location });

      const report = await reportOf(run());

      expect(deviceError(report.end)?.details).toEqual({ reason: 'location' });
      expect(report.job).toEqual({ path: emulator.jobs()[0]?.path, closed: true });
      expect(emulator.jobs()[0]?.state).toBe('Canceled');
      expect(await files()).toEqual([]);
    },
  );
});

describe('задание против эмулятора: занятость и отмена', () => {
  it('занятость, затем успех: задание проходит, вызывающий видит ожидание', async () => {
    const phases: string[] = [];
    const { run } = await setup(
      { sheets: 2, busyPosts: 3 },
      { onPhase: (phase) => phases.push(phase) },
    );

    const report = await reportOf(run());

    expect(report.end).toEqual({ kind: 'completed' });
    expect(report.pages).toBe(2);
    expect(phases).toEqual(['busy', 'scanning']);
  });

  it('занятость без конца заканчивается отказом «занят» после потолка ожидания', async () => {
    const { emulator, run } = await setup({ busyPosts: Infinity });

    const result = await run();

    expect(result.ok ? null : result.error.code).toBe('scannerBusy');
    expect(emulator.jobs()).toEqual([]);
    expect(emulator.requests().every((it) => it === 'POST /eSCL/ScanJobs 503')).toBe(true);
  });

  it('параметры, которых устройство не берёт, — отказ без задания', async () => {
    const { emulator, run } = await setup({ rejectSettings: true });

    const result = await run();

    expect(result.ok ? null : result.error.code).toBe('scanParamsRejected');
    expect(emulator.requests()).toEqual(['POST /eSCL/ScanJobs 409']);
  });

  it('отмена во время ожидания занятости не создаёт задания', async () => {
    const controller = new AbortController();
    const { emulator, run } = await setup(
      { busyPosts: Infinity },
      {
        signal: controller.signal,
        limits: { retryDelayMs: 50, busyCeilingMs: 10_000 },
        onPhase: () => {
          setTimeout(() => {
            controller.abort();
          }, 20);
        },
      },
    );

    const report = await reportOf(run());

    expect(report).toEqual({ end: { kind: 'canceled' }, pages: 0, job: null });
    expect(emulator.jobs()).toEqual([]);
  });

  it('отмена во время страницы: недописанной страницы нет, задание закрыто ответом 200', async () => {
    const controller = new AbortController();
    const { emulator, run, files } = await setup(
      { sheets: 5, fault: { sheet: 2, kind: 'stall' } },
      { signal: controller.signal, limits: { pageIdleTimeoutMs: 5000 } },
    );
    setTimeout(() => {
      controller.abort();
    }, 150);

    const report = await reportOf(run());

    expect(report.end).toEqual({ kind: 'canceled' });
    expect(report.pages).toBe(1);
    expect(await files()).toEqual(['page-1.jpg']);
    expect(emulator.requests().at(-1)).toBe('DELETE /eSCL/ScanJobs/<job> 200');
    expect(emulator.jobs()[0]?.state).toBe('Canceled');
  });
});

describe('задание против эмулятора: обрыв', () => {
  async function interrupted(scenario: Partial<Scenario>, limits: Partial<ScanJobLimits> = {}) {
    const context = await setup(scenario, { limits });
    const report = await reportOf(context.run());
    expect(report.end.kind).toBe('interrupted');
    // Ни недописанной страницы с конечным именем, ни временного файла.
    const names = await context.files();
    expect(names).toEqual(
      Array.from({ length: report.pages }, (_, index) => `page-${index + 1}.jpg`),
    );
    expect(context.emulator.requests().at(-1)).toMatch(DELETE_SEEN);
    return { ...context, report, error: deviceError(report.end) };
  }

  it('сбой подачи между страницами (410): прервано с числом целых страниц', async () => {
    const { report, error } = await interrupted({
      sheets: 5,
      fault: { sheet: 3, kind: 'gone' },
    });

    expect(report.pages).toBe(2);
    expect(error).toEqual({ code: 'scanFeedFailed', details: { reason: 'gone' } });
    expect(report.job?.closed).toBe(true);
  });

  it('соединение закрыто без ответа на первой странице', async () => {
    const { report, error } = await interrupted({
      fault: { sheet: 1, kind: 'reset-before-headers' },
    });

    expect(report.pages).toBe(0);
    expect(error?.code).toBe('scannerUnreachable');
  });

  it('обрыв посреди тела: недописанная страница в приёмник целой не попадает', async () => {
    const { report, error } = await interrupted({
      sheets: 4,
      fault: { sheet: 3, kind: 'reset-mid-body' },
    });

    expect(report.pages).toBe(2);
    expect(error?.code).toBe('scannerUnreachable');
  });

  it('тишина дольше таймаута', async () => {
    const { report, error } = await interrupted(
      { sheets: 3, fault: { sheet: 2, kind: 'stall' } },
      { pageIdleTimeoutMs: 100 },
    );

    expect(report.pages).toBe(1);
    expect(error).toEqual({ code: 'scannerUnreachable', details: { reason: 'timeout' } });
  });

  it('тело по байту упирается в общий срок приёма страницы', async () => {
    const { report, error } = await interrupted(
      { fault: { sheet: 1, kind: 'drip' }, dripIntervalMs: 10 },
      { pageIdleTimeoutMs: 5000, pageDeadlineMs: 150 },
    );

    expect(report.pages).toBe(0);
    expect(error).toEqual({ code: 'scannerUnreachable', details: { reason: 'timeout' } });
  });

  it('страница больше потолка', async () => {
    const { report, error } = await interrupted(
      { fault: { sheet: 1, kind: 'oversize' }, oversizeBytes: 400_000 },
      { maxPageBytes: 100_000 },
    );

    expect(report.pages).toBe(0);
    expect(error).toEqual({ code: 'scannerBadResponse', details: { reason: 'tooLarge' } });
  });

  it('бесконечные страницы упираются в потолок числа страниц задания', async () => {
    const { report, error, emulator } = await interrupted({ sheets: Infinity }, { maxPages: 4 });

    expect(report.pages).toBe(4);
    expect(error).toEqual({ code: 'scannerBadResponse', details: { reason: 'tooManyPages' } });
    // Идущее задание закрыто нами: `200`, а не `404`.
    expect(emulator.requests().at(-1)).toBe('DELETE /eSCL/ScanJobs/<job> 200');
  });

  // Тело короче и длиннее `Content-Length`, тело, оборванное закрытием соединения, тело не JPEG,
  // пустой ответ `200`.
  it.each(['length-longer', 'length-shorter', 'close-mid-body', 'not-jpeg', 'empty'] as const)(
    'сбой «%s»: прервано, страницей не становится',
    async (kind) => {
      const { report } = await interrupted({ sheets: 3, fault: { sheet: 2, kind } });

      expect(report.pages).toBe(1);
    },
  );

  it('точные причины: оборванное закрытием — не JPEG, пустое тело — пустая страница', async () => {
    const closed = await interrupted({ fault: { sheet: 1, kind: 'close-mid-body' } });
    const notJpeg = await interrupted({ fault: { sheet: 1, kind: 'not-jpeg' } });
    const empty = await interrupted({ fault: { sheet: 1, kind: 'empty' } });

    expect(closed.error?.details).toEqual({ reason: 'notJpeg' });
    expect(notJpeg.error?.details).toEqual({ reason: 'notJpeg' });
    expect(empty.error?.details).toEqual({ reason: 'emptyPage' });
  });

  it('серия 503 дольше потолка — прервано', async () => {
    const { report, error } = await interrupted(
      { sheets: 2, notReady: { betweenPages: 1000, beforeEnd: 4 } },
      { notReadyCeilingMs: 60 },
    );

    expect(report.pages).toBe(1);
    expect(error).toEqual({ code: 'scanFeedFailed', details: { reason: 'notReady' } });
  });
});

describe('задание против эмулятора: закрытие', () => {
  it('молчащий DELETE возвращает незакрытый адрес', async () => {
    const { emulator, run } = await setup({ sheets: 1, deleteHangs: true });

    const report = await reportOf(run());

    expect(report.end).toEqual({ kind: 'completed' });
    expect(report.job).toEqual({ path: emulator.jobs()[0]?.path, closed: false });
    expect(emulator.requests().at(-1)).toBe('DELETE /eSCL/ScanJobs/<job> нет ответа');
  });

  it('после обрыва лист остаётся в лотке: следующее задание продолжает с него', async () => {
    const { emulator, directory, run } = await setup({
      sheets: 5,
      fault: { sheet: 3, kind: 'gone' },
    });
    const first = await reportOf(run());
    emulator.clearJam();

    const second = await reportOf(
      runScanJob({
        transport: createTransportFor(emulator),
        basePath: emulator.basePath,
        settings: SETTINGS,
        limits: FAST,
        sink: async ({ index, body }) => {
          await writeStreamAtomic(join(directory, `resumed-${index}.jpg`), body);
        },
      }),
    );

    expect(first.pages).toBe(2);
    expect(second.end).toEqual({ kind: 'completed' });
    expect(second.pages).toBe(3);
    const resumed = await readFile(join(directory, 'resumed-1.jpg'));
    expect(resumed.equals(pageFixture(3))).toBe(true);
  });
});

function createTransportFor(emulator: Awaited<ReturnType<typeof startTestEmulator>>) {
  const transport = createTransport({
    scheme: emulator.scheme,
    host: emulator.host,
    port: emulator.port,
    basePath: emulator.basePath,
    fingerprint: emulator.fingerprint,
  });
  onTestFinished(() => {
    transport.close();
  });
  return transport;
}
