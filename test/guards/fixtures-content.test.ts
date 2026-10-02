import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_IPV4,
  PLACEHOLDER_SERIAL,
  PLACEHOLDER_UUID,
  scanText,
} from '../../scripts/privacy-guard';

// Разбор XML — дело M1; здесь фикстуры проверяются по тексту, парсер не нужен.
const DIR = 'test/fixtures/escl/et-3850';
const read = (name: string): string => readFileSync(resolve(DIR, name), 'utf8');

const tagValues = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((match) => match[1] ?? '');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const foreignUuids = (text: string): string[] =>
  (text.match(UUID) ?? []).filter((uuid) => uuid.toLowerCase() !== PLACEHOLDER_UUID);

describe('ScannerCapabilities ET-3850', () => {
  const xml = read('ScannerCapabilities.xml');

  it('UUID и серийный номер — плейсхолдеры', () => {
    expect(tagValues(xml, 'scan:UUID')).toEqual([PLACEHOLDER_UUID]);
    expect(tagValues(xml, 'pwg:SerialNumber')).toEqual([PLACEHOLDER_SERIAL]);
  });

  it('хост во всех URI — плейсхолдер, включая административную ссылку и иконку', () => {
    const uris = [...xml.matchAll(/<(?:\w+:)?\w*UR[IL]\w*>\s*(https?:\/\/[^<]+)</gi)].map(
      (match) => new URL(match[1] ?? '').hostname,
    );

    expect(uris.length).toBeGreaterThanOrEqual(2);
    expect(new Set(uris)).toEqual(new Set([PLACEHOLDER_IPV4]));
  });

  it('зачистка не съела содержимое', () => {
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<scan:AdfSimplexInputCaps>');
    expect(xml).toContain('<scan:PlatenInputCaps>');
    expect(xml).toContain('<pwg:MakeAndModel>EPSON ET-3850 Series</pwg:MakeAndModel>');
    expect(xml.trimEnd().endsWith('</scan:ScannerCapabilities>')).toBe(true);
    // Следы неудачной подстановки групп регулярного выражения.
    expect(xml).not.toMatch(/\$\d/);
  });

  it('страж не находит в ней идентификаторов', () => {
    expect(scanText(xml, `${DIR}/ScannerCapabilities.xml`)).toEqual([]);
  });
});

describe('ScannerStatus ET-3850', () => {
  const xml = read('ScannerStatus.xml');

  it('снят в покое, секции заданий нет', () => {
    expect(tagValues(xml, 'pwg:State')).toEqual(['Idle']);
    expect(xml).not.toContain('Jobs');
    expect(xml).not.toContain('JobUuid');
  });

  it('ни одного неплейсхолдерного идентификатора', () => {
    expect(scanText(xml, `${DIR}/ScannerStatus.xml`)).toEqual([]);
    expect(xml.trimEnd().endsWith('</scan:ScannerStatus>')).toBe(true);
  });
});

describe('снимки ScannerStatus в состояниях задания (M1, U1)', () => {
  it.each([
    ['ScannerStatus.adf-loaded.xml', 'Idle', 'ScannerAdfLoaded'],
    ['ScannerStatus.job-processing.xml', 'Processing', 'ScannerAdfProcessing'],
    ['ScannerStatus.job-completed.xml', 'Processing', 'ScannerAdfEmpty'],
    ['ScannerStatus.adf-jam.xml', 'Processing', 'ScannerAdfJam'],
    ['ScannerStatus.busy-printing.xml', 'Processing', 'ScannerAdfLoaded'],
  ])('%s: устройство %s, лоток %s', (name, state, adfState) => {
    const xml = read(name);

    expect(tagValues(xml, 'pwg:State')).toEqual([state]);
    expect(tagValues(xml, 'scan:AdfState')).toEqual([adfState]);
  });

  it.each([
    'ScannerStatus.adf-loaded.xml',
    'ScannerStatus.job-processing.xml',
    'ScannerStatus.job-completed.xml',
    'ScannerStatus.adf-jam.xml',
    'ScannerStatus.busy-printing.xml',
  ])('%s: секция заданий на месте, UUID заданий — плейсхолдеры, разметка цела', (name) => {
    const xml = read(name);
    const uuids = tagValues(xml, 'pwg:JobUuid');
    const uris = tagValues(xml, 'pwg:JobUri');

    expect(uuids.length).toBeGreaterThan(0);
    expect(new Set(uuids)).toEqual(new Set([PLACEHOLDER_UUID]));
    expect(new Set(uris)).toEqual(new Set([`/eSCL/ScanJobs/${PLACEHOLDER_UUID}`]));
    expect(tagValues(xml, 'pwg:JobState')).toHaveLength(uuids.length);
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml.trimEnd().endsWith('</scan:ScannerStatus>')).toBe(true);
    expect(xml).not.toMatch(/\$\d/);
    expect(scanText(xml, `${DIR}/${name}`)).toEqual([]);
  });

  it('состояния задания в снимках — те, что названы в имени файла', () => {
    expect(tagValues(read('ScannerStatus.job-processing.xml'), 'pwg:JobState')[0]).toBe(
      'Processing',
    );
    expect(tagValues(read('ScannerStatus.job-completed.xml'), 'pwg:JobState')[0]).toBe('Completed');
    expect(tagValues(read('ScannerStatus.adf-jam.xml'), 'pwg:JobState')[0]).toBe('Aborted');
    // Печать: устройство занято, но ни одно задание сканирования не идёт.
    expect(tagValues(read('ScannerStatus.busy-printing.xml'), 'pwg:JobState')).not.toContain(
      'Processing',
    );
  });
});

describe('ScanSettings, принятый устройством (M1, U1)', () => {
  const xml = read('ScanSettings.a4-gray-300.xml');

  it('несёт автоподачу, JPEG и регион A4 в 1/300 дюйма', () => {
    expect(tagValues(xml, 'pwg:InputSource')).toEqual(['Feeder']);
    expect(tagValues(xml, 'pwg:DocumentFormat')).toEqual(['image/jpeg']);
    expect(tagValues(xml, 'scan:ColorMode')).toEqual(['Grayscale8']);
    expect(tagValues(xml, 'scan:XResolution')).toEqual(['300']);
    expect(tagValues(xml, 'pwg:Width')).toEqual(['2480']);
    expect(tagValues(xml, 'pwg:Height')).toEqual(['3507']);
    expect(tagValues(xml, 'pwg:XOffset')).toEqual(['35']);
    expect(scanText(xml, `${DIR}/ScanSettings.a4-gray-300.xml`)).toEqual([]);
  });
});

interface TraceExchange {
  readonly label: string;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly headers: Record<string, string>;
  readonly error: string | null;
}

interface Trace {
  readonly description: string;
  readonly exchanges: readonly TraceExchange[];
}

describe('следы заданий (M1, U1)', () => {
  const names = readdirSync(resolve(DIR, 'traces')).filter((name) => name.endsWith('.json'));
  const load = (name: string): Trace => JSON.parse(read(`traces/${name}`)) as Trace;
  const pages = (name: string): TraceExchange[] =>
    load(name).exchanges.filter((exchange) => exchange.path.endsWith('/NextDocument'));

  it('следы на месте', () => {
    expect(names.sort()).toEqual([
      'abandoned-job.json',
      'busy-printing.json',
      'delete-mid-job.json',
      'empty-tray.json',
      'feed-failure-between-pages.json',
      'feed-failure-during-page.json',
      'pass-three-pages.json',
      'settings-rejected.json',
    ]);
  });

  it.each(names)('%s: нет UUID задания устройства и адреса сканера', (name) => {
    const text = read(`traces/${name}`);
    const trace = load(name);

    expect(foreignUuids(text)).toEqual([]);
    expect(scanText(text, `${DIR}/traces/${name}`)).toEqual([]);
    expect(trace.exchanges.length).toBeGreaterThan(0);
    for (const exchange of trace.exchanges) {
      const location = exchange.headers.Location;
      if (location !== undefined) {
        expect(new URL(location).hostname).toBe(PLACEHOLDER_IPV4);
      }
    }
  });

  it('проход: три страницы, между ними 503, в конце 404', () => {
    const statuses = pages('pass-three-pages.json').map((exchange) => exchange.status);

    expect(statuses.filter((status) => status === 200)).toHaveLength(3);
    expect(statuses).toContain(503);
    expect(statuses.at(-1)).toBe(404);
  });

  it('пустой лоток: задание создано, первая страница — 404', () => {
    const trace = load('empty-tray.json');

    expect(trace.exchanges.find((exchange) => exchange.method === 'POST')?.status).toBe(201);
    expect(pages('empty-tray.json').map((exchange) => exchange.status)).toEqual([404]);
  });

  it('сбой подачи между страницами кончается 410, а не 404', () => {
    const statuses = pages('feed-failure-between-pages.json').map((exchange) => exchange.status);

    expect(statuses[0]).toBe(200);
    expect(statuses.at(-1)).toBe(410);
    expect(statuses).not.toContain(404);
  });

  it('сбой подачи при висящем запросе страницы — соединение закрыто без ответа', () => {
    const [page] = pages('feed-failure-during-page.json');

    expect(page?.status).toBeNull();
    expect(page?.error).toBe('ECONNRESET');
  });

  it('занятость печатью: 503 на POST, затем 201', () => {
    const posts = load('busy-printing.json')
      .exchanges.filter((exchange) => exchange.method === 'POST')
      .map((exchange) => exchange.status);

    expect(posts.slice(0, -1).every((status) => status === 503)).toBe(true);
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.at(-1)).toBe(201);
  });

  it('DELETE идущего задания — 200, страница после него — 410, повторный DELETE — 404', () => {
    const trace = load('delete-mid-job.json');
    const deletes = trace.exchanges.filter((exchange) => exchange.method === 'DELETE');

    expect(deletes.map((exchange) => exchange.status)).toEqual([200, 404]);
    expect(pages('delete-mid-job.json').at(-1)?.status).toBe(410);
  });

  it('брошенное задание держит устройство занятым до DELETE', () => {
    const trace = load('abandoned-job.json');
    const probes = trace.exchanges.filter((exchange) => /^probe-\d+-post/.test(exchange.label));

    expect(probes.length).toBeGreaterThan(30);
    expect(probes.every((exchange) => exchange.status === 503)).toBe(true);
    expect(trace.exchanges.find((exchange) => exchange.label === 'first-delete')?.status).toBe(200);
  });

  it('чёрно-белый режим с JPEG отклонён: 409', () => {
    const trace = load('settings-rejected.json');

    expect(trace.exchanges.find((exchange) => exchange.method === 'POST')?.status).toBe(409);
  });
});

describe('AE8: подстановка идентификатора в фикстуру ловится', () => {
  it('синтетический UUID и частный адрес дают нарушения', () => {
    const tampered = read('ScannerCapabilities.xml')
      .replace(PLACEHOLDER_UUID, '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed')
      .replace(PLACEHOLDER_IPV4, '192.168.1.50');

    const kinds = scanText(tampered, `${DIR}/ScannerCapabilities.xml`).map((v) => v.kind);
    expect(kinds).toContain('uuid');
    expect(kinds).toContain('ipv4');
  });
});
