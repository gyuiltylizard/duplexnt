import sharp from 'sharp';
import { FAN_LINE_MM } from '@shared';
import { marginHistogramOf, paperWhiteOf, type GrayImage } from '../../src/core/detect/gray';

// Анализ скана тестового листа-сетки (план M6; амендмент 2026-10-28 → «инструмент — анализ
// сетки из спайка, переносится в test/support»): на полном разрешении отслеживаются
// горизонтальные и вертикальные линии сетки 10 мм, по ним — угол каждой горизонтали (θ, + =
// правый конец выше), наклон и изгиб вертикалей и веер — расхождение концов линии длиной
// `FAN_LINE_MM` между крайними углами (R23). Эталон для детектора (U2) и ресэмплера (U3);
// прототип — `spikes/straighten-bench.mjs grid`.

const DEG = Math.PI / 180;

/** Число полос-срезов поперёк линий и доля отступа от края для их размещения. */
const STRIPS = 17;
const INNER = 0.06;

export interface GridHorizontal {
  /** Доля высоты центра линии. */
  readonly u: number;
  readonly yMm: number;
  /** Угол линии, градусы: + — правый конец выше. */
  readonly theta: number;
  /** Отклонение от прямой, мм. */
  readonly bowMm: number;
}

export interface GridVertical {
  readonly xMm: number;
  /** Наклон в единицах угла поворота листа: при повороте tilt ≈ θ горизонталей. */
  readonly tilt: number;
  readonly bowMm: number;
  /** Боковой уход нижнего конца относительно верхнего, мм, и пролёт между ними. */
  readonly driftMm: number;
  readonly spanMm: number;
}

export interface GridAnalysis {
  readonly width: number;
  readonly height: number;
  readonly dpi: number;
  readonly horizontals: readonly GridHorizontal[];
  readonly verticals: readonly GridVertical[];
  /** Веер: расхождение концов линии `FAN_LINE_MM` между крайними углами горизонталей, мм. */
  readonly fanMm: number;
  /** Средний наклон вертикалей, градусы. */
  readonly meanTilt: number;
}

interface Sample {
  readonly along: number;
  readonly across: number;
}

/** Центроиды тёмных пробегов профиля; пробег длиннее `maxRun` — не линия. */
function peaksOf(profile: Float64Array, minValue: number, maxRun: number): number[] {
  const peaks: number[] = [];
  let start = -1;
  let weight = 0;
  let moment = 0;
  for (let i = 0; i <= profile.length; i += 1) {
    const v = i < profile.length ? (profile[i] ?? 0) : 0;
    if (v >= minValue) {
      if (start < 0) {
        start = i;
      }
      weight += v;
      moment += v * i;
    } else if (start >= 0) {
      if (i - start <= maxRun) {
        peaks.push(moment / weight);
      }
      start = -1;
      weight = 0;
      moment = 0;
    }
  }
  return peaks;
}

/** Следы линий поперёк срезов: от центрального среза наружу, ближайший пик в допуске. */
function trackLines(
  stripPeaks: readonly (readonly number[])[],
  positions: readonly number[],
  tolerance: number,
): Sample[][] {
  const center = Math.floor(stripPeaks.length / 2);
  const lines: Sample[][] = [];
  for (const seed of stripPeaks[center] ?? []) {
    const points: Sample[] = [{ along: positions[center] ?? 0, across: seed }];
    const walk = (direction: 1 | -1): void => {
      let last = seed;
      for (let s = center + direction; s >= 0 && s < stripPeaks.length; s += direction) {
        let best: number | null = null;
        for (const p of stripPeaks[s] ?? []) {
          if (
            Math.abs(p - last) <= tolerance &&
            (best === null || Math.abs(p - last) < Math.abs(best - last))
          ) {
            best = p;
          }
        }
        if (best === null) {
          break;
        }
        points.push({ along: positions[s] ?? 0, across: best });
        last = best;
      }
    };
    walk(-1);
    walk(1);
    points.sort((p, q) => p.along - q.along);
    lines.push(points);
  }
  return lines;
}

function linearFit(points: readonly Sample[]): { slope: number; intercept: number; bow: number } {
  const n = points.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const { along, across } of points) {
    sx += along;
    sy += across;
    sxx += along * along;
    sxy += along * across;
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  let bow = 0;
  for (const { along, across } of points) {
    bow = Math.max(bow, Math.abs(across - (intercept + slope * along)));
  }
  return { slope, intercept, bow };
}

/** Серое полного разрешения — без уменьшения, чтобы мерить десятые доли миллиметра. */
export async function decodeFullGray(bytes: Uint8Array): Promise<GrayImage> {
  const { data, info } = await sharp(bytes, { limitInputPixels: 80_000_000 })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

/** Веер по углам горизонталей: расхождение концов линии между крайними углами, мм. */
export function fanOf(horizontals: readonly GridHorizontal[], lineMm = FAN_LINE_MM): number {
  if (horizontals.length === 0) {
    return 0;
  }
  const thetas = horizontals.map((h) => h.theta);
  return lineMm * Math.tan((Math.max(...thetas) - Math.min(...thetas)) * DEG);
}

/** Анализ скана сетки (JPEG) на полном разрешении при известном DPI. */
export async function analyzeGrid(bytes: Uint8Array, dpi: number): Promise<GridAnalysis> {
  const gray = await decodeFullGray(bytes);
  const { data, width, height } = gray;
  const pxPerMm = dpi / 25.4;
  const { histogram, total } = marginHistogramOf(gray);
  const inkBelow = paperWhiteOf(histogram, total) - 60;
  const ink = (x: number, y: number): boolean => (data[y * width + x] ?? 255) < inkBelow;
  const stripWidth = Math.round(4 * pxPerMm);
  const maxRun = Math.round(2 * pxPerMm);
  const tolerance = Math.round(3 * pxPerMm);
  const positions = (size: number): number[] =>
    Array.from({ length: STRIPS }, (_, i) =>
      Math.round(size * (INNER + ((1 - 2 * INNER) * i) / (STRIPS - 1))),
    );

  // Горизонтали: срезы-столбцы по x, профиль по y.
  const xPositions = positions(width);
  const hPeaks = xPositions.map((xp) => {
    const profile = new Float64Array(height);
    for (let y = Math.round(height * 0.02); y < height * 0.98; y += 1) {
      let count = 0;
      for (let x = xp - stripWidth / 2; x < xp + stripWidth / 2; x += 1) {
        if (ink(Math.round(x), y)) {
          count += 1;
        }
      }
      profile[y] = count;
    }
    return peaksOf(profile, stripWidth * 0.5, maxRun);
  });
  const horizontals = trackLines(hPeaks, xPositions, tolerance)
    .filter((points) => points.length >= STRIPS * 0.8)
    .map((points) => {
      const fit = linearFit(points);
      const yCenter = fit.intercept + fit.slope * (width / 2);
      return {
        u: yCenter / height,
        yMm: yCenter / pxPerMm,
        theta: -Math.atan(fit.slope) / DEG,
        bowMm: fit.bow / pxPerMm,
      };
    })
    .sort((p, q) => p.u - q.u);

  // Вертикали: срезы-строки по y, профиль по x.
  const yPositions = positions(height);
  const vPeaks = yPositions.map((yp) => {
    const profile = new Float64Array(width);
    for (let x = Math.round(width * 0.02); x < width * 0.98; x += 1) {
      let count = 0;
      for (let y = yp - stripWidth / 2; y < yp + stripWidth / 2; y += 1) {
        if (ink(x, Math.round(y))) {
          count += 1;
        }
      }
      profile[x] = count;
    }
    return peaksOf(profile, stripWidth * 0.5, maxRun);
  });
  const verticals = trackLines(vPeaks, yPositions, tolerance)
    .filter((points) => points.length >= STRIPS * 0.8)
    .map((points) => {
      const fit = linearFit(points);
      const xCenter = fit.intercept + fit.slope * (height / 2);
      const top = points[0] ?? { along: 0, across: 0 };
      const bottom = points[points.length - 1] ?? top;
      // Поворот листа на φ даёт горизонталям dy/dx = tanφ, вертикалям dx/dy = −tanφ.
      return {
        xMm: xCenter / pxPerMm,
        tilt: Math.atan(fit.slope) / DEG,
        bowMm: fit.bow / pxPerMm,
        driftMm: (bottom.across - top.across) / pxPerMm,
        spanMm: (bottom.along - top.along) / pxPerMm,
      };
    })
    .sort((p, q) => p.xMm - q.xMm);

  const meanTilt =
    verticals.length === 0 ? 0 : verticals.reduce((s, v) => s + v.tilt, 0) / verticals.length;
  return { width, height, dpi, horizontals, verticals, fanMm: fanOf(horizontals), meanTilt };
}

/** DPI по имени скана-фикстуры `<что>-<gray|color>-<dpi>`. */
export function dpiOfScanName(name: string): number {
  const dpi = Number(name.slice(name.lastIndexOf('-') + 1));
  if (!Number.isInteger(dpi) || dpi <= 0) {
    throw new Error(`в имени скана нет DPI: ${name}`);
  }
  return dpi;
}
