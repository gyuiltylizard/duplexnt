// Съёмка M1, U1: живой след задания автоподачи. Ведёт НАСТОЯЩЕЕ задание eSCL и записывает каждый
// обмен — запрос, статус, заголовки, времена, тело — чтобы клиент M1 писался по наблюдённому, а
// не по документам (план M1, KTD-1). Одноразовый код: не рефакторится, тестами не покрывается.
//
// Запуск из корня:  node spikes/escl-job-trace.mjs <адрес> <сценарий> [--ключ значение …]
// Сценарии и ключи — spikes/README.md.
//
// Приватность. Адрес приходит аргументом или из DUPLEXNT_SCANNER_HOST — в файле его нет. Сырое
// пишется в local-test-data/device/trace/ (вне git). UUID заданий, которые отдаёт устройство,
// скрипт сам дописывает в local-test-data/privacy-values.txt — раньше, чем о них можно написать
// хоть строку журнала. В stdout адрес и UUID заменены метками.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join, resolve } from 'node:path';
import { setImmediate as yieldNow, setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    label: { type: 'string' },
    // Параметры задания. Регион — в 1/300 дюйма; по умолчанию A4 от нулевого смещения.
    dpi: { type: 'string', default: '300' },
    mode: { type: 'string', default: 'Grayscale8' },
    xoffset: { type: 'string', default: '0' },
    yoffset: { type: 'string', default: '0' },
    width: { type: 'string', default: '2480' },
    height: { type: 'string', default: '3507' },
    intent: { type: 'string' },
    'escl-version': { type: 'string', default: '2.9' }, // версия из capabilities ET-3850
    // Ход задания.
    'wait-loaded': { type: 'boolean', default: false },
    'wait-limit': { type: 'string', default: '300' },
    pause: { type: 'string', default: '0' },
    'max-pages': { type: 'string' },
    'delete-after': { type: 'string' },
    'busy-wait': { type: 'string', default: '60' },
    'page-timeout': { type: 'string', default: '180' },
    'probe-interval': { type: 'string', default: '5' },
    'probe-limit': { type: 'string', default: '180' },
    // Нагрузка на цикл событий (M6, U1, A/B «зависит ли остановка подачи от хоста»): CPU-кусками
    // по столько миллисекунд с уступкой между ними — как измерение и ресэмплер в main.
    load: { type: 'string', default: '0' },
    // Соединение.
    keepalive: { type: 'boolean', default: false },
    scheme: { type: 'string', default: 'https' },
    port: { type: 'string' },
    base: { type: 'string', default: '/eSCL' },
    // Проверка самого скрипта на локальной заглушке: вывод и список значений уходят сюда.
    out: { type: 'string' },
  },
});

const [hostArgument = process.env.DUPLEXNT_SCANNER_HOST, scenario = 'job'] = positionals;
if (!hostArgument) {
  console.error('Нужен адрес сканера: аргументом или в DUPLEXNT_SCANNER_HOST');
  process.exit(2);
}
const [host, portFromHost] = hostArgument.split(':');
const port = Number(options.port ?? portFromHost ?? (options.scheme === 'https' ? 443 : 80));
const base = options.base.replace(/\/+$/, '');
const number = (name) => Number(options[name]);

const label = options.label ?? scenario;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const outRoot = options.out ? resolve(options.out) : resolve('local-test-data/device/trace');
const dir = join(outRoot, `${stamp}-${label}`);
const valuesFile = options.out
  ? join(outRoot, 'privacy-values.txt')
  : resolve('local-test-data/privacy-values.txt');
mkdirSync(dir, { recursive: true });

// --- Транспорт: агент приватен и привязан к одному origin (план M0, KTD-20) ------------------

const transport = options.scheme === 'https' ? https : http;
const agent =
  options.scheme === 'https'
    ? new https.Agent({ rejectUnauthorized: false, keepAlive: options.keepalive })
    : new http.Agent({ keepAlive: options.keepalive });

// --- След ------------------------------------------------------------------------------------

const runStart = performance.now();
const trace = {
  scenario,
  label,
  startedAt: new Date().toISOString(),
  options,
  versions: { node: process.versions.node, openssl: process.versions.openssl },
  exchanges: [],
  pages: [],
  notes: [],
};
const writeTrace = () => writeFileSync(join(dir, 'trace.json'), JSON.stringify(trace, null, 2));

// --- Приватность: список значений и метки для stdout -----------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const knownValues = new Set(
  existsSync(valuesFile)
    ? readFileSync(valuesFile, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
    : [],
);
const aliases = new Map();
let valuesHeaderWritten = false;

function harvest(text) {
  for (const [match] of text.matchAll(UUID)) {
    const uuid = match.toLowerCase();
    if (!aliases.has(uuid)) aliases.set(uuid, `<uuid-${aliases.size + 1}>`);
    if (knownValues.has(uuid)) continue;
    knownValues.add(uuid);
    if (!valuesHeaderWritten) {
      valuesHeaderWritten = true;
      const needsNewline =
        existsSync(valuesFile) && !readFileSync(valuesFile, 'utf8').endsWith('\n');
      appendFileSync(
        valuesFile,
        `${needsNewline ? '\n' : ''}\n# UUID заданий из следа U1 (spikes/escl-job-trace.mjs), ${stamp} ${label}\n`,
      );
    }
    appendFileSync(valuesFile, `${uuid}\n`);
  }
}

const mask = (text) =>
  String(text)
    .replaceAll(host, '<сканер>')
    .replace(UUID, (uuid) => aliases.get(uuid.toLowerCase()) ?? '<uuid-?>');

function note(text) {
  trace.notes.push({ sinceRunStartMs: Math.round(performance.now() - runStart), text });
  writeTrace();
  console.log(`\n== ${text}`);
}

// --- Один обмен ------------------------------------------------------------------------------

function extensionOf(payload) {
  if (payload[0] === 0xff && payload[1] === 0xd8) return 'jpg';
  if (payload.subarray(0, 64).toString('latin1').trimStart().startsWith('<')) return 'xml';
  return 'bin';
}

function printExchange(record) {
  const outcome = record.status
    ? `${record.status} ${record.statusMessage} (HTTP/${record.httpVersion})`
    : 'ответа нет';
  const timing = [
    record.reusedSocket ? 'соединение прежнее' : null,
    record.connectAtMs === undefined ? null : `TCP ${record.connectAtMs} мс`,
    record.tlsAtMs === undefined
      ? null
      : `TLS ${record.tlsAtMs} мс${record.tls?.sessionReused ? ' (сессия возобновлена)' : ''}`,
    record.headersAtMs === undefined ? null : `заголовки ${record.headersAtMs} мс`,
    record.firstByteAtMs === undefined ? null : `первый байт ${record.firstByteAtMs} мс`,
    `всё ${record.totalMs} мс`,
  ].filter(Boolean);
  const index = String(record.index).padStart(2, '0');
  console.log(`#${index} ${record.label}: ${record.method} ${mask(record.path)} → ${outcome}`);
  console.log(`     ${timing.join(' · ')} · ${record.bytes} байт в ${record.chunks ?? 0} кусках`);
  if (record.rawHeaders) {
    const pairs = [];
    for (let i = 0; i < record.rawHeaders.length; i += 2) {
      pairs.push(`${record.rawHeaders[i]}: ${mask(record.rawHeaders[i + 1])}`);
    }
    console.log(`     ${pairs.join(' | ') || 'заголовков нет'}`);
  }
  if (record.error) {
    console.log(`     ОШИБКА ${record.error.code ?? ''} ${mask(record.error.message)}`);
  }
  if (record.complete === false) console.log('     тело оборвано: ответ не дочитан до конца');
}

function exchange(exchangeLabel, method, path, settings = {}) {
  const { body = null, headers = {}, timeoutMs = 30_000, quiet = false } = settings;
  const record = {
    index: trace.exchanges.length + 1,
    label: exchangeLabel,
    method,
    path,
    wallClock: new Date().toISOString(),
    sinceRunStartMs: Math.round(performance.now() - runStart),
    requestHeaders: headers,
    requestBytes: body === null ? 0 : Buffer.byteLength(body),
  };
  trace.exchanges.push(record);

  return new Promise((done) => {
    const started = performance.now();
    const since = () => Math.round(performance.now() - started);
    const chunks = [];
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      const payload = Buffer.concat(chunks);
      record.totalMs = since();
      record.bytes = payload.length;
      if (error) record.error = { code: error.code ?? null, message: error.message };
      harvest(`${path}\n${(record.rawHeaders ?? []).join('\n')}`);
      if (payload.length > 0) {
        const extension = extensionOf(payload);
        if (extension === 'xml') harvest(payload.toString('utf8'));
        record.bodyFile = `${String(record.index).padStart(2, '0')}-${exchangeLabel}.${extension}`;
        writeFileSync(join(dir, record.bodyFile), payload);
      }
      writeTrace();
      if (!quiet) printExchange(record);
      done({ record, body: payload, status: record.status ?? null, headers: record.headers ?? {} });
    };

    const request = transport.request(
      { host, port, path, method, headers, agent, timeout: timeoutMs },
      (response) => {
        record.status = response.statusCode;
        record.statusMessage = response.statusMessage;
        record.httpVersion = response.httpVersion;
        record.rawHeaders = response.rawHeaders;
        record.headers = response.headers;
        record.headersAtMs = since();
        response.on('data', (chunk) => {
          if (chunks.length === 0) record.firstByteAtMs = since();
          chunks.push(chunk);
          record.chunks = chunks.length;
        });
        response.on('end', () => {
          record.complete = response.complete;
          finish(null);
        });
        response.on('error', finish);
        response.on('close', () => {
          record.complete = response.complete;
          finish(response.complete ? null : new Error('CLOSED_BEFORE_END'));
        });
      },
    );
    request.on('socket', (socket) => {
      record.reusedSocket = request.reusedSocket;
      if (request.reusedSocket) return;
      socket.once('connect', () => {
        record.connectAtMs = since();
      });
      socket.once('secureConnect', () => {
        record.tlsAtMs = since();
        record.tls = {
          protocol: socket.getProtocol(),
          cipher: socket.getCipher().name,
          // Возобновлённая сессия TLS — короткое рукопожатие: объясняет разницу времён.
          sessionReused: socket.isSessionReused(),
          fingerprint256: socket.getPeerCertificate().fingerprint256 ?? null,
        };
      });
    });
    request.on('timeout', () => {
      const error = new Error(`TIMEOUT: тишина дольше ${timeoutMs} мс`);
      error.code = 'TIMEOUT';
      request.destroy(error);
    });
    request.on('error', finish);
    request.end(body ?? undefined);
  });
}

// --- ScannerStatus ---------------------------------------------------------------------------

const tagValue = (xml, tag) => new RegExp(`<[\\w]+:${tag}>([^<]*)<`).exec(xml)?.[1] ?? null;

function summarizeStatus(xml) {
  const jobs = [...xml.matchAll(/<scan:JobInfo>([\s\S]*?)<\/scan:JobInfo>/g)].map(([, block]) =>
    Object.fromEntries([...block.matchAll(/<\w+:(\w+)>([^<]*)</g)].map(([, k, v]) => [k, v])),
  );
  return { state: tagValue(xml, 'State'), adf: tagValue(xml, 'AdfState'), jobs };
}

let lastStatusLine = '';

async function status(statusLabel, { quiet = false } = {}) {
  const result = await exchange(statusLabel, 'GET', `${base}/ScannerStatus`, { quiet });
  const summary = result.status === 200 ? summarizeStatus(result.body.toString('utf8')) : null;
  result.record.statusSummary = summary;
  writeTrace();
  if (summary) {
    // В списке заданий устройство держит историю; показываем четыре первых.
    const jobs = summary.jobs
      .slice(0, 4)
      .map((job) => {
        const { JobUuid, JobUri, ...rest } = job;
        const fields = Object.entries(rest).map(([k, v]) => `${k}=${v}`);
        return `${mask(JobUuid ?? '?')}: ${fields.join(' ')}`;
      })
      .join(' ‖ ');
    const line = `состояние=${summary.state} лоток=${summary.adf} заданий=${summary.jobs.length}${jobs ? ` ‖ ${jobs}` : ''}`;
    if (!quiet) console.log(`     ${line}`);
    else if (line !== lastStatusLine) console.log(`   … ${statusLabel}: ${line}`);
    lastStatusLine = line;
  } else if (quiet) {
    printExchange(result.record);
  }
  return summary;
}

async function waitLoaded(tag, limitSeconds = 300) {
  note('Жду бумагу в лотке (ScannerAdfLoaded)…');
  const until = Date.now() + limitSeconds * 1000;
  while (Date.now() < until) {
    const summary = await status(`${tag}wait-loaded`, { quiet: true });
    if (summary?.adf === 'ScannerAdfLoaded') {
      await sleep(3000); // дать отпустить лист
      return true;
    }
    await sleep(1000);
  }
  note('Бумага так и не появилась — иду дальше как есть');
  return false;
}

// --- Разбор снятой страницы ------------------------------------------------------------------

const hex = (bytes) => bytes.toString('hex');
const isSof = (marker) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function analyzeJpeg(buffer) {
  const result = {
    bytes: buffer.length,
    head: hex(buffer.subarray(0, 16)),
    tail: hex(buffer.subarray(-16)),
    startsWithSoi: buffer[0] === 0xff && buffer[1] === 0xd8,
    endsWithEoi: buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9,
    segments: [],
  };
  const lastEoi = buffer.lastIndexOf(Buffer.from([0xff, 0xd9]));
  result.lastEoiOffset = lastEoi;
  result.bytesAfterLastEoi = lastEoi === -1 ? null : buffer.length - (lastEoi + 2);
  if (result.bytesAfterLastEoi)
    result.afterLastEoiHead = hex(buffer.subarray(lastEoi + 2, lastEoi + 34));
  if (!result.startsWithSoi) return result;

  // Сегменты заголовка — до начала сжатых данных.
  let offset = 2;
  let scanStart = null;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      result.segments.push({ offset, error: 'на месте маркера не 0xFF' });
      break;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    const data = buffer.subarray(offset + 4, offset + 2 + length);
    const segment = { marker: `ff${marker.toString(16)}`, offset, length };
    if (marker >= 0xe0 && marker <= 0xef) {
      segment.id = data
        .subarray(0, 12)
        .toString('latin1')
        .replace(/[^\x20-\x7e]/g, '.');
      if (marker === 0xe0 && data.subarray(0, 5).toString('latin1') === 'JFIF\0') {
        segment.jfif = {
          version: `${data[5]}.${data[6]}`,
          units: data[7], // 1 — точек на дюйм
          xDensity: data.readUInt16BE(8),
          yDensity: data.readUInt16BE(10),
        };
      }
    }
    if (marker === 0xfe) segment.commentBytes = data.length; // текст — только в сыром файле
    if (marker === 0xdd) segment.restartInterval = data.readUInt16BE(0);
    if (isSof(marker)) {
      segment.sof = {
        precision: data[0],
        height: data.readUInt16BE(1),
        width: data.readUInt16BE(3),
        components: data[5],
      };
      result.sof = segment.sof;
    }
    result.segments.push(segment);
    offset += 2 + length;
    if (marker === 0xda) {
      scanStart = offset;
      break;
    }
  }

  // Маркеры внутри сжатых данных: счётчик RSTn и всё остальное — DNL (высота после скана), EOI.
  if (scanStart !== null) {
    let restarts = 0;
    const markers = [];
    let i = scanStart;
    while ((i = buffer.indexOf(0xff, i)) !== -1 && i + 1 < buffer.length && markers.length < 16) {
      const marker = buffer[i + 1];
      if (marker === 0x00) i += 2;
      else if (marker === 0xff) i += 1;
      else if (marker >= 0xd0 && marker <= 0xd7) {
        restarts += 1;
        i += 2;
      } else {
        const entry = { marker: `ff${marker.toString(16)}`, offset: i };
        if (marker === 0xdc && i + 6 <= buffer.length) entry.dnlLines = buffer.readUInt16BE(i + 4);
        markers.push(entry);
        if (marker === 0xd9) break;
        i += 2;
      }
    }
    result.restartMarkers = restarts;
    result.markersInScan = markers;
    result.firstEoiOffset = markers.find((entry) => entry.marker === 'ffd9')?.offset ?? null;
  }
  return result;
}

async function analyzePage(body, record, expected) {
  const analysis = {
    exchange: record.index,
    file: record.bodyFile,
    expected,
    ...analyzeJpeg(body),
  };
  try {
    const { default: sharp } = await import('sharp');
    const meta = await sharp(body).metadata();
    analysis.sharp = {
      format: meta.format,
      width: meta.width,
      height: meta.height,
      space: meta.space,
      channels: meta.channels,
      depth: meta.depth,
      density: meta.density,
      chromaSubsampling: meta.chromaSubsampling,
      isProgressive: meta.isProgressive,
      hasIcc: Boolean(meta.icc),
      hasExif: Boolean(meta.exif),
      orientation: meta.orientation ?? null,
    };
    // Уменьшенная копия — посмотреть глазами (метки у краёв листа), не открывая оригинал.
    analysis.preview = record.bodyFile.replace(/\.jpg$/, '.preview.jpg');
    await sharp(body)
      .resize({ width: 1000 })
      .jpeg({ quality: 75 })
      .toFile(join(dir, analysis.preview));
  } catch (error) {
    analysis.sharpError = error.message;
  }
  trace.pages.push(analysis);
  writeTrace();

  const { sof, sharp: meta } = analysis;
  const jfif = analysis.segments.find((segment) => segment.jfif)?.jfif;
  console.log(
    `     JPEG: начало ${analysis.head.slice(0, 8)}… конец …${analysis.tail.slice(-8)} · ` +
      `SOI ${analysis.startsWithSoi ? 'да' : 'НЕТ'} · EOI в конце ${analysis.endsWithEoi ? 'да' : 'НЕТ'} · ` +
      `после EOI ${analysis.bytesAfterLastEoi} байт`,
  );
  console.log(
    `     размер: SOF ${sof ? `${sof.width}×${sof.height}` : 'нет'} · ` +
      `sharp ${meta ? `${meta.width}×${meta.height} ${meta.space} ${meta.channels} кан.` : `отказ: ${analysis.sharpError}`} · ` +
      `ждали ${expected.width}×${expected.height} · JFIF ${jfif ? `${jfif.xDensity}×${jfif.yDensity} ед.${jfif.units}` : 'нет'}`,
  );
  console.log(
    `     маркеры: ${analysis.segments.map((segment) => segment.marker).join(' ')} · RST ${analysis.restartMarkers ?? 0} · ` +
      `в данных: ${(analysis.markersInScan ?? []).map((entry) => entry.marker + (entry.dnlLines ? `(DNL ${entry.dnlLines})` : '')).join(' ') || 'нет'}`,
  );
}

// --- Задание ---------------------------------------------------------------------------------

function buildScanSettings() {
  const intent = options.intent ? `<scan:Intent>${options.intent}</scan:Intent>` : '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">' +
    `<pwg:Version>${options['escl-version']}</pwg:Version>` +
    intent +
    '<pwg:ScanRegions><pwg:ScanRegion>' +
    '<pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>' +
    `<pwg:XOffset>${options.xoffset}</pwg:XOffset><pwg:YOffset>${options.yoffset}</pwg:YOffset>` +
    `<pwg:Width>${options.width}</pwg:Width><pwg:Height>${options.height}</pwg:Height>` +
    '</pwg:ScanRegion></pwg:ScanRegions>' +
    '<pwg:InputSource>Feeder</pwg:InputSource>' +
    `<scan:ColorMode>${options.mode}</scan:ColorMode>` +
    '<pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>' +
    '<scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>' +
    `<scan:XResolution>${options.dpi}</scan:XResolution><scan:YResolution>${options.dpi}</scan:YResolution>` +
    '</scan:ScanSettings>'
  );
}

const expectedPixels = () => ({
  width: Math.round((number('width') * number('dpi')) / 300),
  height: Math.round((number('height') * number('dpi')) / 300),
});

/** POST /ScanJobs с повтором занятости раз в секунду. Возвращает путь задания или null. */
async function createJob(tag, busyWaitSeconds = number('busy-wait')) {
  const settings = buildScanSettings();
  writeFileSync(join(dir, `${tag}ScanSettings.xml`), settings);
  const headers = { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(settings) };
  const until = Date.now() + busyWaitSeconds * 1000;
  let attempt = 0;
  let post;
  for (;;) {
    attempt += 1;
    post = await exchange(`${tag}post-${attempt}`, 'POST', `${base}/ScanJobs`, {
      body: settings,
      headers,
    });
    if (post.status !== 503 || Date.now() >= until) break;
    await status(`${tag}status-while-busy-${attempt}`, { quiet: true });
    await sleep(1000);
  }
  if (post.status !== 201) {
    note(`Задание не создано: ${post.status ?? post.record.error?.code}, попыток ${attempt}`);
    return { jobPath: null, post };
  }
  const location = post.headers.location;
  if (!location) {
    note('201 без Location — задание не закрыть');
    return { jobPath: null, post };
  }
  const jobPath = new URL(location, `${options.scheme}://${host}:${port}`).pathname.replace(
    /\/+$/,
    '',
  );
  trace.notes.push({ text: `Location как пришёл: ${location}` });
  console.log(
    `     Location: ${/^https?:/i.test(location) ? 'абсолютный' : 'относительный'} → ${mask(jobPath)}`,
  );
  return { jobPath, post };
}

/** NextDocument до первого не-200. Возвращает число страниц и чем кончилось. */
async function fetchPages(tag, jobPath) {
  const maxPages = options['max-pages'] ? number('max-pages') : Infinity;
  const deleteAfter = options['delete-after'] ? number('delete-after') : Infinity;
  const pause = number('pause');
  let pages = 0;
  let busyRetries = 0;
  for (;;) {
    if (pages >= maxPages) return { pages, terminal: 'max-pages' };
    if (pages >= deleteAfter) return { pages, terminal: 'delete-mid' };
    if (pages > 0 && pause > 0 && busyRetries === 0) {
      note(`Пауза ${pause} с перед следующим NextDocument — смотри, подаёт ли сканер лист сам`);
      const until = Date.now() + pause * 1000;
      while (Date.now() < until) {
        await sleep(Math.min(5000, Math.max(0, until - Date.now())));
        await status(`${tag}status-in-pause`, { quiet: true });
      }
    }
    const page = await exchange(`${tag}page-${pages + 1}`, 'GET', `${jobPath}/NextDocument`, {
      timeoutMs: number('page-timeout') * 1000,
    });
    if (page.status === 200 && page.body.length > 0 && !page.record.error) {
      pages += 1;
      busyRetries = 0;
      await analyzePage(page.body, page.record, expectedPixels());
      await status(`${tag}status-after-page-${pages}`);
      continue;
    }
    // 503 на NextDocument — «страница ещё не готова»: повторяем раз в секунду, но не вечно.
    if (page.status === 503 && busyRetries < 60) {
      busyRetries += 1;
      await sleep(1000);
      continue;
    }
    const terminal = page.record.error
      ? `error:${page.record.error.code ?? page.record.error.message}`
      : `http-${page.status}${page.status === 200 ? '-empty' : ''}`;
    return { pages, terminal };
  }
}

async function closeJob(tag, jobPath) {
  await exchange(`${tag}delete`, 'DELETE', jobPath, { timeoutMs: 15_000 });
  await status(`${tag}status-after-delete`);
}

/** Полное задание: статус → POST → страницы → статус → DELETE (или без него). */
async function runJob(tag, { finish = 'delete' } = {}) {
  if (options['wait-loaded']) await waitLoaded(tag, number('wait-limit'));
  await status(`${tag}status-before`);
  const { jobPath } = await createJob(tag);
  if (jobPath === null) {
    await status(`${tag}status-after-refused-post`);
    return { jobPath: null, pages: 0, terminal: 'no-job' };
  }
  await status(`${tag}status-after-post`);
  const { pages, terminal } = await fetchPages(tag, jobPath);
  note(`Страниц получено: ${pages}; проход кончился на: ${terminal}`);
  await status(`${tag}status-after-terminal`);

  if (terminal === 'delete-mid') {
    note('DELETE посреди задания — смотри, что делает подача');
    await closeJob(tag, jobPath);
    for (let i = 1; i <= 10; i += 1) {
      await sleep(2000);
      await status(`${tag}status-after-mid-delete-${i}`, { quiet: true });
    }
    await exchange(`${tag}page-after-delete`, 'GET', `${jobPath}/NextDocument`, {
      timeoutMs: 30_000,
    });
    await exchange(`${tag}delete-again`, 'DELETE', jobPath, { timeoutMs: 15_000 });
    await status(`${tag}status-final`);
  } else if (finish === 'delete') {
    await closeJob(tag, jobPath);
    // Повторный DELETE — что отвечает устройство на уже закрытое задание (план M1, KTD-11).
    await exchange(`${tag}delete-again`, 'DELETE', jobPath, { timeoutMs: 15_000 });
  }
  return { jobPath, pages, terminal };
}

// --- Сценарии --------------------------------------------------------------------------------

async function scenarioWake() {
  // Первый запрос к уснувшему устройству: время до TCP, TLS и ответа; затем два «тёплых».
  for (let i = 1; i <= 3; i += 1) {
    await status(`status-${i}`, { quiet: false });
    await sleep(2000);
  }
}

async function scenarioAbandon() {
  const first = await runJob('first-', { finish: 'abandon' });
  if (first.jobPath === null) return;
  note('Задание БРОШЕНО без DELETE. Положи в лоток один лист — проверяю, пустит ли сканер новое');
  await waitLoaded('probe-', 120);

  // Раз в probe-interval секунд: статус и POST. 201 — устройство отпустило брошенное задание.
  const abandonedAt = Date.now();
  const limit = number('probe-limit') * 1000;
  let second = { jobPath: null };
  let probes = 0;
  while (Date.now() - abandonedAt < limit) {
    probes += 1;
    await status(`probe-status-${probes}`, { quiet: true });
    second = await createJob(`probe-${probes}-`, 0);
    if (second.jobPath !== null || second.post.status !== 503) break;
    await sleep(number('probe-interval') * 1000);
  }
  const waited = Math.round((Date.now() - abandonedAt) / 1000);
  if (second.jobPath !== null) {
    note(`Новое задание принято через ${waited} с после начала проб, брошенное так и не закрыто`);
    const { pages, terminal } = await fetchPages('second-', second.jobPath);
    note(`Второе задание: страниц ${pages}, кончилось на ${terminal}`);
    await closeJob('second-', second.jobPath);
  } else {
    note(
      `За ${waited} с устройство новое задание не приняло (последний ответ ${second.post?.status})`,
    );
  }

  note('Закрываю брошенное задание');
  await closeJob('first-', first.jobPath);
  if (second.jobPath === null) {
    note('Проверяю, что после DELETE брошенного задания сканер снова принимает задания');
    const third = await createJob('after-close-', 30);
    if (third.jobPath !== null) {
      const { pages, terminal } = await fetchPages('third-', third.jobPath);
      note(`Третье задание: страниц ${pages}, кончилось на ${terminal}`);
      await closeJob('third-', third.jobPath);
    }
  }
}

// --- Нагрузка на цикл событий (M6, U1) -------------------------------------------------------

const loadStats = { chunks: 0, busyMs: 0, maxGapMs: 0 };
let loadRunning = false;
async function loadLoop(chunkMs) {
  loadRunning = true;
  let lastEnd = performance.now();
  while (loadRunning) {
    const started = performance.now();
    loadStats.maxGapMs = Math.max(loadStats.maxGapMs, started - lastEnd);
    let x = 0;
    while (performance.now() - started < chunkMs) x += Math.sqrt(x + 1);
    loadStats.chunks += 1;
    loadStats.busyMs += performance.now() - started;
    lastEnd = performance.now();
    await yieldNow();
  }
}

async function jobUnderLoad() {
  const chunkMs = number('load');
  if (chunkMs <= 0) return runJob('');
  note(`Нагрузка на цикл событий: куски по ${chunkMs} мс с уступкой между ними`);
  const loop = loadLoop(chunkMs);
  try {
    return await runJob('');
  } finally {
    loadRunning = false;
    await loop;
    trace.load = { chunkMs, ...loadStats };
    note(
      `Нагрузка: кусков ${loadStats.chunks}, занято ${Math.round(loadStats.busyMs)} мс, самый долгий просвет между кусками ${Math.round(loadStats.maxGapMs)} мс`,
    );
  }
}

const scenarios = { job: jobUnderLoad, wake: scenarioWake, abandon: scenarioAbandon };
if (!scenarios[scenario]) {
  console.error(`Неизвестный сценарий «${scenario}». Есть: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}

console.log(`Сценарий «${scenario}», метка «${label}». Сырое — ${dir}`);
try {
  await scenarios[scenario]();
} finally {
  const fingerprints = new Set(
    trace.exchanges.map((record) => record.tls?.fingerprint256).filter(Boolean),
  );
  const connections = trace.exchanges.filter((record) => record.connectAtMs !== undefined).length;
  trace.summary = { connections, distinctCertificates: fingerprints.size };
  writeTrace();
  agent.destroy();
  console.log(
    `\nИтог: обменов ${trace.exchanges.length}, новых соединений ${connections}, ` +
      `разных сертификатов ${fingerprints.size}, страниц ${trace.pages.length}. След — trace.json в каталоге выше.`,
  );
}
