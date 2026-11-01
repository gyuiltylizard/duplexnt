import { setImmediate as yieldNow } from 'node:timers/promises';
import {
  skewFanMm,
  skewMaxAbsDeg,
  skewProfileOf,
  skewTanRows,
  STRAIGHTEN_GEOMETRY_VERSION,
  type SkewBand,
  type SkewBandReason,
  type SkewBasis,
  type SkewCause,
  type SkewContrast,
  type SkewMeasure,
  type SkewPrior,
  type SkewProfile,
} from '@shared';
import {
  decodeWorkingGray,
  INK_DELTA,
  marginHistogramOf,
  paperWhiteOf,
  type GrayImage,
} from './gray';

// Детектор перекоса подачи (план M6, U2; KTD-2, KTD-5; амендмент 2026-10-28). Серая рабочая
// картинка режется на полосы по высоте; в каждой полосе угол строк ищется по резкости
// строкового профиля чернильных пикселей (как Leptonica `pixFindSkew`): грубый перебор,
// уточнение, парабола. Валидные полосы дают узлы профиля θ(u); гейты — уверенность, доля
// чернил, согласие половин полосы, число и покрытие полос, правдоподобие формы. Исход —
// по порогу движения и независимой метрике «не хуже»: резкость строкового профиля всей
// страницы до и после сдвига по профилю.
//
// Константы — стартовые значения из спайка U1 на сканах ET-3850 (техбаза → «Перекос подачи:
// спайк» → «Стартовые константы U2»), откалиброваны табличным тестом
// `test/integration/skew-detector.test.ts`. Смена констант, меняющая исход или профиль,
// поднимает `SKEW_DETECTOR_VERSION`; смена геометрии — `STRAIGHTEN_GEOMETRY_VERSION` в
// `@shared`.

// Версия детектора — в `skew-version.ts` (без импортов, B-19); отсюда — реэкспорт.
export { SKEW_DETECTOR_VERSION } from './skew-version';

/** Номинальная высота листа — для перевода миллиметров полосы в пиксели рабочей картинки. */
const PAGE_HEIGHT_MM = 297;

/** Маска по краям с каждой стороны, доля размера: тень кромки и срез листа. */
export const EDGE_MASK = 0.03;

/**
 * Высота полосы, мм, и шаг 50 %: на сетках ET-3850 30 мм дают остаток ≤ 0,5 мм (колени
 * ступени), 50 мм — до 0,6 мм; но узкие полосы шумнее, и при провале гейта формы детектор
 * повторяет проход полосами `FALLBACK_BAND_MM` (две колонки проходят только так).
 */
export const BAND_MM = 30;
export const FALLBACK_BAND_MM = 50;
export const BAND_OVERLAP = 0.5;

/** Грубый перебор ±2° шагом 0,2°, уточнение ±0,25° шагом 0,05° и парабола по трём точкам. */
export const COARSE_RANGE_DEG = 2;
export const COARSE_STEP_DEG = 0.2;
export const FINE_RANGE_DEG = 0.25;
export const FINE_STEP_DEG = 0.05;

/** Грубый перебор идёт по каждому второму пикселю, если их в полосе больше. */
const STRIDE_ABOVE = 20_000;

/** Меньше пикселей — угол не ищется. */
const MIN_PIXELS = 50;

/** Доля чернил полосы: ниже — пусто; выше — не документ (фото, заливка), строк там нет. */
export const MIN_INK_FRACTION = 0.005;
export const MAX_INK_FRACTION = 0.3;

/** Уверенность полосы — лучший счёт резкости к худшему по грубому перебору. */
export const CONFIDENCE_MIN = 3;

/** Возражающие половины полосы обязаны дать один угол: две колонки и графика расходятся. */
export const HALVES_TOLERANCE_DEG = 0.25;
/**
 * Половина полосы возражает углу целой полосы, если её собственный пик резкости лучше счёта при
 * угле целой хотя бы во столько раз. У половины с одной плашкой, рисками линейки или пустой
 * бумагой пик плоский (1,00–1,12 на сканах ET-3850) — её угол шум, и вето полосе он не
 * накладывает; у колонки с другой фазой строк и у косой штриховки — 1,28–1,98.
 */
export const HALF_OBJECTION_MIN = 1.2;

/** Валидных полос не меньше и покрывают они не меньше такой доли высоты. */
export const MIN_BANDS = 3;
export const MIN_COVERAGE = 0.4;

/** Дыра в покрытии валидными полосами больше — узлам не на что опереться, берётся прямая. */
export const MAX_SUPPORT_GAP = 0.4;

/**
 * Гейт формы: полосы обязаны лечь хотя бы на одно гладкое семейство — дугу или ступень —
 * с таким остатком; прыгающие углы (две колонки, штриховка) не ложатся ни на одно. Строгий
 * порог — для прямой при дыре покрытия: опора у неё — две кучки полос, и остаток 0,1° там уже
 * значит «полосы спорят» (штриховка: верх 0,97°, низ −0,15°, середина пуста).
 */
export const SHAPE_RESIDUAL_MAX_DEG = 0.1;

/**
 * Порог формы для профиля узлами по плотной опоре (журнал 0030): полосы идут по всей высоте, и
 * шум соседних полос 0,1–0,2° на графичной странице (линии, рамки, крупные цифры) не значит, что
 * форма не сошлась — лист с рабочей тетрадью: углы от +0,55° сверху до −0,57° снизу, половины
 * согласны, остаток ступени 0,17° при 30 мм. Ловушки этим не проходят: у штриховки дыра опоры —
 * прямая, строгий порог.
 */
export const SHAPE_RESIDUAL_DENSE_MAX_DEG = 0.2;

/** Порог движения: |θ| ниже по всей высоте — страница ровная, оригинал байт в байт (R10). */
export const LEVEL_DEG = 0.1;

/** Запас «не хуже»: контраст строк после сдвига выше исходного не меньше чем во столько. */
export const IMPROVE_RATIO = 1.3;

/** Вес полосы в подгонках формы — уверенность, не выше этого. */
const MAX_WEIGHT = 20;

const DEG = Math.PI / 180;

export interface MeasureSkewOptions {
  /** Точка уступки между полосами; по умолчанию — макрозадача (`setImmediate`). */
  readonly yieldBetween?: () => Promise<void>;
  /** Длительность каждого чанка, мс — тестам и бенчу. */
  readonly onChunk?: (ms: number) => void;
  /**
   * Подсказка устройства (R4; точка врезки M6.5): усилитель, когда по содержимому мерить
   * нечем. В M6 принимается и не читается — поведение без неё полное.
   */
  readonly prior?: SkewPrior | null;
  /** Отмена между полосами: промис отклоняется причиной сигнала (KTD-12). */
  readonly signal?: AbortSignal;
}

/** Детерминированный дробный сдвиг строки пикселя: одинаковое размытие при любом угле. */
const jitter = (i: number): number => (Math.imul(i, 0x9e3779b1) >>> 0) / 2 ** 32;

/** Резкость строкового профиля: Σ(p[i+1] − p[i])². */
function profileScore(bins: Float64Array): number {
  let score = 0;
  for (let i = 1; i < bins.length; i += 1) {
    const d = (bins[i] ?? 0) - (bins[i - 1] ?? 0);
    score += d * d;
  }
  return score;
}

/** Строковый профиль чернил при наклоне на угол (градусы): субпиксельное распределение. */
function projectAt(
  xs: Float32Array,
  ys: Float32Array,
  ws: Float32Array,
  stride: number,
  angleDeg: number,
  bins: Float64Array,
  offset: number,
): number {
  bins.fill(0);
  const t = Math.tan(angleDeg * DEG);
  const last = bins.length - 1;
  for (let i = 0; i < xs.length; i += stride) {
    const row = (ys[i] ?? 0) + (xs[i] ?? 0) * t + offset;
    const base = Math.floor(row);
    if (base < 0 || base >= last) {
      continue;
    }
    const f = row - base;
    const w = ws[i] ?? 0;
    bins[base] = (bins[base] ?? 0) + w * (1 - f);
    bins[base + 1] = (bins[base + 1] ?? 0) + w * f;
  }
  return profileScore(bins);
}

interface Pixels {
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly ws: Float32Array;
}

function filterPixels(pixels: Pixels, keep: (x: number) => boolean): Pixels {
  const indices: number[] = [];
  for (let i = 0; i < pixels.xs.length; i += 1) {
    if (keep(pixels.xs[i] ?? 0)) {
      indices.push(i);
    }
  }
  return {
    xs: Float32Array.from(indices, (i) => pixels.xs[i] ?? 0),
    ys: Float32Array.from(indices, (i) => pixels.ys[i] ?? 0),
    ws: Float32Array.from(indices, (i) => pixels.ws[i] ?? 0),
  };
}

interface AngleEstimate {
  readonly angle: number | null;
  readonly confidence: number;
  /** Счёт резкости в пике (полный перебор, шаг 1). */
  readonly score: number;
}

/**
 * Угол по списку пикселей полосы: грубый перебор, уточнение, парабола. `around` — искать
 * только в окрестности этого угла (половины полосы ищутся около угла целой полосы).
 */
function angleOf(
  { xs, ys, ws }: Pixels,
  bins: Float64Array,
  offset: number,
  around: number | null = null,
): AngleEstimate {
  const total = xs.length;
  if (total < MIN_PIXELS) {
    return { angle: null, confidence: 0, score: 0 };
  }
  const stride = total > STRIDE_ABOVE ? 2 : 1;
  let best = -Infinity;
  let bestAngle = 0;
  let worst = Infinity;
  const from = around === null ? -COARSE_RANGE_DEG : around - 3 * COARSE_STEP_DEG;
  const to = around === null ? COARSE_RANGE_DEG : around + 3 * COARSE_STEP_DEG;
  for (let angle = from; angle <= to + 1e-9; angle += COARSE_STEP_DEG) {
    const score = projectAt(xs, ys, ws, stride, angle, bins, offset);
    if (score > best) {
      best = score;
      bestAngle = angle;
    }
    if (score < worst) {
      worst = score;
    }
  }
  const fine: { angle: number; score: number }[] = [];
  for (
    let angle = bestAngle - FINE_RANGE_DEG;
    angle <= bestAngle + FINE_RANGE_DEG + 1e-9;
    angle += FINE_STEP_DEG
  ) {
    fine.push({ angle, score: projectAt(xs, ys, ws, 1, angle, bins, offset) });
  }
  let k = 0;
  for (let i = 1; i < fine.length; i += 1) {
    if ((fine[i]?.score ?? 0) > (fine[k]?.score ?? 0)) {
      k = i;
    }
  }
  const peak = fine[k] ?? { angle: bestAngle, score: best };
  let angle = peak.angle;
  const before = fine[k - 1];
  const after = fine[k + 1];
  if (before !== undefined && after !== undefined) {
    const denominator = before.score - 2 * peak.score + after.score;
    if (denominator < 0) {
      angle += (FINE_STEP_DEG * (before.score - after.score)) / (2 * denominator);
    }
  }
  // Счёт полного перебора приводится к масштабу грубого (шаг 2 — четверть счёта).
  const bestAtCoarseScale = peak.score / (stride * stride);
  return {
    angle,
    confidence: worst > 0 ? bestAtCoarseScale / worst : Infinity,
    score: peak.score,
  };
}

interface HalfEstimate {
  readonly angle: number | null;
  /** Собственный угол половины заметно лучше угла целой полосы (`HALF_OBJECTION_MIN`). */
  readonly objects: boolean;
}

/** Угол половины полосы в окрестности угла целой и её возражение ему. */
function halfOf(
  half: Pixels,
  bins: Float64Array,
  offset: number,
  wholeAngle: number,
): HalfEstimate {
  const estimate = angleOf(half, bins, offset, wholeAngle);
  if (estimate.angle === null) {
    return { angle: null, objects: false };
  }
  const atWhole = projectAt(half.xs, half.ys, half.ws, 1, wholeAngle, bins, offset);
  return { angle: estimate.angle, objects: estimate.score >= HALF_OBJECTION_MIN * atWhole };
}

interface BandsPass {
  readonly bands: SkewBand[];
  /** Высота полосы в долях высоты страницы. */
  readonly bandFraction: number;
}

/**
 * Углы полос: в каждой полосе список чернильных пикселей (x − xc, y − yc) с окном Ханна по
 * высоте и дизерингом строки; угол — по целой полосе, валидность — уверенность, доля чернил
 * и согласие половин. Между полосами — точка уступки.
 */
async function bandAngles(
  { data, width, height }: GrayImage,
  white: number,
  bandMm: number,
  options: MeasureSkewOptions,
): Promise<BandsPass> {
  const inkBelow = white - INK_DELTA;
  const pxPerMm = Math.max(width, height) / PAGE_HEIGHT_MM;
  const bandPx = Math.max(2, Math.min(height, Math.round(bandMm * pxPerMm)));
  const step = Math.max(1, Math.round(bandPx * (1 - BAND_OVERLAP)));
  const xc = width / 2;
  const x0 = Math.round(width * EDGE_MASK);
  const x1 = width - x0;
  const xs = new Float32Array(width * bandPx);
  const ys = new Float32Array(width * bandPx);
  const ws = new Float32Array(width * bandPx);
  // Запас по сдвигу — под крайние углы половин (грубый диапазон плюс три шага и уточнение).
  const maxShift =
    Math.ceil((width / 2) * Math.tan((COARSE_RANGE_DEG + 3 * COARSE_STEP_DEG + 0.5) * DEG)) + 2;
  const bins = new Float64Array(bandPx + 2 * maxShift + 2);
  const offset = bandPx / 2 + maxShift;
  const bands: SkewBand[] = [];
  const yieldBetween = options.yieldBetween ?? (() => yieldNow());
  for (let top = 0; top + bandPx <= height; top += step) {
    options.signal?.throwIfAborted();
    const started = performance.now();
    const yc = top + bandPx / 2;
    let count = 0;
    let sumY = 0;
    let sumW = 0;
    for (let y = top; y < top + bandPx; y += 1) {
      const row = y * width;
      // Окно Ханна по высоте полосы: горизонтальный обрез полосы сам по себе — горизонтальный
      // край в чернилах, и без окна счёт тянется к ложному пику ровно в 0°.
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * (y - top + 0.5)) / bandPx);
      for (let x = x0; x < x1; x += 1) {
        if ((data[row + x] ?? 255) < inkBelow) {
          xs[count] = x - xc;
          // Дизеринг строки: при угле ровно 0° целые координаты легли бы в бины без
          // размазывания и счёт резкости выигрывал бы у любого малого угла (мёртвая зона).
          ys[count] = y - yc + jitter(count);
          ws[count] = hann;
          sumY += hann * (y - yc);
          sumW += hann;
          count += 1;
        }
      }
    }
    // Положение полосы — центроид чернил, не геометрический центр: полоса с текстом только в
    // нижней половине меряет угол там, где текст.
    const u = (sumW > 0 ? yc + sumY / sumW : yc) / height;
    const inkFraction = count / (bandPx * (x1 - x0));
    const empty = (reason: SkewBandReason): SkewBand => ({
      u,
      angle: null,
      confidence: 0,
      inkFraction,
      halvesGap: Infinity,
      halvesAngle: null,
      reason,
    });
    if (inkFraction < MIN_INK_FRACTION) {
      bands.push(empty('no-ink'));
    } else if (inkFraction > MAX_INK_FRACTION) {
      bands.push(empty('too-much-ink'));
    } else {
      const pixels: Pixels = {
        xs: xs.subarray(0, count),
        ys: ys.subarray(0, count),
        ws: ws.subarray(0, count),
      };
      const whole = angleOf(pixels, bins, offset);
      if (whole.angle === null) {
        bands.push(empty('no-ink'));
      } else {
        const left = halfOf(
          filterPixels(pixels, (x) => x < 0),
          bins,
          offset,
          whole.angle,
        );
        const right = halfOf(
          filterPixels(pixels, (x) => x >= 0),
          bins,
          offset,
          whole.angle,
        );
        const halvesGap =
          left.angle === null || right.angle === null
            ? Infinity
            : Math.abs(left.angle - right.angle);
        const halvesAngle =
          left.angle === null || right.angle === null ? null : (left.angle + right.angle) / 2;
        // Вето половин — только когда хотя бы одна из них возражает: половина с плоским пиком
        // (плашка, риски линейки, пустая бумага с просвечиванием) мерит шум и уверенную целую
        // полосу не отменяет — иначе блок строк рядом с плашкой и низ листа с линейками
        // терялись целиком.
        const contradicted = (left.objects || right.objects) && halvesGap > HALVES_TOLERANCE_DEG;
        const reason: SkewBandReason | null =
          whole.confidence < CONFIDENCE_MIN
            ? 'low-confidence'
            : contradicted
              ? 'halves-disagree'
              : null;
        // Угол — по целой полосе (плечо шире, точнее), кроме случая, когда обе половины
        // согласны между собой и обе возражают целой: у двух колонок с разной фазой строк целая
        // полоса врёт, а каждая половина видит одну колонку и меряет верно — тогда среднее.
        const halvesMean =
          reason === null &&
          left.objects &&
          right.objects &&
          left.angle !== null &&
          right.angle !== null
            ? (left.angle + right.angle) / 2
            : whole.angle;
        const angle =
          Math.abs(whole.angle - halvesMean) <= HALVES_TOLERANCE_DEG ? whole.angle : halvesMean;
        bands.push({
          u,
          angle,
          confidence: whole.confidence,
          inkFraction,
          halvesGap,
          halvesAngle,
          reason,
        });
      }
    }
    options.onChunk?.(performance.now() - started);
    await yieldBetween();
  }
  return { bands, bandFraction: bandPx / height };
}

interface Point {
  readonly u: number;
  readonly theta: number;
  readonly w: number;
}

/** Решение системы 3×3 методом Гаусса; вырожденная — `null`. */
function solve3(m: number[][], v: number[]): number[] | null {
  const a = m.map((row) => row.slice());
  const b = v.slice();
  for (let c = 0; c < 3; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < 3; r += 1) {
      if (Math.abs(a[r]?.[c] ?? 0) > Math.abs(a[pivot]?.[c] ?? 0)) {
        pivot = r;
      }
    }
    const rowC = a[c] ?? [];
    const rowP = a[pivot] ?? [];
    a[c] = rowP;
    a[pivot] = rowC;
    const bc = b[c] ?? 0;
    b[c] = b[pivot] ?? 0;
    b[pivot] = bc;
    const diag = a[c]?.[c] ?? 0;
    if (Math.abs(diag) < 1e-12) {
      return null;
    }
    for (let r = 0; r < 3; r += 1) {
      if (r === c) {
        continue;
      }
      const f = (a[r]?.[c] ?? 0) / diag;
      for (let k = c; k < 3; k += 1) {
        const rowR = a[r] ?? [];
        rowR[k] = (rowR[k] ?? 0) - f * (a[c]?.[k] ?? 0);
      }
      b[r] = (b[r] ?? 0) - f * (b[c] ?? 0);
    }
  }
  return [0, 1, 2].map((i) => (b[i] ?? 0) / (a[i]?.[i] ?? 1));
}

/** Квадратика θ(u) = a + b(u − ½) + c(u − ½)² (при `linear` — прямая): устойчивая, Huber IRLS. */
function fitQuadratic(
  points: readonly Point[],
  linear: boolean,
): { coef: number[]; maxResidual: number } {
  const base = points.map((p) => p.w);
  let coef = [0, 0, 0];
  const solve = (w: number[]): number[] | null => {
    const m = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const v = [0, 0, 0];
    points.forEach((p, i) => {
      const d = [1, p.u - 0.5, (p.u - 0.5) ** 2];
      const wi = w[i] ?? 0;
      for (let r = 0; r < 3; r += 1) {
        v[r] = (v[r] ?? 0) + wi * (d[r] ?? 0) * p.theta;
        const row = m[r] ?? [];
        for (let c = 0; c < 3; c += 1) {
          row[c] = (row[c] ?? 0) + wi * (d[r] ?? 0) * (d[c] ?? 0);
        }
      }
    });
    if (linear) {
      const [m00 = 0, m01 = 0] = m[0] ?? [];
      const [, m11 = 0] = m[1] ?? [];
      const det = m00 * m11 - m01 * m01;
      if (Math.abs(det) < 1e-12) {
        return null;
      }
      const [v0 = 0, v1 = 0] = v;
      return [(v0 * m11 - m01 * v1) / det, (m00 * v1 - m01 * v0) / det, 0];
    }
    return solve3(m, v);
  };
  const evaluate = (p: Point): number =>
    (coef[0] ?? 0) + (coef[1] ?? 0) * (p.u - 0.5) + (coef[2] ?? 0) * (p.u - 0.5) ** 2;
  let w = base.slice();
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const next = solve(w);
    if (next === null) {
      break;
    }
    coef = next;
    const residuals = points.map((p) => p.theta - evaluate(p));
    const abs = residuals.map(Math.abs).sort((a, b) => a - b);
    const mad = Math.max(abs[Math.floor(abs.length / 2)] ?? 0, 1e-6);
    const scale = Math.max(1.4826 * mad, 0.02);
    w = residuals.map(
      (r, i) => (base[i] ?? 0) * (Math.abs(r) <= 1.345 * scale ? 1 : (1.345 * scale) / Math.abs(r)),
    );
  }
  return { coef, maxResidual: Math.max(...points.map((p) => Math.abs(p.theta - evaluate(p)))) };
}

/** Сглаженная ступень t1 → t2 с центром u0 и шириной w: перебор u0 и w, линейная подгонка t1, t2. */
function fitStep(points: readonly Point[]): number {
  const widths = [0.05, 0.08, 0.12, 0.16, 0.2, 0.25, 0.32];
  let best = Infinity;
  let bestResidual = Infinity;
  for (let u0 = 0.15; u0 <= 0.85 + 1e-9; u0 += 0.01) {
    for (const w of widths) {
      const sigmas = points.map((p) => 1 / (1 + Math.exp((-4 * (p.u - u0)) / w)));
      let s11 = 0;
      let s12 = 0;
      let s22 = 0;
      let r1 = 0;
      let r2 = 0;
      points.forEach((p, i) => {
        const sigma = sigmas[i] ?? 0;
        const a = 1 - sigma;
        s11 += p.w * a * a;
        s12 += p.w * a * sigma;
        s22 += p.w * sigma * sigma;
        r1 += p.w * a * p.theta;
        r2 += p.w * sigma * p.theta;
      });
      const det = s11 * s22 - s12 * s12;
      if (Math.abs(det) < 1e-12) {
        continue;
      }
      const t1 = (r1 * s22 - r2 * s12) / det;
      const t2 = (r2 * s11 - r1 * s12) / det;
      let cost = 0;
      let maxResidual = 0;
      points.forEach((p, i) => {
        const residual = p.theta - (t1 + (t2 - t1) * (sigmas[i] ?? 0));
        cost += p.w * residual * residual;
        maxResidual = Math.max(maxResidual, Math.abs(residual));
      });
      if (cost < best) {
        best = cost;
        bestResidual = maxResidual;
      }
    }
  }
  return bestResidual;
}

/** Узлы из валидных полос; полосы с одним центроидом (одна строка в перекрытии) сливаются. */
function knotsOf(points: readonly Point[]): SkewProfile {
  const merged: { u: number; theta: number; n: number }[] = [];
  for (const p of points.slice().sort((a, b) => a.u - b.u)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && Math.abs(last.u - p.u) < 1e-6) {
      last.theta = (last.theta * last.n + p.theta) / (last.n + 1);
      last.n += 1;
    } else {
      merged.push({ u: p.u, theta: p.theta, n: 1 });
    }
  }
  return skewProfileOf(merged);
}

type PassResult =
  | {
      readonly ok: true;
      readonly profile: SkewProfile;
      readonly bands: SkewBand[];
      readonly coverage: number;
      readonly shapeResidual: number;
      /** По каким углам построен профиль: целых полос или среднему половин. */
      readonly basis: SkewBasis;
    }
  | {
      readonly ok: false;
      readonly stage: 'bands' | 'coverage' | 'shape';
      readonly reason: string;
      readonly bands: SkewBand[];
      readonly coverage: number;
      readonly shapeResidual: number | null;
    };

/** Один проход полосами заданной высоты: полосы → гейты → профиль узлами. */
async function measurePass(
  gray: GrayImage,
  white: number,
  bandMm: number,
  options: MeasureSkewOptions,
): Promise<PassResult> {
  const { bands, bandFraction } = await bandAngles(gray, white, bandMm, options);
  const valid = bands.filter((b) => b.reason === null && b.angle !== null);
  const us = valid.map((b) => b.u).sort((p, q) => p - q);
  const coverage =
    us.length === 0 ? 0 : Math.min(1, (us[us.length - 1] ?? 0) - (us[0] ?? 0) + bandFraction);
  if (valid.length < MIN_BANDS) {
    return {
      ok: false,
      stage: 'bands',
      reason: `валидных полос ${valid.length} из ${bands.length} при ${bandMm} мм`,
      bands,
      coverage,
      shapeResidual: null,
    };
  }
  if (coverage < MIN_COVERAGE) {
    return {
      ok: false,
      stage: 'coverage',
      reason: `покрытие по высоте ${(coverage * 100).toFixed(0)} % при ${bandMm} мм`,
      bands,
      coverage,
      shapeResidual: null,
    };
  }
  const points: Point[] = valid.map((b) => ({
    u: b.u,
    theta: b.angle ?? 0,
    w: Math.min(b.confidence, MAX_WEIGHT),
  }));
  // Все валидные полосы ниже порога движения — страница ровная и без согласия формы: вопрос
  // «верить ли профилю для коррекции» не стоит, коррекции не будет. Почти пустой лист после
  // коррекции (три полосы −0,08 / +0,10 / −0,08°) давал остаток формы 0,105° и «не по чему
  // мерить» вместо «ровная». Профиль — узлами: константа за крайними держит его под порогом.
  if (valid.every((b) => Math.abs(b.angle ?? 0) < LEVEL_DEG)) {
    const { shapeResidual } = fitProfile(points);
    return { ok: true, profile: knotsOf(points), bands, coverage, shapeResidual, basis: 'whole' };
  }
  const whole = fitProfile(points);
  if (whole.shapeResidual <= whole.allowed) {
    return {
      ok: true,
      profile: whole.profile,
      bands,
      coverage,
      shapeResidual: whole.shapeResidual,
      basis: 'whole',
    };
  }
  // Форма по целым полосам не сошлась — запасной профиль по среднему половин там, где они
  // согласны между собой: у двух колонок с разной фазой строк целая полоса шумит на 0,1–0,2°
  // (строки колонок накладываются в разных фазах), а каждая половина видит одну колонку и
  // даёт чистую ступень; веер — свойство подачи листа, одинаков по всей ширине, так что
  // профиль по половинам выправляет обе колонки. Полос и покрытия у половин должно хватать
  // по тем же гейтам.
  const agreed = valid.filter((b) => b.halvesAngle !== null && b.halvesGap <= HALVES_TOLERANCE_DEG);
  const agreedUs = agreed.map((b) => b.u).sort((p, q) => p - q);
  const agreedCoverage =
    agreedUs.length === 0
      ? 0
      : Math.min(1, (agreedUs[agreedUs.length - 1] ?? 0) - (agreedUs[0] ?? 0) + bandFraction);
  if (agreed.length >= MIN_BANDS && agreedCoverage >= MIN_COVERAGE) {
    const halves = fitProfile(
      agreed.map((b) => ({
        u: b.u,
        theta: b.halvesAngle ?? 0,
        w: Math.min(b.confidence, MAX_WEIGHT),
      })),
    );
    if (halves.shapeResidual <= halves.allowed) {
      return {
        ok: true,
        profile: halves.profile,
        bands,
        coverage: agreedCoverage,
        shapeResidual: halves.shapeResidual,
        basis: 'halves',
      };
    }
  }
  return {
    ok: false,
    stage: 'shape',
    reason: `остаток формы ${whole.shapeResidual.toFixed(3)}° при ${bandMm} мм`,
    bands,
    coverage,
    shapeResidual: whole.shapeResidual,
  };
}

interface FittedProfile {
  readonly profile: SkewProfile;
  /** min(остаток дуги или прямой, остаток ступени). */
  readonly shapeResidual: number;
  /** Допуск остатка по опоре: две кучки полос с дырой — строгий, плотная опора — мягче. */
  readonly allowed: number;
}

/**
 * Профиль по точкам (u, θ, вес) — всегда узлами по полосам (за крайними — константа). Остаток
 * формы — min(остаток гладкого семейства, остаток ступени). Дыра покрытия > `MAX_SUPPORT_GAP`
 * (две кучки полос по краям, середина пуста): гладкое семейство — прямая, а не квадратика (ей
 * не на что опереться), допуск — строгий `SHAPE_RESIDUAL_MAX_DEG`; плотная опора — квадратика
 * и `SHAPE_RESIDUAL_DENSE_MAX_DEG`. Ступень считается и при дыре (B-39): веер с остановкой
 * подачи — это две константы, и прямая через две кучки внутри каждой кучки наклонена на
 * «наклон × полуширина кучки» — чем сильнее веер, тем больше остаток, и строгий порог резал
 * именно листы с сильным веером (шапка сверху, блок текста снизу, пустая середина: прямая
 * 0,16–0,20°, ступень 0,03–0,04°). Узлы вместо прямой: прямая экстраполировалась до краёв
 * листа (+1,10° при измеренных +0,92°), где чернил нет.
 */
function fitProfile(points: readonly Point[]): FittedProfile {
  const us = points.map((p) => p.u).sort((p, q) => p - q);
  let supportGap = 0;
  for (let i = 1; i < us.length; i += 1) {
    supportGap = Math.max(supportGap, (us[i] ?? 0) - (us[i - 1] ?? 0));
  }
  const sparse = supportGap > MAX_SUPPORT_GAP;
  const smooth = fitQuadratic(points, sparse);
  return {
    profile: knotsOf(points),
    shapeResidual: Math.min(smooth.maxResidual, fitStep(points)),
    allowed: sparse ? SHAPE_RESIDUAL_MAX_DEG : SHAPE_RESIDUAL_DENSE_MAX_DEG,
  };
}

/** Профиль ниже порога движения по всей высоте — страница ровная (R10). */
export function isLevel(profile: SkewProfile): boolean {
  return skewMaxAbsDeg(profile) < LEVEL_DEG;
}

/**
 * Независимая метрика выровненности (KTD-5): резкость строкового профиля чернильных пикселей
 * всей рабочей картинки до и после вертикального сдвига по профилю, Σ(Δp)² / Σp². Сдвиг
 * применяется к списку пикселей, а не к картинке: это тот же сдвиг KTD-1, только без
 * интерполяции серого, и с тем же дизерингом строки «до» и «после» — иначе целые строки
 * «до» резче дробных «после». Боковой дрейф на строковый профиль не влияет.
 */
export function alignmentContrast(
  { data, width, height }: GrayImage,
  white: number,
  profile: SkewProfile,
): SkewContrast {
  const inkBelow = white - INK_DELTA;
  const tan = skewTanRows(profile, height);
  const xc = width / 2;
  const x0 = Math.round(width * EDGE_MASK);
  const x1 = width - x0;
  const pad = Math.ceil((width / 2) * Math.tan((COARSE_RANGE_DEG + 1) * DEG)) + 2;
  const before = new Float64Array(height + 2 * pad);
  const after = new Float64Array(height + 2 * pad);
  const split = (bins: Float64Array, row: number): void => {
    const base = Math.floor(row);
    if (base < 0 || base + 1 >= bins.length) {
      return;
    }
    const f = row - base;
    bins[base] = (bins[base] ?? 0) + 1 - f;
    bins[base + 1] = (bins[base + 1] ?? 0) + f;
  };
  let index = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const t = tan[y] ?? 0;
    for (let x = x0; x < x1; x += 1) {
      if ((data[row + x] ?? 255) >= inkBelow) {
        continue;
      }
      const dithered = y + jitter(index) + pad;
      index += 1;
      split(before, dithered);
      // Куда попадёт пиксель после коррекции: y' = y + (x − xc)·tanθ(y).
      split(after, dithered + (x - xc) * t);
    }
  }
  const metric = (bins: Float64Array): number => {
    let sum = 0;
    let squares = 0;
    for (const v of bins) {
      sum += v;
      squares += v * v;
    }
    return sum > 0 ? profileScore(bins) / squares : 0;
  };
  const b = metric(before);
  const a = metric(after);
  return { before: b, after: a, ratio: b > 0 ? a / b : 0 };
}

/** Исход по метрике: выправлять только при росте контраста с запасом (R10, R24). */
export function verdictOf(contrast: SkewContrast): 'notImproved' | 'willStraighten' {
  return contrast.ratio >= IMPROVE_RATIO ? 'willStraighten' : 'notImproved';
}

/**
 * Измерение профиля наклона по серой рабочей картинке (чистая функция — `npm test`): проход
 * полосами 30 мм; при провале гейта формы — повтор полосами 50 мм; затем порог движения и
 * метрика «не хуже». Между полосами — точка уступки, чанк ≤ 30 мс на рабочем размере.
 */
export async function measureSkew(
  gray: GrayImage,
  options: MeasureSkewOptions = {},
): Promise<SkewMeasure> {
  const { histogram, total } = marginHistogramOf(gray);
  const white = paperWhiteOf(histogram, total);
  const base = {
    geometryVersion: STRAIGHTEN_GEOMETRY_VERSION,
    cause: null,
    basis: null,
    fanMm: null,
    contrast: null,
  };
  let bandMm = BAND_MM;
  let pass = await measurePass(gray, white, bandMm, options);
  // Причина отказа — по первому проходу: провал формы при 30 мм значит, что строки есть, и
  // запасной проход 50 мм её не меняет, даже если сам упал по числу полос.
  const cause: SkewCause | null = pass.ok ? null : pass.stage === 'shape' ? 'shape' : 'content';
  if (!pass.ok && pass.stage === 'shape') {
    bandMm = FALLBACK_BAND_MM;
    const retry = await measurePass(gray, white, bandMm, options);
    pass = retry.ok ? retry : { ...retry, reason: `${pass.reason}; ${retry.reason}` };
  }
  if (!pass.ok) {
    return {
      ...base,
      outcome: 'unmeasurable',
      cause,
      profile: null,
      bands: pass.bands,
      bandMm,
      coverage: pass.coverage,
      shapeResidual: pass.shapeResidual,
      reason: pass.reason,
    };
  }
  const { profile, bands, coverage, shapeResidual, basis } = pass;
  const fanMm = skewFanMm(profile);
  const common = { ...base, profile, bands, bandMm, coverage, shapeResidual, fanMm, basis };
  if (isLevel(profile)) {
    return { ...common, outcome: 'level', reason: null };
  }
  await (options.yieldBetween ?? (() => yieldNow()))();
  const contrast = alignmentContrast(gray, white, profile);
  const outcome = verdictOf(contrast);
  return {
    ...common,
    outcome,
    contrast,
    reason:
      outcome === 'notImproved'
        ? `контраст строк после сдвига ×${contrast.ratio.toFixed(2)} при запасе ×${IMPROVE_RATIO}`
        : null,
  };
}

/**
 * Измерение страницы JPEG (`sharp` — `test:integration`). Сбой — не JPEG, превышение предела
 * пикселей, ошибка декодирования — `null`: страница не измерена и ошибкой это не является (R3).
 * Срок обработки (B-21) — исключение `ImageTimeoutError` из декода: оценки держат «не успели» в
 * памяти, без кэша.
 */
export async function measureSkewJpeg(
  bytes: Uint8Array,
  pixelLimit: number | null,
  options: MeasureSkewOptions = {},
): Promise<SkewMeasure | null> {
  const gray = await decodeWorkingGray(bytes, pixelLimit);
  return gray === null ? null : measureSkew(gray, options);
}

/** Детектор как зависимость службы проходов (U5): в тестах службы — заглушка. */
export type SkewDetector = (
  bytes: Uint8Array,
  pixelLimit: number | null,
) => Promise<SkewMeasure | null>;
