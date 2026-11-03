// BMP 24 бит для графики установщика NSIS (B-26, handoff installer-art): BITMAPFILEHEADER +
// BITMAPINFOHEADER, строки BGR снизу вверх, каждая выровнена до 4 байт, без сжатия и альфы —
// ровно то, что читает мастер NSIS (`MUI_WELCOMEFINISHPAGE_BITMAP`, `MUI_HEADERIMAGE_BITMAP`).
// Своё, а не `bmp-js`: формат — тридцать строк, а лишняя зависимость в проекте не нужна. Пара к
// `ico.ts`: там тот же BITMAPINFOHEADER, но 32 бита и без файлового заголовка.

/** Растр RGB: пиксели построчно сверху вниз, по три байта на пиксель. */
export interface RgbImage {
  readonly width: number;
  readonly height: number;
  readonly rgb: Uint8Array;
}

/** Картинки мастера: мастер SVG, растр и размер, которого требует NSIS (1 ед. SVG = 1 px). */
export const INSTALLER_ART = [
  {
    svg: 'build/installer-sidebar.svg',
    bmp: 'build/installer-sidebar.bmp',
    width: 164,
    height: 314,
  },
  { svg: 'build/installer-header.svg', bmp: 'build/installer-header.bmp', width: 150, height: 57 },
] as const;

const FILE_HEADER_SIZE = 14;
const INFO_HEADER_SIZE = 40;
const BITS_PER_PIXEL = 24;

/** Длина строки в файле: 3 байта на пиксель, выровнено до 4. */
export const bmpRowSize = (width: number): number => Math.ceil((width * 3) / 4) * 4;

/** Файл BMP 24 бит из растра RGB. */
export function encodeBmp24({ width, height, rgb }: RgbImage): Uint8Array {
  if (rgb.length !== width * height * 3) {
    throw new Error(
      `bmp ${String(width)}×${String(height)}: ждали ${String(width * height * 3)} байт RGB, пришло ${String(rgb.length)}`,
    );
  }
  const rowSize = bmpRowSize(width);
  const pixelsSize = rowSize * height;
  const out = new Uint8Array(FILE_HEADER_SIZE + INFO_HEADER_SIZE + pixelsSize);
  const view = new DataView(out.buffer);
  // BITMAPFILEHEADER
  out[0] = 0x42; // B
  out[1] = 0x4d; // M
  view.setUint32(2, out.length, true);
  view.setUint32(6, 0, true); // зарезервировано
  view.setUint32(10, FILE_HEADER_SIZE + INFO_HEADER_SIZE, true); // смещение пикселей
  // BITMAPINFOHEADER
  view.setUint32(14, INFO_HEADER_SIZE, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // положительная высота — строки снизу вверх
  view.setUint16(26, 1, true); // плоскости
  view.setUint16(28, BITS_PER_PIXEL, true);
  view.setUint32(30, 0, true); // BI_RGB
  view.setUint32(34, pixelsSize, true);
  view.setInt32(38, 2835, true); // 72 dpi по горизонтали, px/m
  view.setInt32(42, 2835, true); // и по вертикали
  view.setUint32(46, 0, true); // цветов в палитре
  view.setUint32(50, 0, true); // важных цветов
  for (let row = 0; row < height; row += 1) {
    const from = (height - 1 - row) * width * 3;
    const to = FILE_HEADER_SIZE + INFO_HEADER_SIZE + row * rowSize;
    for (let x = 0; x < width; x += 1) {
      const s = from + x * 3;
      const d = to + x * 3;
      out[d] = rgb[s + 2] ?? 0;
      out[d + 1] = rgb[s + 1] ?? 0;
      out[d + 2] = rgb[s] ?? 0;
    }
  }
  return out;
}

/** Разбор BMP 24 бит обратно в растр — для тестов и проверки собранных файлов. */
export function decodeBmp24(bytes: Uint8Array): RgbImage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) {
    throw new Error('не BMP: сигнатуры BM нет');
  }
  if (view.getUint16(28, true) !== BITS_PER_PIXEL || view.getUint32(30, true) !== 0) {
    throw new Error('не BMP 24 бит без сжатия');
  }
  const width = view.getInt32(18, true);
  const height = view.getInt32(22, true);
  if (width <= 0 || height <= 0) {
    throw new Error('ждали строки снизу вверх: размеры должны быть положительными');
  }
  const offset = view.getUint32(10, true);
  const rowSize = bmpRowSize(width);
  const rgb = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    const from = offset + (height - 1 - row) * rowSize;
    const to = row * width * 3;
    for (let x = 0; x < width; x += 1) {
      const s = from + x * 3;
      const d = to + x * 3;
      rgb[d] = bytes[s + 2] ?? 0;
      rgb[d + 1] = bytes[s + 1] ?? 0;
      rgb[d + 2] = bytes[s] ?? 0;
    }
  }
  return { width, height, rgb };
}
