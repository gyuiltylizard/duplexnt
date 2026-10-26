// Значок приложения (B-7): SVG-мастера из handoff'а → build/icon.ico. Запуск из корня:
// `npm run icons`. Результат коммитится — сборка от генерации не зависит (KTD-3).
//
// Правило handoff'а: ≤ 24 px — только из icon-small.svg (оптически скорректированный мастер),
// ≥ 32 px — из icon.svg. Каждый размер растрируется вектором сразу в целевой (KTD-1): справочный
// генератор handoff'а растягивал 16 px до 20 и 24.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { encodeIco, ICON_PATH, ICON_SIZES, PNG_FRAME_SIZE, type IcoFrame } from './ico.ts';

const SMALL_UP_TO = 24;

/** Ширина мастера из атрибута `width`: от неё считается плотность растра. */
function widthOf(svg: Buffer): number {
  const match = /<svg\b[^>]*\swidth="(\d+)"/.exec(svg.toString('utf8'));
  if (match?.[1] === undefined) {
    throw new Error('у мастера нет атрибута width');
  }
  return Number(match[1]);
}

async function frameOf(size: number, master: Buffer): Promise<IcoFrame> {
  const density = (72 * size) / widthOf(master);
  const image = sharp(master, { density }).resize(size, size).ensureAlpha();
  const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== size || info.height !== size || info.channels !== 4) {
    throw new Error(
      `кадр ${String(size)}: вышло ${String(info.width)}×${String(info.height)}×${String(info.channels)}`,
    );
  }
  const rgba = new Uint8Array(data);
  return size >= PNG_FRAME_SIZE
    ? { size, rgba, png: new Uint8Array(await image.png({ compressionLevel: 9 }).toBuffer()) }
    : { size, rgba };
}

const master = readFileSync(resolve('build/icon.svg'));
const small = readFileSync(resolve('build/icon-small.svg'));
const frames = await Promise.all(
  ICON_SIZES.map((size) => frameOf(size, size <= SMALL_UP_TO ? small : master)),
);
writeFileSync(resolve(ICON_PATH), encodeIco(frames));
console.log(`${ICON_PATH}: ${ICON_SIZES.join(', ')} px`);
