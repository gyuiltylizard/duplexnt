// Калибровочные листы для съёмки U1 (план M1): три пронумерованных листа A4 с миллиметровыми
// линейками от левого и верхнего края бумаги. По скану видно, какой участок листа попал в регион,
// на сколько он смещён и перекошен, — без разглядывания чужих документов. Одноразовый код.
//
// Запуск из корня:  node spikes/make-calibration-pdf.mjs   →  temp/duplexnt-calibration.pdf
// Печатать в масштабе 100% («фактический размер»), без подгонки под страницу.
//
// PDF собирается руками: стандартный шрифт Helvetica, только ASCII, никаких зависимостей.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHEETS = 3;
const WIDTH = 210;
const HEIGHT = 297;
const K = 72 / 25.4; // миллиметры → пункты
const n = (value) => Number(value.toFixed(3));
const X = (mm) => n(mm * K);
const Y = (mmFromTop) => n((HEIGHT - mmFromTop) * K); // начало координат PDF — снизу слева

const line = (x1, y1, x2, y2, width = 0.3) =>
  `${width} w ${X(x1)} ${Y(y1)} m ${X(x2)} ${Y(y2)} l S`;
const rect = (x, y, w, h, color) =>
  `${color} rg ${X(x)} ${Y(y + h)} ${n(w * K)} ${n(h * K)} re f 0 0 0 rg`;
const text = (x, y, size, value, font = 'F1') =>
  `BT /${font} ${size} Tf ${X(x)} ${Y(y)} Td (${value}) Tj ET`;
const tick = (mm) => (mm % 10 === 0 ? 5 : mm % 5 === 0 ? 3.5 : 2);

/** Горизонтальная линейка: деления — миллиметры от ЛЕВОГО края листа. */
function horizontalRuler(y, direction) {
  const parts = [line(4, y, WIDTH - 4, y, 0.4)];
  for (let mm = 4; mm <= WIDTH - 4; mm += 1) {
    parts.push(line(mm, y, mm, y + direction * tick(mm), mm % 10 === 0 ? 0.4 : 0.2));
    if (mm % 10 === 0) {
      parts.push(text(mm + 0.4, y + direction * 6.2 + (direction > 0 ? 1.2 : 0), 6, String(mm)));
    }
  }
  return parts;
}

/** Вертикальная линейка: деления — миллиметры от ВЕРХНЕГО края листа. */
function verticalRuler(x, direction) {
  const parts = [line(x, 4, x, HEIGHT - 4, 0.4)];
  for (let mm = 4; mm <= HEIGHT - 4; mm += 1) {
    parts.push(line(x, mm, x + direction * tick(mm), mm, mm % 10 === 0 ? 0.4 : 0.2));
    if (mm % 10 === 0) {
      parts.push(text(x + (direction > 0 ? 5.6 : -10.5), mm + 0.8, 6, String(mm)));
    }
  }
  return parts;
}

const FILLER =
  'The quick brown fox jumps over the lazy dog 0123456789. Sphinx of black quartz, judge my vow.';

function sheet(number) {
  const parts = ['0 0 0 RG 0 0 0 rg'];
  // Рамка в 10 мм от краёв: по ней считается перекос.
  parts.push(
    `0.3 w ${X(10)} ${Y(HEIGHT - 10)} ${n((WIDTH - 20) * K)} ${n((HEIGHT - 20) * K)} re S`,
  );
  parts.push(...horizontalRuler(20, 1), ...horizontalRuler(148.5, 1), ...horizontalRuler(277, -1));
  parts.push(...verticalRuler(20, 1), ...verticalRuler(190, -1));
  // Перекрестие в центре листа.
  parts.push(line(105, 140.5, 105, 156.5, 0.4));

  parts.push(text(35, 36, 16, `DUPLEXNT CALIBRATION SHEET ${number} / ${SHEETS}`, 'F2'));
  parts.push(text(35, 42, 8, 'A4 210 x 297 mm. Print at 100% (actual size), no fit-to-page.'));
  parts.push(text(35, 46, 8, 'Rulers: millimetres from the LEFT and from the TOP paper edge.'));
  parts.push(text(96, 30, 11, '^ TOP ^', 'F2'));

  // Мелкий текст — чтобы страница сжималась как документ, а не как пустой лист.
  for (let row = 0; row < 14; row += 1) {
    parts.push(text(35, 60 + row * 3.6, 7, `${String(row + 1).padStart(2, '0')}  ${FILLER}`));
  }

  // Номер листа — крупно: порядок страниц в проходе читается с любого превью.
  parts.push(text(82, 215, 220, String(number), 'F2'));

  const grays = [0, 0.2, 0.4, 0.6, 0.8, 0.95];
  grays.forEach((gray, index) => {
    parts.push(rect(40 + index * 14, 228, 12, 10, `${gray} ${gray} ${gray}`));
  });
  const colors = ['1 0 0', '0 1 0', '0 0 1', '0 1 1', '1 0 1', '1 1 0'];
  colors.forEach((color, index) => {
    parts.push(rect(40 + index * 14, 242, 12, 10, color));
  });
  parts.push(text(126, 235, 7, 'gray 0 / 20 / 40 / 60 / 80 / 95 %'));
  parts.push(text(126, 249, 7, 'R  G  B  C  M  Y'));
  return parts.join('\n');
}

// --- Сборка файла ----------------------------------------------------------------------------

const objects = [];
const add = (body) => objects.push(body);
const pageIds = Array.from({ length: SHEETS }, (_, index) => 5 + index * 2);

add('<< /Type /Catalog /Pages 2 0 R >>');
add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${SHEETS} >>`);
add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
for (let number = 1; number <= SHEETS; number += 1) {
  const contentId = objects.length + 2;
  add(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(WIDTH * K)} ${n(HEIGHT * K)}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
  );
  const stream = sheet(number);
  add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
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

const out = resolve('temp/duplexnt-calibration.pdf');
mkdirSync(resolve('temp'), { recursive: true });
writeFileSync(out, pdf, 'latin1');
console.log(`Готово: ${out} (${SHEETS} листа A4, ${pdf.length} байт)`);
