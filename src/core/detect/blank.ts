import sharp from 'sharp';
import { hasJpegMarkers } from '../escl/jpeg-markers';
import { decodePixelLimit } from '../storage/thumbnails';

// Детектор пустых страниц (план M4, U2, KTD2; спека → «Пустые обороты»): доля «чернильных»
// пикселей после приведения к серому и уменьшения, внутри обрезки полей. Вердикт «пусто» —
// доля ниже порога. Детектор только предлагает: страница скрывается по режиму сессии и её
// возвращает пометка «это не пустая страница» (ADR 0004, амендмент 2026-10-22).
//
// Константы откалиброваны табличным тестом на настоящих сканах ET-3850
// (`test/integration/blank-detector.test.ts`, фикстуры `test/fixtures/escl/et-3850/scans/`):
// чистый лист, просвечивание и дырокол — пусто; бледный карандаш, одна строка, подпись и
// карандашный номер страницы — не пусто. Любая смена констант поднимает
// `BLANK_DETECTOR_VERSION`: кэш оценок с другой версией пересчитывается (KTD3).

/**
 * Версия алгоритма и констант; хранится в кэше оценок.
 * 2 — порог 5e-4 → 1.35e-4 (приёмка M4, 2026-10-23): бледный карандашный номер «1о» на
 * 200 dpi давал 2.8e-4 и скрывался.
 */
export const BLANK_DETECTOR_VERSION = 2;

/**
 * Рабочий размер — длинная сторона в пикселях (~120 dpi для A4). Уменьшение гасит шум сканера,
 * но не растворяет штрих карандаша; миниатюра 320×452 для этого мала (KTD2).
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

/**
 * Порог доли чернильных пикселей: ниже — пусто. Геометрическая середина между худшим пустым
 * (дырокол, 6.6e-5) и слабейшим содержимым (бледный карандашный номер, 2.8e-4) — запас по
 * двукратному в обе стороны; тест калибровки требует не меньше. Одиночная мелкая бледная
 * пометка всё же может оказаться ниже порога — её покажет переключатель «Пустые».
 */
export const BLANK_THRESHOLD = 0.000135;

/** Серые пиксели по строкам, без каналов: `width * height` байт. */
export interface GrayImage {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Доля чернильных пикселей серого изображения внутри обрезки полей (чистая функция —
 * `npm test`). Белое бумаги оценивается по самой картинке: серая или кремовая бумага не
 * становится «чернилами», а просвечивание с обратной стороны, которое светлее дельты, —
 * тоже. Вырожденная область (нет пикселей) — `0`.
 */
export function inkRatioOf({ data, width, height }: GrayImage): number {
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
  if (total === 0) {
    return 0;
  }
  // Белое бумаги — перцентиль яркости снизу.
  let seen = 0;
  let white = 255;
  for (let level = 0; level < 256; level += 1) {
    seen += histogram[level] ?? 0;
    if (seen >= total * PAPER_WHITE_PERCENTILE) {
      white = level;
      break;
    }
  }
  const inkBelow = white - INK_DELTA;
  let ink = 0;
  for (let level = 0; level < inkBelow; level += 1) {
    ink += histogram[level] ?? 0;
  }
  return ink / total;
}

/** Вердикт по доле: `null` (не оценена или сбой) — не пусто. */
export function isBlank(ratio: number | null): boolean {
  return ratio !== null && ratio < BLANK_THRESHOLD;
}

/**
 * Доля чернильных пикселей страницы JPEG (`sharp` — `test:integration`). Сбой — не JPEG,
 * превышение предела пикселей, ошибка декодирования — `null`: такая страница считается не
 * пустой и ошибкой не является (R6).
 */
export async function blankRatio(
  bytes: Uint8Array,
  pixelLimit: number | null,
): Promise<number | null> {
  if (!hasJpegMarkers(bytes)) {
    return null;
  }
  const limit = decodePixelLimit(pixelLimit);
  try {
    const image = sharp(bytes, { limitInputPixels: limit });
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
    return inkRatioOf({
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
    });
  } catch {
    return null;
  }
}

/** Детектор как зависимость службы проходов (KTD3): в тестах службы — заглушка. */
export type BlankDetector = (
  bytes: Uint8Array,
  pixelLimit: number | null,
) => Promise<number | null>;
