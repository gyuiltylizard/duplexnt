// Пронумерованная двусторонняя пачка для живого прогона M2 (план M2, U10; AE2): 12 листов =
// 24 страницы «1 FRONT / 1 BACK … 12 FRONT / 12 BACK». Порядок страниц в PDF — парами, под
// двустороннюю печать. По скану видно номер листа, сторону и верх листа («^ TOP ^») — то,
// что нужно, чтобы глазами сверить interleave и работу тумблера 180°. Одноразовый код.
//
// Запуск из корня:  node spikes/make-twopass-pdf.mjs   →  temp/duplexnt-twopass.pdf
// Печатать: двусторонне (переплёт по ДЛИННОМУ краю), масштаб 100%, без подгонки под страницу.
//
// PDF собирается руками: стандартный шрифт Helvetica, только ASCII, никаких зависимостей
// (как spikes/make-calibration-pdf.mjs).

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHEETS = 12;
const WIDTH = 210;
const HEIGHT = 297;
const K = 72 / 25.4; // миллиметры → пункты
const n = (value) => Number(value.toFixed(3));
const X = (mm) => n(mm * K);
const Y = (mmFromTop) => n((HEIGHT - mmFromTop) * K); // начало координат PDF — снизу слева

const line = (x1, y1, x2, y2, width = 0.3) =>
  `${width} w ${X(x1)} ${Y(y1)} m ${X(x2)} ${Y(y2)} l S`;
const text = (x, y, size, value, font = 'F1') =>
  `BT /${font} ${size} Tf ${X(x)} ${Y(y)} Td (${value}) Tj ET`;
/** Ширина строки Helvetica на глаз: ~0.556 em на цифру/букву — хватает для центровки. */
const centered = (y, size, value, font = 'F2') =>
  text(WIDTH / 2 - (value.length * size * 0.556) / K / 2, y, size, value, font);

const FILLER =
  'The quick brown fox jumps over the lazy dog 0123456789. Sphinx of black quartz, judge my vow.';

function page(sheet, side) {
  const parts = ['0 0 0 RG 0 0 0 rg'];
  // Рамка в 10 мм от краёв: по ней виден перекос и обрезка региона.
  parts.push(
    `0.3 w ${X(10)} ${Y(HEIGHT - 10)} ${n((WIDTH - 20) * K)} ${n((HEIGHT - 20) * K)} re S`,
  );

  parts.push(text(16, 24, 12, `DUPLEXNT TWO-PASS SHEET ${sheet} / ${SHEETS} - ${side}`, 'F2'));
  parts.push(text(16, 30, 8, 'Print duplex (long-edge binding), 100% scale, no fit-to-page.'));
  parts.push(centered(40, 14, '^ TOP ^'));
  parts.push(line(16, 44, WIDTH - 16, 44, 0.4));

  // Номер листа — крупно: порядок читается с миниатюры. Сторона — словом под номером.
  parts.push(centered(200, 190, String(sheet)));
  parts.push(centered(236, 40, side));

  // Обороту — сплошная полоса у нижнего края: сторона отличима даже на крошечной миниатюре.
  if (side === 'BACK') {
    parts.push(`0 0 0 rg ${X(16)} ${Y(282)} ${n((WIDTH - 32) * K)} ${n(8 * K)} re f`);
  }

  // Мелкий текст — чтобы страница сжималась как документ, а не как пустой лист.
  for (let row = 0; row < 8; row += 1) {
    parts.push(text(16, 250 + row * 3.2, 6, `${String(row + 1).padStart(2, '0')}  ${FILLER}`));
  }
  return parts.join('\n');
}

// --- Сборка файла ----------------------------------------------------------------------------

const objects = [];
const add = (body) => objects.push(body);
const PAGES = SHEETS * 2;
const pageIds = Array.from({ length: PAGES }, (_, index) => 5 + index * 2);

add('<< /Type /Catalog /Pages 2 0 R >>');
add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${PAGES} >>`);
add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
for (let sheet = 1; sheet <= SHEETS; sheet += 1) {
  for (const side of ['FRONT', 'BACK']) {
    const contentId = objects.length + 2;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(WIDTH * K)} ${n(HEIGHT * K)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const stream = page(sheet, side);
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
}

let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((body, index) => {
  offsets.push(pdf.length);
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

const out = resolve('temp/duplexnt-twopass.pdf');
mkdirSync(resolve('temp'), { recursive: true });
writeFileSync(out, pdf, 'latin1');
console.log(`Готово: ${out} (${SHEETS} листов = ${PAGES} страницы A4, ${pdf.length} байт)`);
