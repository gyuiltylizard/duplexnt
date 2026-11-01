import { hasJpegMarkers } from '../escl/jpeg-markers';
import { isImageTimeout, processImage } from '../image/sharp-image';
import { decodePixelLimit } from '../storage/thumbnails';

// Серая рабочая картинка — общий вход детекторов пустых страниц (M4) и перекоса подачи (M6,
// план U2): один декод и уменьшение на страницу обслуживают оба измерения. Константы белого и
// чернил откалиброваны детектором пустых на сканах ET-3850 и переиспользуются детектором
// перекоса без подстройки.

/**
 * Рабочий размер — длинная сторона в пикселях (~120 dpi для A4). Уменьшение гасит шум сканера,
 * но не растворяет штрих карандаша; миниатюра 320×452 для этого мала (M4, KTD2). Детектору
 * перекоса этого хватает: на сетках ET-3850 полосы 30 мм дают остаток ≤ 0,5 мм (M6, U1).
 */
export const WORKING_LONG_SIDE = 1400;

/** Обрезка полей с каждой стороны, доля размера: тень кромки автоподатчика и срез листа. */
export const MARGIN_RATIO = 0.04;

/** Белое бумаги — яркость, ниже которой лежит эта доля пикселей обрезанной области. */
export const PAPER_WHITE_PERCENTILE = 0.9;

/**
 * «Чернильный» пиксель темнее белого бумаги больше чем на столько уровней из 255. Снижать
 * дельту ради бледного карандаша бесполезно: доля растёт площадью штриха, а не его темнотой,
 * тогда как просвечивание при дельте 20 выходит на 2.4e-3 (приёмка M4).
 */
export const INK_DELTA = 40;

/** Серые пиксели по строкам, без каналов: `width * height` байт. */
export interface GrayImage {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Гистограмма яркости внутри обрезки полей и число пикселей в ней. */
export function marginHistogramOf({ data, width, height }: GrayImage): {
  histogram: Uint32Array;
  total: number;
} {
  const marginX = Math.round(width * MARGIN_RATIO);
  const marginY = Math.round(height * MARGIN_RATIO);
  const histogram = new Uint32Array(256);
  let total = 0;
  for (let y = marginY; y < height - marginY; y += 1) {
    const row = y * width;
    for (let x = marginX; x < width - marginX; x += 1) {
      const level = data[row + x] ?? 0;
      histogram[level] = (histogram[level] ?? 0) + 1;
      total += 1;
    }
  }
  return { histogram, total };
}

/** Белое бумаги по гистограмме — перцентиль яркости снизу; пустая гистограмма — 255. */
export function paperWhiteOf(histogram: Uint32Array, total: number): number {
  let seen = 0;
  for (let level = 0; level < 256; level += 1) {
    seen += histogram[level] ?? 0;
    if (total > 0 && seen >= total * PAPER_WHITE_PERCENTILE) {
      return level;
    }
  }
  return 255;
}

/**
 * Серая рабочая картинка страницы JPEG (`sharp` — `test:integration`). Сбой — не JPEG,
 * превышение предела пикселей, ошибка декодирования — `null`: детекторы считают такую
 * страницу не пустой и не измеримой, ошибкой это не является (M4 R6, M6 R3). Срок обработки
 * (B-21) — исключение `ImageTimeoutError`: исход «не успели» не кэшируется, его различают оценки.
 */
export async function decodeWorkingGray(
  bytes: Uint8Array,
  pixelLimit: number | null,
): Promise<GrayImage | null> {
  if (!hasJpegMarkers(bytes)) {
    return null;
  }
  const limit = decodePixelLimit(pixelLimit);
  try {
    return await processImage({ kind: 'jpeg', bytes, pixelLimit: limit }, async (image) => {
      const { format, width, height } = await image.metadata();
      if (format !== 'jpeg' || width * height > limit) {
        return null;
      }
      const { data, info } = await image
        .greyscale()
        .resize({
          width: WORKING_LONG_SIDE,
          height: WORKING_LONG_SIDE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (info.channels !== 1) {
        return null;
      }
      return {
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        width: info.width,
        height: info.height,
      };
    });
  } catch (error: unknown) {
    if (isImageTimeout(error)) {
      throw error;
    }
    return null;
  }
}
