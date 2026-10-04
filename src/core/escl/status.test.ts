import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_UUID } from '../../../scripts/privacy-guard';
import { ET_3850, readFixture, readFixtureText } from '../../../test/support/fixtures';
import { parseStatus, type ScannerStatus } from './status';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function statusOf(fixture: string): ScannerStatus {
  const result = parseStatus(readFixture(...ET_3850, fixture));
  if (!result.ok) {
    throw new Error(`не разобрано: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

const JOB_URI = `/eSCL/ScanJobs/${PLACEHOLDER_UUID}`;

describe('parseStatus: снимки ET-3850', () => {
  it('статус с пустым лотком и статус с бумагой различаются', () => {
    const empty = statusOf('ScannerStatus.xml');
    const loaded = statusOf('ScannerStatus.adf-loaded.xml');

    expect(empty).toMatchObject({ state: 'Idle', adfState: 'ScannerAdfEmpty' });
    expect(loaded).toMatchObject({ state: 'Idle', adfState: 'ScannerAdfLoaded' });
  });

  it('в покое после перезагрузки секции заданий нет — список пуст', () => {
    expect(statusOf('ScannerStatus.xml').jobs).toEqual([]);
  });

  it('идущее задание: устройство занято, задание первым в списке', () => {
    const status = statusOf('ScannerStatus.job-processing.xml');

    expect(status).toMatchObject({ state: 'Processing', adfState: 'ScannerAdfProcessing' });
    expect(status.jobs).toEqual([
      { uri: JOB_URI, state: 'Processing', imagesCompleted: 1, age: 0 },
      { uri: JOB_URI, state: 'Completed', imagesCompleted: 3, age: 33 },
    ]);
  });

  it('завершённое задание и сбой подачи', () => {
    expect(statusOf('ScannerStatus.job-completed.xml').jobs[0]?.state).toBe('Completed');

    const jam = statusOf('ScannerStatus.adf-jam.xml');
    expect(jam.adfState).toBe('ScannerAdfJam');
    expect(jam.jobs[0]?.state).toBe('Aborted');
  });

  it('занятость печатью: устройство занято, но ни одно задание сканирования не идёт', () => {
    const status = statusOf('ScannerStatus.busy-printing.xml');

    expect(status.state).toBe('Processing');
    expect(status.adfState).toBe('ScannerAdfLoaded');
    expect(status.jobs.some((job) => job.state === 'Processing')).toBe(false);
  });
});

describe('parseStatus: чужая прошивка и отказы', () => {
  const xml = readFixtureText(...ET_3850, 'ScannerStatus.job-processing.xml');

  it('другие префиксы пространств имён разбираются так же', () => {
    const renamed = xml
      .replaceAll('scan:', 'e:')
      .replaceAll('pwg:', 'p:')
      .replace('xmlns:scan=', 'xmlns:e=')
      .replace('xmlns:e:', 'xmlns:scan:')
      .replace('xmlns:pwg=', 'xmlns:p=');

    expect(renamed).toContain('<e:ScannerStatus xmlns:e=');
    expect(parseStatus(encode(renamed))).toEqual(parseStatus(encode(xml)));
  });

  it('неизвестные значения состояний дают null, а не строку устройства', () => {
    const odd = xml
      .replace('<pwg:State>Processing</pwg:State>', '<pwg:State>Dancing</pwg:State>')
      .replace('ScannerAdfProcessing', 'ScannerAdfOnFire')
      .replace('<pwg:JobState>Processing</pwg:JobState>', '<pwg:JobState>Lost</pwg:JobState>');
    const result = parseStatus(encode(odd));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state).toBeNull();
      expect(result.value.adfState).toBeNull();
      expect(result.value.jobs[0]).toEqual({
        uri: JOB_URI,
        state: null,
        imagesCompleted: 1,
        age: 0,
      });
    }
  });

  it('устройство без автоподачи не сообщает состояние лотка — null', () => {
    const noAdf = xml.replace('<scan:AdfState>ScannerAdfProcessing</scan:AdfState>', '');
    const result = parseStatus(encode(noAdf));

    expect(result.ok && result.value.adfState).toBeNull();
  });

  it('задание без адреса или со сверхдлинным адресом в список не попадает', () => {
    const noUri = xml.replace(`<pwg:JobUri>${JOB_URI}</pwg:JobUri>`, '');
    const longUri = xml.replace(JOB_URI, `/eSCL/ScanJobs/${'a'.repeat(600)}`);

    for (const text of [noUri, longUri]) {
      const result = parseStatus(encode(text));
      expect(result.ok && result.value.jobs).toHaveLength(1);
    }
  });

  it('документ не eSCL даёт код «не сканер eSCL»', () => {
    expect(parseStatus(readFixture(...ET_3850, 'ScannerCapabilities.xml'))).toEqual({
      ok: false,
      error: { code: 'notEsclScanner' },
    });
    expect(parseStatus(encode('<status><state>Idle</state></status>'))).toEqual({
      ok: false,
      error: { code: 'notEsclScanner' },
    });
  });

  it('не XML — «ответ не разобран»', () => {
    expect(parseStatus(encode('503 Service Unavailable'))).toEqual({
      ok: false,
      error: { code: 'scannerBadResponse', details: { reason: 'malformed' } },
    });
  });
});
