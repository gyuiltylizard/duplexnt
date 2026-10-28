// Тестовые листы для спайка U1 плана M6 (выравнивание перекоса подачи): по ним меряется
// «веер» — как меняется угол строк по высоте листа — и боковой дрейф вертикалей. Листы
// калибровки M1 (`make-calibration-pdf.mjs`) для этого не годятся: три линейки по высоте —
// три точки, квадратика через них проходит без остатка.
//
// Запуск из корня:  node spikes/make-fan-sheets.mjs   →  temp/duplexnt-fan-sheets.pdf
// Печатать в масштабе 100% («фактический размер»), без подгонки под страницу.
//
// Страницы (имена — будущие фикстуры `test/fixtures/escl/et-3850/scans/`):
//   1–3  GRID G1..G3  — сетка 10 мм на весь лист: 28 горизонталей, 20 вертикалей (fan-grid-N)
//   4    TEXT         — сплошной вымышленный текст, один столбец (fan-text, straight-text)
//   5    TABLE        — таблица с рамкой и линейками (fan-table)
//   6    TWOCOL       — две колонки с разной фазой строк — ловушка (fan-twocol)
//   7    GRAPHIC      — косая штриховка под 12° между строками — ловушка (fan-graphic)
//   8    SPARSE       — строки только вверху и внизу, середина пустая — гейт «мало полос»
//   9    PHOTO        — процедурная «фотография» без строк (photo)
//
// PDF собирается руками: Helvetica, только ASCII, картинка — несжатый DeviceGray. Текст —
// псевдослучайные слова из короткого словаря (детерминированно), ничего личного.
// Одноразовый код: вне сборки, вне линта, тестами не покрывается.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WIDTH = 210;
const HEIGHT = 297;
const K = 72 / 25.4; // миллиметры → пункты
const n = (value) => Number(value.toFixed(3));
const X = (mm) => n(mm * K);
const Y = (mmFromTop) => n((HEIGHT - mmFromTop) * K); // начало координат PDF — снизу слева

const line = (x1, y1, x2, y2, width = 0.3) =>
  `${width} w ${X(x1)} ${Y(y1)} m ${X(x2)} ${Y(y2)} l S`;
const rect = (x, y, w, h, width = 0.3) =>
  `${width} w ${X(x)} ${Y(y + h)} ${n(w * K)} ${n(h * K)} re S`;
const escapePdf = (value) => value.replace(/[\\()]/g, (ch) => `\\${ch}`);
const text = (x, y, size, value, font = 'F1') =>
  `BT /${font} ${size} Tf ${X(x)} ${Y(y)} Td (${escapePdf(value)}) Tj ET`;

// --- Детерминированный «текст» ---------------------------------------------------------------

const WORDS = (
  'the quick brown fox jumps over lazy dog sphinx of black quartz judge my vow pack box with ' +
  'five dozen liquor jugs how vexingly daft zebras jump bright vixens leap crazy frederick ' +
  'bought many very exquisite opal jewels waltz bad nymph for jigs grumpy wizards make toxic ' +
  'brew evil queen jaded sailor stow back tar vat along ridge while dusk falls on quiet ' +
  'harbour and gulls wheel above tide marks left by morning rain which never came again'
).split(' ');

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Строка «текста» примерно на `chars` символов; короткая, если `short`. */
function sentenceLine(random, chars, short = false) {
  const target = short ? Math.max(12, Math.round(chars * (0.25 + random() * 0.5))) : chars;
  const parts = [];
  let length = 0;
  let capital = true;
  while (length < target) {
    let word = WORDS[Math.floor(random() * WORDS.length)];
    if (capital) {
      word = word[0].toUpperCase() + word.slice(1);
      capital = false;
    }
    if (random() < 0.08) {
      word += random() < 0.3 ? ',' : '.';
      capital = word.endsWith('.');
    }
    if (length + word.length + 1 > target && !short) break;
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(' ');
}

/** Абзацы текста в столбце: `lines` строк, с разрывами абзацев (короткая последняя строка). */
function paragraphs(random, lines, chars) {
  const out = [];
  let remaining = Math.round(6 + random() * 8);
  while (out.length < lines) {
    remaining -= 1;
    if (remaining === 0) {
      out.push(sentenceLine(random, chars, true));
      out.push('');
      remaining = Math.round(6 + random() * 8);
    } else {
      out.push(sentenceLine(random, chars));
    }
  }
  return out.slice(0, lines);
}

const header = (title) => [
  text(10, 6.5, 7, `DUPLEXNT FAN SHEETS - ${title} - print at 100% (actual size)`, 'F2'),
  text(170, 6.5, 7, '^ TOP ^', 'F2'),
];

// --- Листы -----------------------------------------------------------------------------------

function gridSheet(number) {
  const parts = ['0 0 0 RG 0 0 0 rg', ...header(`GRID G${number} / 3`)];
  // Горизонтали: 10..280 через 10 мм; каждая пятая (50, 100, ...) толще.
  for (let y = 10; y <= 280; y += 10) {
    parts.push(line(10, y, 200, y, y % 50 === 0 ? 0.5 : 0.25));
  }
  // Вертикали: 10..200 через 10 мм.
  for (let x = 10; x <= 200; x += 10) {
    parts.push(line(x, 10, x, 280, x % 50 === 0 ? 0.5 : 0.25));
  }
  // Подписи — только в нижнем поле, чтобы не мешать поиску линий.
  parts.push(text(10, 291, 7, `G${number}`, 'F2'));
  parts.push(
    text(
      20,
      291,
      6,
      'Horizontals 10..280 mm every 10 mm, verticals 10..200 mm every 10 mm; bold every 50 mm.',
    ),
  );
  return parts.join('\n');
}

function textSheet() {
  const random = makeRandom(41);
  const parts = ['0 0 0 RG 0 0 0 rg', ...header('TEXT')];
  parts.push(text(20, 20, 13, 'Quarterly notes on tide marks and harbour gulls', 'F2'));
  const lines = paragraphs(random, 56, 92);
  lines.forEach((value, index) => {
    if (value !== '') parts.push(text(20, 28 + index * 4.5, 10, value));
  });
  return parts.join('\n');
}

function tableSheet() {
  const random = makeRandom(7);
  const parts = ['0 0 0 RG 0 0 0 rg', ...header('TABLE')];
  parts.push(text(20, 20, 12, 'Ledger of jugs, jewels and vats (fictional)', 'F2'));
  const left = 20;
  const right = 190;
  const top = 28;
  const rowH = 8;
  const rows = 30;
  const columns = [20, 60, 95, 130, 160, 190];
  parts.push(rect(left, top, right - left, rows * rowH, 0.5));
  for (let r = 1; r < rows; r += 1) {
    parts.push(line(left, top + r * rowH, right, top + r * rowH, r === 1 ? 0.5 : 0.2));
  }
  for (const x of columns.slice(1, -1)) {
    parts.push(line(x, top, x, top + rows * rowH, 0.3));
  }
  const heads = ['Item', 'Lot', 'Qty', 'Mark', 'Note'];
  heads.forEach((value, index) => parts.push(text(columns[index] + 2, top + 5.5, 8, value, 'F2')));
  for (let r = 1; r < rows; r += 1) {
    const y = top + r * rowH + 5.5;
    parts.push(text(columns[0] + 2, y, 8, sentenceLine(random, 16)));
    parts.push(text(columns[1] + 2, y, 8, `L-${String(Math.floor(random() * 900) + 100)}`));
    parts.push(text(columns[2] + 2, y, 8, String(Math.floor(random() * 5000))));
    parts.push(text(columns[3] + 2, y, 8, random() < 0.5 ? 'ok' : 'hold'));
    parts.push(text(columns[4] + 2, y, 8, sentenceLine(random, 12)));
  }
  parts.push(text(20, 282, 8, 'Totals are illustrative; every figure above is made up.'));
  return parts.join('\n');
}

function twoColumnSheet() {
  const parts = ['0 0 0 RG 0 0 0 rg', ...header('TWOCOL')];
  parts.push(text(20, 20, 12, 'Two columns, independent line phase', 'F2'));
  const leftLines = paragraphs(makeRandom(101), 64, 44);
  const rightLines = paragraphs(makeRandom(202), 62, 44);
  leftLines.forEach((value, index) => {
    if (value !== '') parts.push(text(20, 28 + index * 3.9, 8.5, value));
  });
  // Правая колонка смещена по фазе на полстроки и идёт другим интерлиньяжем.
  rightLines.forEach((value, index) => {
    if (value !== '') parts.push(text(110, 30 + index * 4.0, 8.5, value));
  });
  return parts.join('\n');
}

function graphicSheet() {
  const random = makeRandom(55);
  const parts = ['0 0 0 RG 0 0 0 rg', ...header('GRAPHIC')];
  paragraphs(random, 5, 92).forEach((value, index) => {
    if (value !== '') parts.push(text(20, 22 + index * 4.5, 10, value));
  });
  // Штриховка под 12° в окне 20..190 × 55..255: наклонные линии, шаг 6 мм по вертикали.
  const x0 = 20;
  const x1 = 190;
  const y0 = 55;
  const y1 = 255;
  const slope = Math.tan((12 * Math.PI) / 180);
  parts.push(rect(x0, y0, x1 - x0, y1 - y0, 0.4));
  for (let c = y0 - (x1 - x0) * slope; c <= y1; c += 6) {
    // линия y = c + (x - x0) * slope, обрезанная окном
    let ax = x0;
    let ay = c;
    let bx = x1;
    let by = c + (x1 - x0) * slope;
    if (ay < y0) {
      ax = x0 + (y0 - c) / slope;
      ay = y0;
    }
    if (by > y1) {
      bx = x0 + (y1 - c) / slope;
      by = y1;
    }
    if (ax < bx) parts.push(line(ax, ay, bx, by, 0.3));
  }
  paragraphs(random, 5, 92).forEach((value, index) => {
    if (value !== '') parts.push(text(20, 264 + index * 4.5, 10, value));
  });
  return parts.join('\n');
}

function sparseSheet() {
  const random = makeRandom(9);
  const parts = ['0 0 0 RG 0 0 0 rg', ...header('SPARSE')];
  paragraphs(random, 3, 92).forEach((value, index) => {
    if (value !== '') parts.push(text(20, 22 + index * 4.5, 10, value));
  });
  paragraphs(random, 3, 92).forEach((value, index) => {
    if (value !== '') parts.push(text(20, 270 + index * 4.5, 10, value));
  });
  return parts.join('\n');
}

// Процедурная «фотография»: мягкие пятна плюс зерно; строк и прямых линий нет.
const PHOTO_W = 240;
const PHOTO_H = 300;
function photoBytes() {
  const random = makeRandom(77);
  const blobs = Array.from({ length: 14 }, () => ({
    x: random() * PHOTO_W,
    y: random() * PHOTO_H,
    r: 20 + random() * 80,
    a: (random() - 0.5) * 160,
  }));
  const bytes = Buffer.alloc(PHOTO_W * PHOTO_H);
  for (let y = 0; y < PHOTO_H; y += 1) {
    for (let x = 0; x < PHOTO_W; x += 1) {
      let v = 150 + 40 * Math.sin(x / 37) * Math.cos(y / 29);
      for (const b of blobs) {
        const d2 = (x - b.x) ** 2 + (y - b.y) ** 2;
        v += b.a * Math.exp(-d2 / (2 * b.r * b.r));
      }
      v += (random() - 0.5) * 24;
      bytes[y * PHOTO_W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return bytes;
}

function photoSheet() {
  const parts = ['0 0 0 RG 0 0 0 rg', ...header('PHOTO')];
  parts.push(text(20, 20, 12, 'Procedural picture, nothing to measure lines on', 'F2'));
  const w = 160;
  const h = 200;
  parts.push(`q ${n(w * K)} 0 0 ${n(h * K)} ${X(25)} ${Y(30 + h)} cm /Im1 Do Q`);
  parts.push(text(25, 238, 8, 'Gradient blobs with grain; no text lines inside the frame.'));
  return parts.join('\n');
}

// --- Сборка файла ----------------------------------------------------------------------------

const sheets = [
  () => gridSheet(1),
  () => gridSheet(2),
  () => gridSheet(3),
  textSheet,
  tableSheet,
  twoColumnSheet,
  graphicSheet,
  sparseSheet,
  photoSheet,
];

const objects = [];
const add = (body) => objects.push(body) && objects.length;

add('<< /Type /Catalog /Pages 2 0 R >>');
add('PAGES'); // заполняется ниже, когда известны номера страниц
add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
const photo = photoBytes();
const imageId = add(
  `<< /Type /XObject /Subtype /Image /Width ${PHOTO_W} /Height ${PHOTO_H} ` +
    `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${photo.length} >>\nstream\n` +
    `${photo.toString('latin1')}\nendstream`,
);

const pageIds = [];
for (const build of sheets) {
  const stream = build();
  const contentId = objects.length + 2;
  pageIds.push(
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(WIDTH * K)} ${n(HEIGHT * K)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>`,
    ),
  );
  add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
}
objects[1] =
  `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] ` +
  `/Count ${pageIds.length} >>`;

let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((body, index) => {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const out = resolve('temp/duplexnt-fan-sheets.pdf');
mkdirSync(resolve('temp'), { recursive: true });
writeFileSync(out, pdf, 'latin1');
console.log(
  `Готово: ${out} (${pageIds.length} страниц A4, ${Buffer.byteLength(pdf, 'latin1')} байт)`,
);
