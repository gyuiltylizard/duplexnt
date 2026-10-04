// Зачистка сырых ответов eSCL перед тем, как они станут фикстурами (план M0, U9, KTD-22; план
// M1, U1). Вход — local-test-data/device/ (вне git), выход — test/fixtures/escl/<устройство>/.
//
// Запуск из корня:
//   node spikes/sanitize-escl.mjs [устройство]            capabilities и статус в покое (M0)
//   node spikes/sanitize-escl.mjs [устройство] --traces   снимки статуса, ScanSettings и следы
//                                                         заданий из local-test-data/device/trace/
//
// Заменяется ТОЛЬКО то, что идентифицирует устройство и сеть; остальное — байт в байт, включая
// концы строк. Правила и плейсхолдеры — test/fixtures/README.md.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PLACEHOLDER_IPV4,
  PLACEHOLDER_SERIAL,
  PLACEHOLDER_UUID,
} from '../scripts/privacy-guard.ts';

const args = process.argv.slice(2);
const withTraces = args.includes('--traces');
const device = args.find((arg) => !arg.startsWith('--')) ?? 'et-3850';
const RAW = resolve('local-test-data/device');
const OUT = resolve('test/fixtures/escl', device);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function sanitize(xml, { keepJobs = false } = {}) {
  const report = [];
  const replace = (pattern, replacement, label) => {
    let count = 0;
    // Замена — всегда функция от групп: строка с `$1` внутри колбэка не раскрывается.
    xml = xml.replace(pattern, (_match, ...groups) => {
      count += 1;
      return replacement(groups);
    });
    report.push(`${label}: ${count}`);
  };

  if (keepJobs) {
    // Снимок статуса во время задания: секция заданий нужна, UUID заданий — нет. Все задания
    // получают один плейсхолдер: другого страж в фикстурах не пропускает.
    replace(
      /(<pwg:JobUuid>)[^<]*(<\/pwg:JobUuid>)/g,
      ([open, close]) => `${open}${PLACEHOLDER_UUID}${close}`,
      'UUID заданий',
    );
    replace(
      /(<pwg:JobUri>[^<]*\/)[^</]+(<\/pwg:JobUri>)/g,
      ([open, close]) => `${open}${PLACEHOLDER_UUID}${close}`,
      'UUID в адресах заданий',
    );
  } else {
    // Секция заданий — история конкретного устройства с UUID заданий: вырезается целиком,
    // вместе с отступом и переводом строки перед ней.
    replace(/[ \t]*<scan:Jobs>[\s\S]*?<\/scan:Jobs>\r?\n?/g, () => '', 'секций заданий вырезано');
  }
  replace(
    /(<scan:UUID>)[^<]*(<\/scan:UUID>)/g,
    ([open, close]) => `${open}${PLACEHOLDER_UUID}${close}`,
    'UUID устройства',
  );
  replace(
    /(<pwg:SerialNumber>)[^<]*(<\/pwg:SerialNumber>)/g,
    ([open, close]) => `${open}${PLACEHOLDER_SERIAL}${close}`,
    'серийный номер',
  );
  // Хост во ВСЕХ URI ответа: административная ссылка, иконка и любые другие.
  replace(
    /(<(?:\w+:)?\w*UR[IL]\w*>\s*https?:\/\/)[^/<\s]+/gi,
    ([prefix]) => `${prefix}${PLACEHOLDER_IPV4}`,
    'хост в URI',
  );
  return { xml, report };
}

/** Последняя страховка: в готовой фикстуре не осталось UUID, кроме плейсхолдера. */
function assertNoForeignUuid(text, name) {
  const foreign = (text.match(UUID) ?? []).filter(
    (uuid) => uuid.toLowerCase() !== PLACEHOLDER_UUID,
  );
  if (foreign.length > 0)
    throw new Error(`${name}: остался UUID устройства (${foreign.length} шт.)`);
}

// --- Capabilities и статус в покое (M0) -------------------------------------------------------

function sanitizeResources() {
  for (const name of ['ScannerCapabilities.xml', 'ScannerStatus.xml']) {
    // latin1 сохраняет байты один к одному: содержимое вне заменяемых мест не перекодируется.
    const { xml, report } = sanitize(readFileSync(join(RAW, name), 'latin1'));
    writeFileSync(join(OUT, name), xml, 'latin1');
    console.log(`${name} → ${report.join('; ')}`);
  }
}

// --- Следы заданий (M1, U1) -------------------------------------------------------------------

const TRACE_ROOT = join(RAW, 'trace');

/** Каталог следа по метке: `<время>-<метка>`, из нескольких берётся последний. */
function traceDir(label) {
  const found = readdirSync(TRACE_ROOT)
    .filter((name) => name.endsWith(`-${label}`))
    .sort()
    .pop();
  if (!found) throw new Error(`Нет следа с меткой «${label}» в ${TRACE_ROOT}`);
  return join(TRACE_ROOT, found);
}

const readTrace = (label) => JSON.parse(readFileSync(join(traceDir(label), 'trace.json'), 'utf8'));

// Снимки статуса: имя фикстуры ← метка следа, метка обмена внутри него.
const STATUS_SNAPSHOTS = [
  ['ScannerStatus.adf-loaded.xml', 'calib-x35', 'status-before'],
  ['ScannerStatus.job-processing.xml', 'calib-x35', 'status-after-page-1'],
  ['ScannerStatus.job-completed.xml', 'calib-x35', 'status-after-terminal'],
  ['ScannerStatus.adf-jam.xml', 'cover-open', 'status-after-terminal'],
  ['ScannerStatus.busy-printing.xml', 'busy-print', 'status-before'],
];

// Тело запроса, на которое устройство ответило 201: имя фикстуры ← метка следа.
const SCAN_SETTINGS = [['ScanSettings.a4-gray-300.xml', 'calib-x35']];

// Следы сценариев: имя фикстуры ← метка следа, что в нём снято.
const TRACES = [
  ['pass-three-pages', 'calib-x35', 'Проход на три листа: серый, 300 dpi, A4 со смещением 35.'],
  ['empty-tray', 'empty', 'Задание при пустом лотке.'],
  [
    'busy-printing',
    'busy-print',
    'POST во время печати: 503 до конца печати, затем обычный проход.',
  ],
  ['delete-mid-job', 'delete-mid', 'DELETE после первой страницы из трёх.'],
  [
    'feed-failure-between-pages',
    'cover-open',
    'Сбой подачи на втором листе (открыта крышка автоподачи): 503, затем 410.',
  ],
  [
    'feed-failure-during-page',
    'hold-sheet',
    'Сбой подачи на первом листе, запрос страницы уже висел: соединение закрыто без ответа.',
  ],
  [
    'abandoned-job',
    'abandon-mid',
    'Задание брошено после первой страницы без DELETE: три минуты 503 на новый POST, затем DELETE.',
  ],
  ['settings-rejected', 'bw-empty', 'BlackAndWhite1 с image/jpeg: 409 на POST.'],
];

const maskText = (text) =>
  String(text)
    .replace(UUID, () => PLACEHOLDER_UUID)
    .replace(/(https?:\/\/)[^/:\s]+/gi, (_match, scheme) => `${scheme}${PLACEHOLDER_IPV4}`);

function sanitizeTrace(trace, description) {
  const pages = new Map(trace.pages.map((page) => [page.exchange, page]));
  const exchanges = trace.exchanges
    // Опрос «жду бумагу» — шум ожидания автора, а не поведение задания.
    .filter((exchange) => !exchange.label.includes('wait-loaded'))
    .map((exchange) => {
      // Имена заголовков — в том регистре, в каком их прислало устройство.
      const headers = {};
      for (let i = 0; i < (exchange.rawHeaders ?? []).length; i += 2) {
        headers[exchange.rawHeaders[i]] = maskText(exchange.rawHeaders[i + 1]);
      }
      const entry = {
        label: exchange.label,
        atMs: exchange.sinceRunStartMs,
        method: exchange.method,
        path: maskText(exchange.path),
        requestBytes: exchange.requestBytes,
        status: exchange.status ?? null,
        statusMessage: exchange.statusMessage ?? null,
        headers,
        bodyBytes: exchange.bytes,
        chunks: exchange.chunks ?? 0,
        headersAtMs: exchange.headersAtMs ?? null,
        totalMs: exchange.totalMs,
        error: exchange.error?.code ?? null,
      };
      const summary = exchange.statusSummary;
      if (summary) {
        entry.scannerStatus = {
          state: summary.state,
          adfState: summary.adf,
          jobs: summary.jobs.map((job) => ({
            jobState: job.JobState,
            imagesCompleted: Number(job.ImagesCompleted),
            age: Number(job.Age),
          })),
        };
      }
      const page = pages.get(exchange.index);
      if (page) {
        entry.page = {
          head: page.head,
          startsWithSoi: page.startsWithSoi,
          endsWithEoi: page.endsWithEoi,
          bytesAfterLastEoi: page.bytesAfterLastEoi,
          markers: page.segments.map((segment) => segment.marker),
          jfif: page.segments.find((segment) => segment.jfif)?.jfif ?? null,
          sof: page.sof ?? null,
          expected: page.expected,
          restartMarkers: page.restartMarkers ?? 0,
          chromaSubsampling: page.sharp?.chromaSubsampling ?? null,
        };
      }
      return entry;
    });

  // Время считается от первого оставшегося обмена: ожидание бумаги в след не входит.
  const origin = exchanges[0]?.atMs ?? 0;
  for (const exchange of exchanges) exchange.atMs -= origin;

  const { dpi, mode, xoffset, yoffset, width, height } = trace.options;
  return {
    device,
    description,
    scenario: trace.scenario,
    settings: {
      colorMode: mode,
      resolution: Number(dpi),
      region: {
        xOffset: Number(xoffset),
        yOffset: Number(yoffset),
        width: Number(width),
        height: Number(height),
      },
    },
    exchanges,
  };
}

function sanitizeTraces() {
  for (const [name, label, exchangeLabel] of STATUS_SNAPSHOTS) {
    const trace = readTrace(label);
    const exchange = trace.exchanges.find((entry) => entry.label === exchangeLabel);
    if (!exchange?.bodyFile)
      throw new Error(`${name}: в следе «${label}» нет обмена ${exchangeLabel}`);
    const raw = readFileSync(join(traceDir(label), exchange.bodyFile), 'latin1');
    const { xml, report } = sanitize(raw, { keepJobs: true });
    assertNoForeignUuid(xml, name);
    writeFileSync(join(OUT, name), xml, 'latin1');
    console.log(`${name} ← ${label}/${exchangeLabel} → ${report.join('; ')}`);
  }

  for (const [name, label] of SCAN_SETTINGS) {
    const post = readTrace(label).exchanges.find((entry) => entry.method === 'POST');
    if (post?.status !== 201) throw new Error(`${name}: POST в следе «${label}» не получил 201`);
    // Наш собственный запрос: идентификаторов устройства в нём нет, копируется байт в байт.
    const body = readFileSync(join(traceDir(label), 'ScanSettings.xml'), 'latin1');
    assertNoForeignUuid(body, name);
    writeFileSync(join(OUT, name), body, 'latin1');
    console.log(`${name} ← ${label} (ответ 201)`);
  }

  mkdirSync(join(OUT, 'traces'), { recursive: true });
  for (const [name, label, description] of TRACES) {
    const json = `${JSON.stringify(sanitizeTrace(readTrace(label), description), null, 2)}\n`;
    assertNoForeignUuid(json, name);
    writeFileSync(join(OUT, 'traces', `${name}.json`), json);
    console.log(`traces/${name}.json ← ${label}`);
  }
}

mkdirSync(OUT, { recursive: true });
if (withTraces) sanitizeTraces();
else sanitizeResources();
console.log('Дальше: node scripts/privacy-guard.ts — страж обязан быть зелёным.');
