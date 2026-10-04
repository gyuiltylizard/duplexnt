// Генератор страниц-фикстур эмулятора сканера (план M1, KTD-28): синтетические пронумерованные
// JPEG. Запуск: `node scripts/generate-page-fixtures.ts`. Результат лежит в репозитории байт в
// байт — эмулятор и тесты читают файлы, а не вызывают генератор; перегенерация нужна, только если
// меняется сам вид страницы.
//
// Цифры собраны из прямоугольников семисегментного индикатора: шрифтов в рисунке нет, поэтому
// вид страницы не зависит от того, какие шрифты стоят на машине.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const PAGES_DIR = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../test/fixtures/escl/et-3850/pages',
);

const PAGE_COUNT = 30;
// A4 при 150 dpi: страница узнаётся в превью, а файл остаётся малым.
const WIDTH = 1240;
const HEIGHT = 1754;

const DIGIT_WIDTH = 300;
const DIGIT_HEIGHT = 540;
const STROKE = 60;
const GAP = 80;

// Сегменты: a — верх, b и c — правые, d — низ, e и f — левые, g — середина.
const SEGMENTS: Readonly<Record<string, string>> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afgecd',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
};

const rect = (x: number, y: number, width: number, height: number, fill = '#1a1a1a'): string =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}"/>`;

function digit(char: string, x: number, y: number): string {
  const half = (DIGIT_HEIGHT - STROKE) / 2;
  const shapes: Readonly<Record<string, string>> = {
    a: rect(x, y, DIGIT_WIDTH, STROKE),
    b: rect(x + DIGIT_WIDTH - STROKE, y, STROKE, half + STROKE),
    c: rect(x + DIGIT_WIDTH - STROKE, y + half, STROKE, half + STROKE),
    d: rect(x, y + DIGIT_HEIGHT - STROKE, DIGIT_WIDTH, STROKE),
    e: rect(x, y + half, STROKE, half + STROKE),
    f: rect(x, y, STROKE, half + STROKE),
    g: rect(x, y + half, DIGIT_WIDTH, STROKE),
  };
  return Array.from(SEGMENTS[char] ?? '', (segment) => shapes[segment] ?? '').join('');
}

function pageSvg(number: number): string {
  const label = String(number).padStart(2, '0');
  const labelWidth = label.length * DIGIT_WIDTH + (label.length - 1) * GAP;
  const left = (WIDTH - labelWidth) / 2;
  const digits = Array.from(label, (char, index) =>
    digit(char, left + index * (DIGIT_WIDTH + GAP), 330),
  ).join('');

  // «Строки текста» под номером: у миниатюры появляется фактура, а длина строк зависит от номера
  // — соседние страницы различимы и без чтения цифр.
  const lines = Array.from({ length: 9 }, (_, index) => {
    const width = 520 + ((number * 97 + index * 211) % 420);
    return rect(150, 1060 + index * 62, width, 20, '#8a8a8a');
  }).join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">` +
    rect(0, 0, WIDTH, HEIGHT, '#ffffff') +
    `<rect x="60" y="60" width="${WIDTH - 120}" height="${HEIGHT - 120}" fill="none" stroke="#b0b0b0" stroke-width="6"/>` +
    digits +
    lines +
    '</svg>'
  );
}

mkdirSync(PAGES_DIR, { recursive: true });
for (let number = 1; number <= PAGE_COUNT; number += 1) {
  const name = `page-${String(number).padStart(2, '0')}.jpg`;
  // Как у устройства: baseline JPEG, один канал серого.
  const info = await sharp(Buffer.from(pageSvg(number)))
    .flatten({ background: '#ffffff' })
    .toColourspace('b-w')
    .jpeg({ quality: 80, progressive: false })
    .toFile(join(PAGES_DIR, name));
  console.log(`${name}: ${info.width}×${info.height}, ${info.size} байт`);
}
