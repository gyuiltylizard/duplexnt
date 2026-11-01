import { setImmediate as yieldNow } from 'node:timers/promises';
import { skewLateralRows, skewTanRows, type SkewProfile } from '@shared';
import { MARGIN_RATIO, paperWhiteOf } from '../detect/gray';
import { hasJpegMarkers, withJfifDensity } from '../escl/jpeg-markers';
import { jfifDpi } from '../pdf/assemble';
import { decodePixelLimit } from '../storage/thumbnails';
import { processImage } from './sharp-image';

// Ресэмплер выравнивания (план M6, U3; KTD-1, KTD-3; амендмент 2026-10-28; ADR 0008).
// Геометрия линейного сенсора: лист, повёрнутый на θ(y) в момент строки y, смещает точку
// колонки x по вертикали на (x − xc)·tanθ(y), а поворот листа целиком даёт ещё боковой дрейф
// строки d(y) = ∫ tanθ. Обратное отображение: `y_src = y − (x − xc)·tanθ(y)`,
// `x_src = x + d(y)`. Два разделимых прохода по сырым пикселям `sharp` — вертикальный сдвиг
// столбцов в новый буфер и сдвиг строк на дрейф на месте в нём же, оба с интерполяцией
// Catmull-Rom. Полосы выходных строк по бюджету пикселей, между полосами — точка уступки:
// коррекция идёт в main чанками (ADR 0008). Порогов ресэмплер не знает — «ровно» и «не
// помогла» решает детектор (KTD-5).

/**
 * Кодирование выхода: качество и субдискретизация JPEG. Пишется в запись о коррекции (U11);
 * смена не вызывает пересчёта, в отличие от `STRAIGHTEN_GEOMETRY_VERSION` (KTD-6).
 */
export const STRAIGHTEN_ENCODING = 'jpeg-q92-444';
export const JPEG_QUALITY = 92;
export const CHROMA_SUBSAMPLING = '4:4:4';

/**
 * Бюджет полосы выходных строк, пикселей: 0,5 Мпикс держит чанк p95 ≤ 20 мс на 600 dpi цвет;
 * 1 Мпикс даёт max 30–36 мс, 2 Мпикс — 66–73 мс (ADR 0008). Строк в полосе — не фиксированное
 * число: 512 строк на 600 dpi цвет превысили бы порог паузы.
 */
export const WARP_BAND_PIXELS = 500_000;

/** Доля бокового дрейфа от интеграла tanθ: на ET-3850 лист поворачивается целиком (k ≈ 1). */
export const LATERAL_K = 1;

/**
 * Наибольшее отношение «выход / вход» по размеру файла на фикстурах и синтетике
 * (`test/integration/straighten.test.ts`) с запасом — резерв места перед коррекцией (KTD-13).
 * Было 2 при наибольшем ×1,94; цветной скан 200 dpi рабочей тетради (сжат сканером сильнее
 * нашего q92 4:4:4) дал ×2,12 — журнал 0030.
 */
export const STRAIGHT_SIZE_RATIO = 2.5;

/** Шаг выборки пикселей для белого бумаги на полном разрешении: каждая седьмая строка и колонка. */
const WHITE_SAMPLE_STEP = 7;

/** Сырые пиксели по строкам, `channels` байт на пиксель. */
export interface RawImage {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly channels: number;
}

export interface StraightenRawOptions {
  /** Бюджет полосы выходных строк, пикселей; по умолчанию `WARP_BAND_PIXELS`. */
  readonly bandPixels?: number;
  /** Точка уступки между полосами; по умолчанию — макрозадача (`setImmediate`). */
  readonly yieldBetween?: () => Promise<void>;
  /** Длительность каждого чанка, мс — тестам и бенчу. */
  readonly onChunk?: (ms: number) => void;
  /** Отмена между полосами: промис отклоняется причиной сигнала (KTD-12). */
  readonly signal?: AbortSignal;
}

export interface StraightenOptions extends StraightenRawOptions {
  /** Предел пикселей страницы (`origin.pixelLimit`); `null` — встроенный потолок. */
  readonly pixelLimit: number | null;
  /** Плотность выхода, dpi; `null` — из JFIF входа, а нет её — без плотности. */
  readonly dpi: number | null;
}

export interface StraightenResult {
  readonly jpeg: Uint8Array;
  readonly info: { readonly width: number; readonly height: number; readonly channels: number };
  readonly encoding: typeof STRAIGHTEN_ENCODING;
  /** Плотность, записанная в выход; `null` — не записана. */
  readonly dpi: number | null;
}

/**
 * Белое бумаги по каналам — перцентиль `PAPER_WHITE_PERCENTILE` яркости внутри обрезки полей
 * по разреженной выборке: заливка краёв после сдвига должна быть цвета бумаги, а не 255 на
 * кремовом скане и не чёрной.
 */
export function rawPaperWhite({ data, width, height, channels }: RawImage): number[] {
  const marginX = Math.round(width * MARGIN_RATIO);
  const marginY = Math.round(height * MARGIN_RATIO);
  const white: number[] = [];
  for (let c = 0; c < channels; c += 1) {
    const histogram = new Uint32Array(256);
    let total = 0;
    for (let y = marginY; y < height - marginY; y += WHITE_SAMPLE_STEP) {
      for (let x = marginX; x < width - marginX; x += WHITE_SAMPLE_STEP) {
        const level = data[(y * width + x) * channels + c] ?? 255;
        histogram[level] = (histogram[level] ?? 0) + 1;
        total += 1;
      }
    }
    white.push(paperWhiteOf(histogram, total));
  }
  return white;
}

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Полоса выходных строк [y0, y1): вертикальный сдвиг столбцов `src → out` с интерполяцией
 * Catmull-Rom по четырём соседям; у кромки — ближайшая строка, за кромкой — белое бумаги.
 */
function warpBand(
  src: Uint8Array,
  out: Uint8Array,
  { width, height, channels }: RawImage,
  tan: Float64Array,
  white: readonly number[],
  y0: number,
  y1: number,
): void {
  const stride = width * channels;
  const xc = width / 2;
  for (let y = y0; y < y1; y += 1) {
    const t = tan[y] ?? 0;
    const outRow = y * stride;
    for (let x = 0; x < width; x += 1) {
      const ys = y - (x - xc) * t;
      const iy = Math.floor(ys);
      const o = outRow + x * channels;
      if (iy - 1 < 0 || iy + 2 >= height) {
        if (iy < 0 || iy >= height) {
          for (let c = 0; c < channels; c += 1) {
            out[o + c] = white[c] ?? 255;
          }
        } else {
          const i = iy * stride + x * channels;
          for (let c = 0; c < channels; c += 1) {
            out[o + c] = src[i + c] ?? 0;
          }
        }
        continue;
      }
      const f = ys - iy;
      const f2 = f * f;
      const f3 = f2 * f;
      const w0 = -0.5 * f3 + f2 - 0.5 * f;
      const w1 = 1.5 * f3 - 2.5 * f2 + 1;
      const w2 = -1.5 * f3 + 2 * f2 + 0.5 * f;
      const w3 = 0.5 * f3 - 0.5 * f2;
      const i0 = (iy - 1) * stride + x * channels;
      for (let c = 0; c < channels; c += 1) {
        const v =
          w0 * (src[i0 + c] ?? 0) +
          w1 * (src[i0 + stride + c] ?? 0) +
          w2 * (src[i0 + 2 * stride + c] ?? 0) +
          w3 * (src[i0 + 3 * stride + c] ?? 0);
        out[o + c] = clamp(v + 0.5);
      }
    }
  }
}

/** Сдвиг строк [y0, y1) буфера на дрейф `drift[y]` на месте, Catmull-Rom по строке. */
function shiftBand(
  buf: Uint8Array,
  scratch: Uint8Array,
  { width, channels }: RawImage,
  drift: Float64Array,
  white: readonly number[],
  y0: number,
  y1: number,
): void {
  const stride = width * channels;
  for (let y = y0; y < y1; y += 1) {
    const d = drift[y] ?? 0;
    if (d === 0) {
      continue;
    }
    const row = y * stride;
    scratch.set(buf.subarray(row, row + stride));
    for (let x = 0; x < width; x += 1) {
      const xs = x + d;
      const ix = Math.floor(xs);
      const o = row + x * channels;
      if (ix - 1 < 0 || ix + 2 >= width) {
        const inside = ix >= 0 && ix < width;
        for (let c = 0; c < channels; c += 1) {
          buf[o + c] = inside ? (scratch[ix * channels + c] ?? 0) : (white[c] ?? 255);
        }
        continue;
      }
      const f = xs - ix;
      const f2 = f * f;
      const f3 = f2 * f;
      const w0 = -0.5 * f3 + f2 - 0.5 * f;
      const w1 = 1.5 * f3 - 2.5 * f2 + 1;
      const w2 = -1.5 * f3 + 2 * f2 + 0.5 * f;
      const w3 = 0.5 * f3 - 0.5 * f2;
      const i0 = (ix - 1) * channels;
      for (let c = 0; c < channels; c += 1) {
        const v =
          w0 * (scratch[i0 + c] ?? 0) +
          w1 * (scratch[i0 + channels + c] ?? 0) +
          w2 * (scratch[i0 + 2 * channels + c] ?? 0) +
          w3 * (scratch[i0 + 3 * channels + c] ?? 0);
        buf[o + c] = clamp(v + 0.5);
      }
    }
  }
}

/**
 * Выправленные сырые пиксели того же размера (чистая функция — `npm test`): полосами выходных
 * строк по бюджету; в каждой полосе — вертикальный сдвиг столбцов в новый буфер и сразу сдвиг
 * этих строк на боковой дрейф на месте. Порядок проходов обратен синтетике и спайку
 * (там — сначала дрейф), ошибка перестановки второго порядка (≤ 0,2 px на 600 dpi при 0,8°),
 * зато вход не портится и буферов два, а не три. Нулевой профиль — выход равен входу байт в
 * байт. Вход не меняется.
 */
export async function straightenRaw(
  raw: RawImage,
  profile: SkewProfile,
  options: StraightenRawOptions = {},
): Promise<Uint8Array> {
  const { width, height, channels } = raw;
  const bandPixels = options.bandPixels ?? WARP_BAND_PIXELS;
  const yieldBetween = options.yieldBetween ?? (() => yieldNow());
  const tan = skewTanRows(profile, height);
  const drift = skewLateralRows(tan, LATERAL_K);
  const white = rawPaperWhite(raw);
  const out = new Uint8Array(raw.data.length);
  const scratch = new Uint8Array(width * channels);
  const rowsPerBand = Math.max(1, Math.floor(bandPixels / width));
  for (let y0 = 0; y0 < height; y0 += rowsPerBand) {
    options.signal?.throwIfAborted();
    const started = performance.now();
    const y1 = Math.min(height, y0 + rowsPerBand);
    warpBand(raw.data, out, raw, tan, white, y0, y1);
    shiftBand(out, scratch, raw, drift, white, y0, y1);
    options.onChunk?.(performance.now() - started);
    await yieldBetween();
  }
  return out;
}

/**
 * Выправленная страница JPEG по профилю (`sharp` — `test:integration`): декод в сырые пиксели
 * с пределом, коррекция, JPEG q92 4:4:4 того же размера и числа каналов (серый остаётся
 * одноканальным явно — иначе `sharp` кодирует серый буфер трёхканальным), плотность — в JFIF.
 * Сбой — не JPEG, превышение предела, ошибка декодирования, нежданное число каналов, сбой
 * кодирования — `null`: страница остаётся как есть (R24). Отмена — исключение причиной сигнала.
 */
export async function straighten(
  bytes: Uint8Array,
  profile: SkewProfile,
  options: StraightenOptions,
): Promise<StraightenResult | null> {
  if (!hasJpegMarkers(bytes)) {
    return null;
  }
  // Уже отменённая задача не декодирует страницу (до секунды и сотни мегабайт на 600 dpi цвет).
  options.signal?.throwIfAborted();
  const limit = decodePixelLimit(options.pixelLimit);
  // Срок обработки (B-21) — тоже сбой декода, `null`: очередь отложит страницу со сбоем в памяти.
  let raw: (RawImage & { readonly channels: 1 | 3 }) | null;
  try {
    raw = await processImage({ kind: 'jpeg', bytes, pixelLimit: limit }, async (image) => {
      const meta = await image.metadata();
      if (meta.format !== 'jpeg' || meta.width * meta.height > limit) {
        return null;
      }
      // Серый JPEG `sharp` отдаёт сырым в sRGB тремя каналами, если не попросить одноканальный.
      const { data, info } = await (meta.channels === 1 ? image.toColourspace('b-w') : image)
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (info.channels !== 1 && info.channels !== 3) {
        return null;
      }
      return {
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        width: info.width,
        height: info.height,
        channels: info.channels,
      };
    });
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  const { channels } = raw;
  const out = await straightenRaw(raw, profile, options);
  // Отмена на последней полосе: цикл полос её уже не увидит, кодировать незачем.
  options.signal?.throwIfAborted();
  try {
    const { width, height } = raw;
    const dpi = options.dpi ?? jfifDpi(bytes);
    const encoded = await processImage(
      { kind: 'raw', bytes: out, width, height, channels },
      (image) =>
        (channels === 1 ? image.toColourspace('b-w') : image)
          .jpeg({ quality: JPEG_QUALITY, chromaSubsampling: CHROMA_SUBSAMPLING })
          .toBuffer(),
    );
    const bare = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    const output = dpi === null ? { jpeg: bare, dpi: null } : withJfifDensity(bare, dpi);
    return { ...output, info: { width, height, channels }, encoding: STRAIGHTEN_ENCODING };
  } catch (error: unknown) {
    // Отмена — исключение причиной сигнала; сбой libvips и срок (B-21) при кодировании — `null`,
    // как и при декоде;
    // ошибки самого ресэмплера и колбэков вызывающего (`onChunk`, `yieldBetween`) сюда не попадают —
    // они пробрасываются.
    if (options.signal?.aborted === true) {
      throw error;
    }
    return null;
  }
}
