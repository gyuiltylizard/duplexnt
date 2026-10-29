import type { GrayImage } from '../../src/core/detect/gray';
import { withJfifDensity } from '../../src/core/escl/jpeg-markers';

// Синтетическая «страница» для детектора перекоса и ресэмплера (план M6, U2–U3): идеальная
// страница в миллиметрах (строки текста из штрихов, пробелы, короткие строки) искажается
// заданным профилем θ(u) в геометрии KTD-1 — вертикальный сдвиг (x − xc)·tanθ(y) — и, по
// желанию, боковым дрейфом поворота листа целиком (амендмент 2026-10-28). Детерминирована:
// хеш вместо генератора случайных чисел, так что картинка одна при каждом прогоне.

export const A4_WIDTH_MM = 210;
export const A4_HEIGHT_MM = 297;

/** Рабочий размер детектора: A4 с длинной стороной 1400 px. */
export const WORKING_WIDTH = 990;
export const WORKING_HEIGHT = 1400;

const DEG = Math.PI / 180;

/** Угол строк (градусы) по доле высоты. */
export type ThetaOf = (u: number) => number;

export type SyntheticContent =
  /** Строки текста по всему листу. */
  | 'text'
  /** Чистый лист. */
  | 'blank'
  /** Строки только в одной узкой полосе посередине — мало полос для профиля. */
  | 'band'
  /** Сплошная тёмная «фотография» без строк — чернил больше допустимого. */
  | 'photo'
  /** Сетка 10 мм, как тестовые листы U1: горизонтали и вертикали для анализа сетки. */
  | 'grid';

export interface SyntheticPageOptions {
  readonly width?: number;
  readonly height?: number;
  readonly theta: ThetaOf;
  /** Боковой дрейф поворота листа: `x_in = x − ∫tanθ`; без него — чистый вертикальный сдвиг. */
  readonly lateral?: boolean;
  readonly content?: SyntheticContent;
  /** Размах шума сканера, уровней из 255. */
  readonly noise?: number;
}

/** Хеш целого в [0, 1): одинаковая «случайность» при каждом прогоне. */
export function hash01(i: number): number {
  let h = (i ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

/** Шаг строк текста, мм, и границы текстового блока. */
export const LINE_PITCH_MM = 4.5;
const TEXT_TOP_MM = 25;
const TEXT_BOTTOM_MM = 275;
const TEXT_LEFT_MM = 20;
const TEXT_RIGHT_MM = 190;

/** Сетка: линии 0,4 мм с шагом 10 мм в этих пределах по обеим осям. */
const GRID_FROM_MM = 15;
const GRID_TO_MM = 195;

/** Строка текста короче блока (последняя в абзаце) — концы такой строки мерить нельзя. */
export const isShortLine = (lineIndex: number): boolean => hash01(lineIndex * 7919) < 0.12;

/** Ближайшая к `lineIndex` полная строка. */
export function fullLineNear(lineIndex: number): number {
  for (let delta = 0; ; delta += 1) {
    if (!isShortLine(lineIndex + delta)) {
      return lineIndex + delta;
    }
    if (lineIndex - delta >= 0 && !isShortLine(lineIndex - delta)) {
      return lineIndex - delta;
    }
  }
}

/** Идеальная страница (яркость 0..1) в координатах без искажения, мм. */
export function idealPage(xMm: number, yMm: number, content: SyntheticContent): number {
  if (content === 'blank') {
    return 1;
  }
  if (content === 'grid') {
    const near = (mm: number): boolean =>
      mm >= GRID_FROM_MM && mm <= GRID_TO_MM && Math.abs(mm - Math.round(mm / 10) * 10) <= 0.2;
    return near(xMm) || near(yMm) ? 0.15 : 1;
  }
  if (content === 'photo') {
    // Плавные тёмные пятна: без строк, чернил больше 30 %.
    const v = 0.5 + 0.35 * Math.sin(xMm / 17) * Math.cos(yMm / 23) + 0.1 * Math.sin(yMm / 5);
    return Math.max(0, Math.min(1, v * 0.6));
  }
  if (xMm < TEXT_LEFT_MM || xMm > TEXT_RIGHT_MM || yMm < TEXT_TOP_MM || yMm > TEXT_BOTTOM_MM) {
    return 1;
  }
  if (content === 'band' && (yMm < 140 || yMm > 158)) {
    return 1;
  }
  const lineIndex = Math.floor((yMm - TEXT_TOP_MM) / LINE_PITCH_MM);
  const inLine = yMm - TEXT_TOP_MM - lineIndex * LINE_PITCH_MM;
  if (inLine > 2.2) {
    return 1; // межстрочный просвет
  }
  if (isShortLine(lineIndex) && xMm > TEXT_LEFT_MM + 170 * hash01(lineIndex * 31)) {
    return 1; // короткая строка
  }
  const wordIndex = Math.floor(xMm / 1.6);
  if (hash01(lineIndex * 104729 + wordIndex) < 0.18) {
    return 1; // пробел между словами
  }
  const stroke =
    hash01(lineIndex * 1301 + Math.floor(xMm / 0.45)) < 0.55 || inLine < 0.35 || inLine > 1.85;
  return stroke ? 0.15 : 0.85;
}

/** Сглаженная ступень `top` → `bottom` с центром `u0` и шириной `w` (логистика, как в M6.5). */
export const stepTheta =
  (top: number, bottom: number, u0: number, w: number): ThetaOf =>
  (u) =>
    top + (bottom - top) / (1 + Math.exp((-4 * (u - u0)) / w));

/** Дуга a + b(u − ½) + c(u − ½)². */
export const quadraticTheta =
  (a: number, b: number, c: number): ThetaOf =>
  (u) =>
    a + b * (u - 0.5) + c * (u - 0.5) ** 2;

/** tanθ по строкам и боковой дрейф (интеграл tanθ от середины), пиксели. */
export function distortionRows(
  theta: ThetaOf,
  height: number,
  lateral: boolean,
): { tan: Float64Array; drift: Float64Array } {
  const tan = new Float64Array(height);
  for (let y = 0; y < height; y += 1) {
    tan[y] = Math.tan(theta((y + 0.5) / height) * DEG);
  }
  const drift = new Float64Array(height);
  if (lateral) {
    const yc = Math.floor(height / 2);
    let acc = 0;
    for (let y = yc; y < height; y += 1) {
      drift[y] = acc;
      acc += tan[y] ?? 0;
    }
    acc = 0;
    for (let y = yc - 1; y >= 0; y -= 1) {
      acc -= tan[y] ?? 0;
      drift[y] = acc;
    }
  }
  return { tan, drift };
}

/**
 * Серая страница рабочего размера, искажённая профилем: `in(x, y) = ideal(x − d(y),
 * y + (x − xc)·tanθ(y))` — обратное к коррекции `y_src = y − (x − xc)·tanθ`, `x_src = x + d`.
 */
export function syntheticGray({
  width = WORKING_WIDTH,
  height = WORKING_HEIGHT,
  theta,
  lateral = false,
  content = 'text',
  noise = 18,
}: SyntheticPageOptions): GrayImage {
  const pxPerMm = height / A4_HEIGHT_MM;
  const { tan, drift } = distortionRows(theta, height, lateral);
  const xc = width / 2;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const t = tan[y] ?? 0;
    const d = drift[y] ?? 0;
    for (let x = 0; x < width; x += 1) {
      const ySrc = y + (x - xc) * t;
      const xSrc = x - d;
      const v = idealPage(xSrc / pxPerMm, ySrc / pxPerMm, content);
      const n = (hash01(y * width + x) - 0.5) * noise;
      data[y * width + x] = Math.max(0, Math.min(255, Math.round(v * 240 + 8 + n)));
    }
  }
  return { data, width, height };
}

/**
 * Та же страница как JPEG заданного DPI (A4) — для тестов через `sharp` (`test:integration`).
 * `channels` 3 — цветная с лёгким оттенком, чтобы декод в серое был не тождеством.
 */
export async function syntheticJpeg(
  options: Omit<SyntheticPageOptions, 'width' | 'height'> & { dpi: number; channels?: 1 | 3 },
): Promise<Buffer> {
  const { dpi, channels = 1, ...rest } = options;
  const width = Math.round((A4_WIDTH_MM * dpi) / 25.4);
  const height = Math.round((A4_HEIGHT_MM * dpi) / 25.4);
  const gray = syntheticGray({ ...rest, width, height });
  let raw: Uint8Array = gray.data;
  if (channels === 3) {
    raw = new Uint8Array(width * height * 3);
    for (let i = 0; i < gray.data.length; i += 1) {
      const g = gray.data[i] ?? 0;
      raw[i * 3] = g;
      raw[i * 3 + 1] = Math.min(255, g + 3);
      raw[i * 3 + 2] = Math.min(255, g + 6);
    }
  }
  const { default: sharp } = await import('sharp');
  const image = sharp(raw, { raw: { width, height, channels } });
  // Серый — одноканальным явно, плотность — в JFIF руками: `withMetadata({density})` у `sharp`
  // переводит выход в sRGB тремя каналами с профилем ICC.
  const jpeg = await (channels === 1 ? image.toColourspace('b-w') : image)
    .jpeg({ quality: 85 })
    .toBuffer();
  return Buffer.from(withJfifDensity(jpeg, dpi).jpeg);
}

/**
 * Просвет внутри строки, который ещё не разделяет пробеги: светлые штрихи середины строки
 * (0,85) под порог чернил не попадают, и между тёмными кромками — до 7 px; межстрочный
 * просвет — 10,8 px.
 */
const MERGE_GAP_PX = 8;

/**
 * Положение полной строки текста в искажённой картинке у левого и правого края текстового
 * блока, пиксели: по узкому столбцу строится профиль чернил по строкам, из пробегов чернил
 * берётся ближайший к ожидаемому y (соседние строки, вошедшие в окно из-за сдвига, не
 * мешают). Проверяет соглашение о знаке по пикселям, а не по формуле. Короткая строка — `null`.
 */
export function lineEndsAt(
  gray: GrayImage,
  lineIndex: number,
): { left: number; right: number } | null {
  if (isShortLine(lineIndex)) {
    return null;
  }
  const pxPerMm = gray.height / A4_HEIGHT_MM;
  const nominal = (TEXT_TOP_MM + lineIndex * LINE_PITCH_MM + 1.1) * pxPerMm;
  const centroid = (xMm: number): number | null => {
    const x0 = Math.round((xMm - 1.5) * pxPerMm);
    const x1 = Math.round((xMm + 1.5) * pxPerMm);
    const y0 = Math.round(nominal - LINE_PITCH_MM * pxPerMm);
    const y1 = Math.round(nominal + LINE_PITCH_MM * pxPerMm);
    // Пробег чернил — с просветами до `MERGE_GAP_PX`: у строки из светлых штрихов в окне могут
    // остаться одни тёмные кромки сверху и снизу, и без слияния каждая была бы «своей» строкой.
    const runs: { weight: number; moment: number }[] = [];
    let run: { weight: number; moment: number } | null = null;
    let gap = 0;
    for (let y = y0; y <= y1 + MERGE_GAP_PX + 1; y += 1) {
      let ink = 0;
      for (let x = x0; x <= x1 && y <= y1; x += 1) {
        ink += Math.max(0, 200 - (gray.data[y * gray.width + x] ?? 255));
      }
      if (ink > 0) {
        run ??= { weight: 0, moment: 0 };
        run.weight += ink;
        run.moment += ink * y;
        gap = 0;
      } else if (run !== null) {
        gap += 1;
        if (gap > MERGE_GAP_PX) {
          runs.push(run);
          run = null;
        }
      }
    }
    let best: number | null = null;
    for (const { weight, moment } of runs) {
      const y = moment / weight;
      if (best === null || Math.abs(y - nominal) < Math.abs(best - nominal)) {
        best = y;
      }
    }
    return best;
  };
  const left = centroid(TEXT_LEFT_MM + 6);
  const right = centroid(TEXT_RIGHT_MM - 6);
  return left === null || right === null ? null : { left, right };
}
