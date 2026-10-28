// Спайк U1 плана M6 (выравнивание перекоса подачи): прототип детектора веера по полосам
// (KTD-2), независимая метрика выровненности (KTD-5), ресэмплер вертикального сдвига столбцов
// (KTD-1, KTD-3), анализ сетки на тестовых листах и замеры стоимости (стадии, паузы цикла
// событий, память, размер). Одноразовый код: вне сборки, вне линта, тестами не покрывается;
// по его числам в U2/U3 выбираются стартовые константы и решается вопрос воркера (ADR 0008).
//
// Запуск из корня:
//   node spikes/straighten-bench.mjs grid <скан.jpg> [--dpi 300]
//       углы горизонталей сетки по высоте, наклон и дрейф вертикалей, квадратика и остаток
//   node spikes/straighten-bench.mjs measure <скан.jpg>
//       детектор по полосам на любом скане: углы и уверенность полос, профиль, гейт,
//       контраст строк до/после сдвига
//   node spikes/straighten-bench.mjs straighten <скан.jpg> --out <файл.jpg> [--lateral]
//       [--profile a,b,c] [--dpi 300]
//       коррекция скана измеренным (или заданным) профилем — посмотреть глазами и прогнать grid
//   node spikes/straighten-bench.mjs bench [--dpi 300|600] [--channels 1|3] [--band-mpx 1]
//       [--pages 3] [--worker] [--lateral]
//       синтетическая страница с известным профилем: декод / измерение / warp / энкод,
//       паузы цикла событий, пик и плато RSS, отношение размера выхода к входу
//
// Единицы: u — доля высоты, углы — градусы. Профиль — одно из семейств: узлы по полосам
// (`knots`, по умолчанию; монотонный сплайн), сглаженная ступень (`step`), квадратика
// θ(u) = a + b·(u − 0.5) + c·(u − 0.5)² (`quad`). На ET-3850 профиль — ступень: верх и низ
// листа под разными углами, переход ~60 мм около середины (остановка подачи).
// Соглашение знака: коррекция out(x, y) = in(x, y − (x − xc)·tanθ(y)); синтетика искажается
// обратным образом, так что бенч проверяет согласованность знака детектора и ресэмплера между
// собой. Знак относительно сканера проверяется на сетке.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setImmediate as yieldNow, setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import sharp from 'sharp';

// --- Константы прототипа (стартовые гипотезы плана; подбираются на фикстурах в U2) ---------

const WORKING_LONG_SIDE = 1400;
const INK_DELTA = 40;
const PAPER_WHITE_PERCENTILE = 0.9;
const EDGE_MASK = 0.03;
let BAND_MM = 30; // --band-mm; на сетках ET-3850 30 мм (с окном Ханна) даёт ≤ 0,5 мм остатка
const BAND_OVERLAP = 0.5;
const COARSE_RANGE = 2.0;
const COARSE_STEP = 0.2;
const FINE_RANGE = 0.25;
const FINE_STEP = 0.05;
const MIN_INK_FRACTION = 0.002;
/** Выше — не документ (фото, заливка): строкового профиля нет, а уверенность обманчива. */
const MAX_INK_FRACTION = 0.3;
/** Половины полосы по ширине должны дать один угол: две колонки и графика расходятся. */
let HALVES_TOLERANCE_DEG = 0.25; // --halves-tol; узкие полосы шумнее
/** Остаток подгонки полос к профилю выше — полосы зацепились не за строки. */
const FIT_RESIDUAL_MAX_DEG = 0.1;
/** Дыра в покрытии валидными полосами больше — квадратике не на что опереться, берём прямую. */
const MAX_SUPPORT_GAP = 0.4;
const CONFIDENCE_MIN = 3;
const MIN_BANDS = 3;
const MIN_COVERAGE = 0.4;
const LEVEL_DEG = 0.1;
/** Доля бокового дрейфа от интеграла tanθ: 1 — чистый поворот, 0 — чистый срез (меряется сеткой). */
const LATERAL_K = 1; // сетки ET-3850: k = 0,92–1,02 — лист поворачивается целиком
const IMPROVE_K = 1.3;
const A4_HEIGHT_MM = 297;
const A4_WIDTH_MM = 210;

const DEG = Math.PI / 180;

// --- Профиль ---------------------------------------------------------------------------------

/** Наклоны монотонного кубического сплайна (Fritsch–Carlson) по узлам. */
function pchipSlopes(us, ys) {
  const n = us.length;
  const d = new Array(n).fill(0);
  if (n < 2) return d;
  const h = [];
  const delta = [];
  for (let i = 0; i < n - 1; i += 1) {
    h.push(us[i + 1] - us[i]);
    delta.push((ys[i + 1] - ys[i]) / (us[i + 1] - us[i]));
  }
  if (n === 2) return [delta[0], delta[0]];
  for (let i = 1; i < n - 1; i += 1) {
    if (delta[i - 1] * delta[i] <= 0) {
      d[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }
  const endSlope = (h0, h1, d0, d1) => {
    let slope = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(slope) !== Math.sign(d0)) slope = 0;
    else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(slope) > 3 * Math.abs(d0)) slope = 3 * d0;
    return slope;
  };
  d[0] = endSlope(h[0], h[1], delta[0], delta[1]);
  d[n - 1] = endSlope(h[n - 2], h[n - 3], delta[n - 2], delta[n - 3]);
  return d;
}

/** θ(u) по узлам: монотонный кубический сплайн внутри, константа за крайними узлами. */
function thetaKnots(profile, u) {
  const { us, thetas } = profile;
  if (u <= us[0]) return thetas[0];
  if (u >= us[us.length - 1]) return thetas[thetas.length - 1];
  if (profile.slopes === undefined) profile.slopes = pchipSlopes(us, thetas);
  let i = 0;
  while (us[i + 1] < u) i += 1;
  const h = us[i + 1] - us[i];
  const t = (u - us[i]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return (
    h00 * thetas[i] +
    h10 * h * profile.slopes[i] +
    h01 * thetas[i + 1] +
    h11 * h * profile.slopes[i + 1]
  );
}

/**
 * θ(u) по профилю одного из семейств: `knots` (узлы по полосам), `step` (сглаженная ступень
 * t1 → t2 с центром u0 и шириной w; логистика, 76 % перехода внутри ±w/2), иначе квадратика.
 */
const thetaAt = (profile, u) => {
  if (profile.kind === 'knots') return thetaKnots(profile, u);
  if (profile.kind === 'step') {
    const z = (u - profile.u0) / profile.w;
    const sigma = 1 / (1 + Math.exp(-4 * z));
    return profile.t1 + (profile.t2 - profile.t1) * sigma;
  }
  return profile.a + profile.b * (u - 0.5) + profile.c * (u - 0.5) ** 2;
};

function describeProfile(profile) {
  if (profile.kind === 'knots') {
    return `узлы ${profile.us.map((u, i) => `${u.toFixed(2)}:${profile.thetas[i].toFixed(2)}`).join(' ')}`;
  }
  if (profile.kind === 'step') {
    return `ступень верх ${profile.t1.toFixed(3)}° низ ${profile.t2.toFixed(3)}° u0=${profile.u0.toFixed(2)} w=${profile.w.toFixed(2)}`;
  }
  return `квадратика a=${profile.a.toFixed(3)} b=${profile.b.toFixed(3)} c=${profile.c.toFixed(3)}`;
}

/** tanθ по строкам картинки высоты `height` (Float64Array). */
function tanRows(profile, height) {
  const out = new Float64Array(height);
  for (let y = 0; y < height; y += 1) {
    out[y] = Math.tan(thetaAt(profile, (y + 0.5) / height) * DEG);
  }
  return out;
}

/** Боковой дрейф строк — интеграл tanθ от середины высоты, в пикселях (Float64Array). */
function lateralRows(tan, height, k = LATERAL_K) {
  const out = new Float64Array(height);
  const yc = Math.floor(height / 2);
  let acc = 0;
  for (let y = yc; y < height; y += 1) {
    out[y] = acc;
    acc += tan[y];
  }
  acc = 0;
  for (let y = yc - 1; y >= 0; y -= 1) {
    acc -= tan[y];
    out[y] = acc;
  }
  for (let y = 0; y < height; y += 1) out[y] *= k;
  return out;
}

// --- Серое, белое бумаги, чернила ------------------------------------------------------------

async function decodeGray(bytes, longSide = null) {
  let image = sharp(bytes, { limitInputPixels: 80_000_000 }).greyscale();
  if (longSide !== null) {
    image = image.resize({
      width: longSide,
      height: longSide,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

function paperWhite({ data, width, height }) {
  const histogram = new Uint32Array(256);
  const mx = Math.round(width * 0.04);
  const my = Math.round(height * 0.04);
  let total = 0;
  for (let y = my; y < height - my; y += 1) {
    for (let x = mx; x < width - mx; x += 1) {
      histogram[data[y * width + x]] += 1;
      total += 1;
    }
  }
  let seen = 0;
  for (let level = 0; level < 256; level += 1) {
    seen += histogram[level];
    if (seen >= total * PAPER_WHITE_PERCENTILE) return level;
  }
  return 255;
}

// --- Детектор по полосам (KTD-2) -----------------------------------------------------------

/** Оценка резкости строкового профиля: Σ(p[i+1]−p[i])² (как в Leptonica pixFindSkew). */
function profileScore(bins) {
  let score = 0;
  for (let i = 1; i < bins.length; i += 1) {
    const d = bins[i] - bins[i - 1];
    score += d * d;
  }
  return score;
}

/** Строковый профиль чернил при наклоне на угол (градусы): субпиксельное распределение. */
function projectAt(xs, ys, ws, count, stride, angleDeg, bins, offset) {
  bins.fill(0);
  const t = Math.tan(angleDeg * DEG);
  const last = bins.length - 1;
  for (let i = 0; i < count; i += stride) {
    const row = ys[i] + xs[i] * t + offset;
    const base = Math.floor(row);
    if (base < 0 || base >= last) continue;
    const f = row - base;
    const w = ws[i];
    bins[base] += w * (1 - f);
    bins[base + 1] += w * f;
  }
  return profileScore(bins);
}

/** Угол по списку пикселей: грубый перебор, уточнение, парабола; {angle, confidence}. */
function angleOf(xs, ys, ws, count, bins, offset, filter = null, around = null) {
  // Половины: пиксели с xs по одну сторону от нуля — через фильтр (копия списка).
  let sx = xs.subarray(0, count);
  let sy = ys.subarray(0, count);
  let sw = ws.subarray(0, count);
  if (filter !== null) {
    const keep = [];
    for (let i = 0; i < count; i += 1) if (filter(xs[i])) keep.push(i);
    sx = Float32Array.from(keep, (i) => xs[i]);
    sy = Float32Array.from(keep, (i) => ys[i]);
    sw = Float32Array.from(keep, (i) => ws[i]);
  }
  const total = sx.length;
  if (total < 50) return { angle: null, confidence: 0 };
  const stride = total > 20_000 ? 2 : 1;
  let best = -Infinity;
  let bestAngle = 0;
  let worst = Infinity;
  // Половины ищутся в окрестности угла всей полосы: грубый перебор не утраивается.
  const from = around === null ? -COARSE_RANGE : around - 3 * COARSE_STEP;
  const to = around === null ? COARSE_RANGE : around + 3 * COARSE_STEP;
  const coarse = [];
  for (let angle = from; angle <= to + 1e-9; angle += COARSE_STEP) {
    const score = projectAt(sx, sy, sw, total, stride, angle, bins, offset);
    coarse.push(score);
    if (score > best) {
      best = score;
      bestAngle = angle;
    }
    if (score < worst) worst = score;
  }
  // Резкость пика: лучший счёт против соседей на ±0,4° (строки дают острый пик, штриховка и
  // пятна — плоский). Независима от размаха перебора, в отличие от max/min.
  const bestIndex = coarse.indexOf(best);
  const neighbours = [bestIndex - 2, bestIndex + 2].filter((i) => i >= 0 && i < coarse.length);
  const sharpness =
    neighbours.length === 0
      ? 1
      : best / (neighbours.reduce((sum, i) => sum + coarse[i], 0) / neighbours.length);
  const fine = [];
  for (
    let angle = bestAngle - FINE_RANGE;
    angle <= bestAngle + FINE_RANGE + 1e-9;
    angle += FINE_STEP
  ) {
    fine.push({ angle, score: projectAt(sx, sy, sw, total, 1, angle, bins, offset) });
  }
  let k = 0;
  for (let i = 1; i < fine.length; i += 1) if (fine[i].score > fine[k].score) k = i;
  let angle = fine[k].angle;
  if (k > 0 && k < fine.length - 1) {
    const s0 = fine[k - 1].score;
    const s1 = fine[k].score;
    const s2 = fine[k + 1].score;
    const denom = s0 - 2 * s1 + s2;
    if (denom < 0) angle += (FINE_STEP * (s0 - s2)) / (2 * denom);
  }
  const bestCoarseScale = stride === 1 ? fine[k].score : fine[k].score / (stride * stride);
  return { angle, confidence: worst > 0 ? bestCoarseScale / worst : Infinity, sharpness };
}

/**
 * Углы полос: для каждой полосы — список чернильных пикселей (x − xc, y − yc полосы),
 * грубый перебор ±COARSE_RANGE на каждом втором пикселе, уточнение ±FINE_RANGE с параболой;
 * валидность — уверенность, доля чернил и согласие левой и правой половин.
 */
async function bandAngles(gray, { pxPerMm, log = () => {}, yieldBetween = true, onBand } = {}) {
  const { data, width, height } = gray;
  const white = paperWhite(gray);
  const inkBelow = white - INK_DELTA;
  const bandPx = Math.round(BAND_MM * pxPerMm);
  const step = Math.max(1, Math.round(bandPx * (1 - BAND_OVERLAP)));
  const xc = width / 2;
  const x0 = Math.round(width * EDGE_MASK);
  const x1 = width - x0;
  const xs = new Float32Array(width * bandPx);
  const ys = new Float32Array(width * bandPx);
  const ws = new Float32Array(width * bandPx);
  const maxShift = Math.ceil((width / 2) * Math.tan(COARSE_RANGE * DEG)) + 2;
  const bins = new Float64Array(bandPx + 2 * maxShift + 2);
  const bands = [];
  for (let top = 0; top + bandPx <= height; top += step) {
    const chunkStarted = performance.now();
    const yc = top + bandPx / 2;
    let count = 0;
    let sumY = 0;
    let sumW = 0;
    for (let y = top; y < top + bandPx; y += 1) {
      const row = y * width;
      // Окно Ханна по высоте полосы: обрез полосы по горизонтали сам по себе — горизонтальный
      // край в чернилах, и счёт тянется к 0° (штриховка под 12° давала ровно 0,000°).
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * (y - top + 0.5)) / bandPx);
      for (let x = x0; x < x1; x += 1) {
        if (data[row + x] < inkBelow) {
          xs[count] = x - xc;
          // Дизеринг строки: при угле ровно 0° целые координаты легли бы в бины без
          // размазывания, и счёт резкости жульнически выигрывал бы у любого малого угла
          // (мёртвая зона ±0,1° на синтетике). Постоянная доля на пиксель — одинаковое
          // размытие при любом угле.
          ys[count] = y - yc + ((count * 0x9e3779b1) >>> 0) / 2 ** 32;
          ws[count] = hann;
          sumY += hann * (y - yc);
          sumW += hann;
          count += 1;
        }
      }
    }
    // Положение полосы — по центроиду чернил, а не по геометрии: полоса с текстом только в
    // нижней половине меряет угол там, где текст.
    const u = (sumW > 0 ? yc + sumY / sumW : yc) / height;
    const inkFraction = count / (bandPx * (x1 - x0));
    if (inkFraction < MIN_INK_FRACTION) {
      bands.push({ u, inkFraction, angle: null, confidence: 0, valid: false, reason: 'no-ink' });
      continue;
    }
    if (inkFraction > MAX_INK_FRACTION) {
      bands.push({
        u,
        inkFraction,
        angle: null,
        confidence: 0,
        valid: false,
        reason: 'too-much-ink',
      });
      continue;
    }
    const offset = bandPx / 2 + maxShift;
    const whole = angleOf(xs, ys, ws, count, bins, offset);
    const left = angleOf(xs, ys, ws, count, bins, offset, (x) => x < 0, whole.angle);
    const right = angleOf(xs, ys, ws, count, bins, offset, (x) => x >= 0, whole.angle);
    const halvesGap =
      left.angle === null || right.angle === null ? Infinity : Math.abs(left.angle - right.angle);
    const reason =
      whole.confidence < CONFIDENCE_MIN
        ? 'low-confidence'
        : halvesGap > HALVES_TOLERANCE_DEG
          ? 'halves-disagree'
          : null;
    // Угол полосы — по всей полосе (точнее: плечо шире), кроме случая, когда целая полоса
    // расходится с половинами: у двух колонок с разной фазой строк целая полоса врёт, а
    // каждая половина видит одну колонку и меряет верно — тогда среднее половин.
    const halvesMean = reason === null ? (left.angle + right.angle) / 2 : whole.angle;
    const angle =
      Math.abs(whole.angle - halvesMean) <= HALVES_TOLERANCE_DEG ? whole.angle : halvesMean;
    bands.push({
      u,
      inkFraction,
      angle,
      confidence: whole.confidence,
      sharpness: whole.sharpness,
      halvesGap,
      valid: reason === null,
      reason,
      ink: count,
    });
    const halves = `${left.angle === null ? '-' : left.angle.toFixed(3)}/${right.angle === null ? '-' : right.angle.toFixed(3)}`;
    log(
      `  полоса u=${u.toFixed(3)} чернил ${(inkFraction * 100).toFixed(2)}% угол ${angle.toFixed(3)}° (целиком ${whole.angle.toFixed(3)}) уверенность ${whole.confidence.toFixed(1)} резкость ${whole.sharpness.toFixed(2)} половины ${halves}${reason ? ` X ${reason}` : ''}`,
    );
    onBand?.(performance.now() - chunkStarted);
    if (yieldBetween) await yieldNow();
  }
  return { bands, white, bandPx, bandFraction: bandPx / height };
}

/** Устойчивая взвешенная квадратика θ(u) (Huber IRLS). Точки {u, theta, w}. */
function fitQuadratic(points, { linear = false } = {}) {
  const weights = points.map((p) => p.w ?? 1);
  let coef = [0, 0, 0];
  const solve = (w) => {
    const m = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const v = [0, 0, 0];
    points.forEach((p, i) => {
      const d = [1, p.u - 0.5, (p.u - 0.5) ** 2];
      for (let r = 0; r < 3; r += 1) {
        v[r] += w[i] * d[r] * p.theta;
        for (let c = 0; c < 3; c += 1) m[r][c] += w[i] * d[r] * d[c];
      }
    });
    // Гаусс 3×3
    for (let c = 0; c < 3; c += 1) {
      let pivot = c;
      for (let r = c + 1; r < 3; r += 1) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
      [m[c], m[pivot]] = [m[pivot], m[c]];
      [v[c], v[pivot]] = [v[pivot], v[c]];
      if (Math.abs(m[c][c]) < 1e-12) return null;
      for (let r = 0; r < 3; r += 1) {
        if (r === c) continue;
        const f = m[r][c] / m[c][c];
        for (let k = c; k < 3; k += 1) m[r][k] -= f * m[c][k];
        v[r] -= f * v[c];
      }
    }
    return [v[0] / m[0][0], v[1] / m[1][1], v[2] / m[2][2]];
  };
  const solveLinear = (w) => {
    let sw = 0;
    let su = 0;
    let suu = 0;
    let st = 0;
    let sut = 0;
    points.forEach((p, i) => {
      const d = p.u - 0.5;
      sw += w[i];
      su += w[i] * d;
      suu += w[i] * d * d;
      st += w[i] * p.theta;
      sut += w[i] * d * p.theta;
    });
    const det = sw * suu - su * su;
    if (Math.abs(det) < 1e-12) return null;
    return [(st * suu - su * sut) / det, (sw * sut - su * st) / det, 0];
  };
  let w = weights.slice();
  for (let iter = 0; iter < 6; iter += 1) {
    const next = linear ? solveLinear(w) : solve(w);
    if (next === null) break;
    coef = next;
    const residuals = points.map(
      (p) => p.theta - (coef[0] + coef[1] * (p.u - 0.5) + coef[2] * (p.u - 0.5) ** 2),
    );
    const abs = residuals.map(Math.abs).sort((a, b) => a - b);
    const mad = abs[Math.floor(abs.length / 2)] || 1e-6;
    const scale = Math.max(1.4826 * mad, 0.02);
    w = residuals.map(
      (r, i) => weights[i] * (Math.abs(r) <= 1.345 * scale ? 1 : (1.345 * scale) / Math.abs(r)),
    );
  }
  const profile = { a: coef[0], b: coef[1], c: coef[2] };
  const residuals = points.map((p) => p.theta - thetaAt(profile, p.u));
  return { profile, residuals, maxResidual: Math.max(...residuals.map(Math.abs)), linear };
}

/** Сглаженная ступень по точкам {u, theta, w}: перебор u0 и w, линейная подгонка t1, t2. */
function fitStep(points) {
  let best = null;
  const widths = [0.05, 0.08, 0.12, 0.16, 0.2, 0.25, 0.32];
  for (let u0 = 0.15; u0 <= 0.85 + 1e-9; u0 += 0.01) {
    for (const w of widths) {
      let s11 = 0;
      let s12 = 0;
      let s22 = 0;
      let r1 = 0;
      let r2 = 0;
      for (const p of points) {
        const sigma = 1 / (1 + Math.exp((-4 * (p.u - u0)) / w));
        const a = 1 - sigma;
        const wt = p.w ?? 1;
        s11 += wt * a * a;
        s12 += wt * a * sigma;
        s22 += wt * sigma * sigma;
        r1 += wt * a * p.theta;
        r2 += wt * sigma * p.theta;
      }
      const det = s11 * s22 - s12 * s12;
      if (Math.abs(det) < 1e-12) continue;
      const t1 = (r1 * s22 - r2 * s12) / det;
      const t2 = (r2 * s11 - r1 * s12) / det;
      const profile = { kind: 'step', t1, t2, u0, w };
      let cost = 0;
      for (const p of points) cost += (p.w ?? 1) * (p.theta - thetaAt(profile, p.u)) ** 2;
      if (best === null || cost < best.cost) best = { cost, profile };
    }
  }
  const residuals = points.map((p) => p.theta - thetaAt(best.profile, p.u));
  return { profile: best.profile, residuals, maxResidual: Math.max(...residuals.map(Math.abs)) };
}

/** Узлы по полосам: θ в центроиде каждой валидной полосы, между ними монотонный сплайн. */
function knotsOf(points) {
  const sorted = points.slice().sort((p, q) => p.u - q.u);
  return {
    profile: { kind: 'knots', us: sorted.map((p) => p.u), thetas: sorted.map((p) => p.theta) },
    residuals: sorted.map(() => 0),
    maxResidual: 0,
  };
}

/** Измерение по серой рабочей картинке: полосы → профиль → гейт → исход (KTD-2, KTD-5). */
async function measureGray(
  gray,
  { log = () => {}, yieldBetween = true, onBand, family = 'knots' } = {},
) {
  const pxPerMm = Math.max(gray.width, gray.height) / A4_HEIGHT_MM;
  const started = performance.now();
  const { bands, white, bandFraction } = await bandAngles(gray, {
    pxPerMm,
    log,
    yieldBetween,
    onBand,
  });
  const valid = bands.filter((b) => b.valid);
  const bandsMs = performance.now() - started;
  const base = { bands, valid: valid.length, white, bandsMs };
  if (valid.length < MIN_BANDS) {
    return {
      ...base,
      outcome: 'unmeasurable',
      reason: `полос с уверенностью ≥ ${CONFIDENCE_MIN}: ${valid.length}`,
    };
  }
  const us = valid.map((b) => b.u).sort((p, q) => p - q);
  const coverage = Math.min(1, us[us.length - 1] - us[0] + bandFraction);
  if (coverage < MIN_COVERAGE) {
    return {
      ...base,
      outcome: 'unmeasurable',
      reason: `покрытие по высоте ${(coverage * 100).toFixed(0)}%`,
    };
  }
  let supportGap = 0;
  for (let i = 1; i < us.length; i += 1) supportGap = Math.max(supportGap, us[i] - us[i - 1]);
  const linear = supportGap > MAX_SUPPORT_GAP;
  const points = valid.map((b) => ({ u: b.u, theta: b.angle, w: Math.min(b.confidence, 20) }));
  const quad = fitQuadratic(points, { linear });
  const step = linear ? quad : fitStep(points);
  const knots = linear ? quad : knotsOf(points);
  // Гейт формы: полосы должны ложиться хотя бы на одно гладкое семейство — дуга или ступень;
  // прыгающие углы (две колонки, графика) не ложатся ни на одно.
  const shapeResidual = Math.min(quad.maxResidual, step.maxResidual);
  const fit = family === 'quad' ? quad : family === 'step' ? step : knots;
  const shape = { quad, step, shapeResidual };
  if (shapeResidual > FIT_RESIDUAL_MAX_DEG) {
    return {
      ...base,
      outcome: 'unmeasurable',
      reason: `остаток формы ${shapeResidual.toFixed(3)}° (дуга ${quad.maxResidual.toFixed(3)}, ступень ${step.maxResidual.toFixed(3)})`,
      fit,
      ...shape,
      coverage,
      linear,
      supportGap,
    };
  }
  const extremes = [0, 0.25, 0.5, 0.75, 1].map((u) => Math.abs(thetaAt(fit.profile, u)));
  const level = Math.max(...extremes) < LEVEL_DEG;
  const contrast = contrastBeforeAfter(gray, white, fit.profile);
  const outcome = level ? 'level' : contrast.ratio >= IMPROVE_K ? 'willStraighten' : 'notImproved';
  return {
    ...base,
    outcome,
    coverage,
    linear,
    supportGap,
    fit,
    ...shape,
    contrast,
    measureMs: performance.now() - started,
  };
}

/** Независимая метрика (KTD-5): резкость строкового профиля всей картинки до/после сдвига. */
function contrastBeforeAfter(gray, white, profile) {
  const { data, width, height } = gray;
  const inkBelow = white - INK_DELTA;
  const tan = tanRows(profile, height);
  const xc = width / 2;
  const x0 = Math.round(width * EDGE_MASK);
  const x1 = width - x0;
  const pad = Math.ceil((width / 2) * Math.tan(2.5 * DEG)) + 2;
  const before = new Float64Array(height + 2 * pad);
  const after = new Float64Array(height + 2 * pad);
  let index = 0;
  const split = (bins, row) => {
    const base = Math.floor(row);
    const f = row - base;
    bins[base] += 1 - f;
    bins[base + 1] += f;
  };
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = x0; x < x1; x += 1) {
      if (data[row + x] >= inkBelow) continue;
      // Тот же дизеринг, что в полосах: иначе целые строки «до» резче дробных «после».
      const jitter = ((index * 0x9e3779b1) >>> 0) / 2 ** 32;
      index += 1;
      split(before, y + jitter + pad);
      // Куда попадёт пиксель после коррекции: y' = y + (x − xc)·tanθ(y).
      split(after, y + jitter + (x - xc) * tan[y] + pad);
    }
  }
  const metric = (bins) => {
    let sum = 0;
    let sq = 0;
    for (const v of bins) {
      sum += v;
      sq += v * v;
    }
    return sum > 0 ? profileScore(bins) / sq : 0;
  };
  const b = metric(before);
  const a = metric(after);
  return { before: b, after: a, ratio: b > 0 ? a / b : 0 };
}

// --- Ресэмплер (KTD-1, KTD-3) --------------------------------------------------------------

/** Веса Catmull-Rom для дробной части f. */
function catmullRom(f) {
  const f2 = f * f;
  const f3 = f2 * f;
  return [
    -0.5 * f3 + f2 - 0.5 * f,
    1.5 * f3 - 2.5 * f2 + 1,
    -1.5 * f3 + 2 * f2 + 0.5 * f,
    0.5 * f3 - 0.5 * f2,
  ];
}

/**
 * Вертикальный сдвиг столбцов полосами выходных строк с точкой уступки между полосами.
 * `white` — значение заливки по каналам. Возвращает новый буфер того же размера.
 */
async function warpVertical(
  src,
  width,
  height,
  channels,
  tan,
  white,
  { bandMpx = 1, yieldBetween = true, onBand } = {},
) {
  const out = Buffer.allocUnsafe(src.length);
  const xc = width / 2;
  const rowsPerBand = Math.max(1, Math.floor((bandMpx * 1e6) / width));
  const stride = width * channels;
  for (let y0 = 0; y0 < height; y0 += rowsPerBand) {
    const started = performance.now();
    const y1 = Math.min(height, y0 + rowsPerBand);
    for (let y = y0; y < y1; y += 1) {
      const t = tan[y];
      const outRow = y * stride;
      for (let x = 0; x < width; x += 1) {
        const ys = y - (x - xc) * t;
        const iy = Math.floor(ys);
        const f = ys - iy;
        const o = outRow + x * channels;
        if (iy - 1 < 0 || iy + 2 >= height) {
          if (iy < 0 || iy >= height) {
            for (let c = 0; c < channels; c += 1) out[o + c] = white[c];
          } else {
            const i = iy * stride + x * channels;
            for (let c = 0; c < channels; c += 1) out[o + c] = src[i + c];
          }
          continue;
        }
        const [w0, w1, w2, w3] = catmullRom(f);
        const i0 = (iy - 1) * stride + x * channels;
        for (let c = 0; c < channels; c += 1) {
          const v =
            w0 * src[i0 + c] +
            w1 * src[i0 + stride + c] +
            w2 * src[i0 + 2 * stride + c] +
            w3 * src[i0 + 3 * stride + c];
          out[o + c] = v < 0 ? 0 : v > 255 ? 255 : v + 0.5;
        }
      }
    }
    onBand?.(performance.now() - started, y1 - y0);
    if (yieldBetween) await yieldNow();
  }
  return out;
}

/** Горизонтальный сдвиг строк на дрейф d[y] (пиксели), in-place, Catmull-Rom по строке. */
async function shiftRowsLateral(
  buf,
  width,
  height,
  channels,
  drift,
  white,
  { yieldBetween = true, rowsPerYield = 256 } = {},
) {
  const stride = width * channels;
  const scratch = Buffer.allocUnsafe(stride);
  for (let y = 0; y < height; y += 1) {
    const d = drift[y];
    const row = y * stride;
    buf.copy(scratch, 0, row, row + stride);
    for (let x = 0; x < width; x += 1) {
      const xs = x + d;
      const ix = Math.floor(xs);
      const f = xs - ix;
      const o = row + x * channels;
      if (ix - 1 < 0 || ix + 2 >= width) {
        for (let c = 0; c < channels; c += 1)
          buf[o + c] = ix < 0 || ix >= width ? white[c] : scratch[ix * channels + c];
        continue;
      }
      const [w0, w1, w2, w3] = catmullRom(f);
      const i0 = (ix - 1) * channels;
      for (let c = 0; c < channels; c += 1) {
        const v =
          w0 * scratch[i0 + c] +
          w1 * scratch[i0 + channels + c] +
          w2 * scratch[i0 + 2 * channels + c] +
          w3 * scratch[i0 + 3 * channels + c];
        buf[o + c] = v < 0 ? 0 : v > 255 ? 255 : v + 0.5;
      }
    }
    if (yieldBetween && y % rowsPerYield === rowsPerYield - 1) await yieldNow();
  }
}

async function straightenRaw(
  raw,
  info,
  profile,
  { lateral = false, k = LATERAL_K, bandMpx = 1, yieldBetween = true, onBand } = {},
) {
  const { width, height, channels } = info;
  const tan = tanRows(profile, height);
  const white = estimateWhite(raw, width, height, channels);
  if (lateral)
    await shiftRowsLateral(raw, width, height, channels, lateralRows(tan, height, k), white, {
      yieldBetween,
    });
  return warpVertical(raw, width, height, channels, tan, white, { bandMpx, yieldBetween, onBand });
}

function estimateWhite(raw, width, height, channels) {
  const white = [];
  for (let c = 0; c < channels; c += 1) {
    const histogram = new Uint32Array(256);
    let total = 0;
    for (let y = 0; y < height; y += 7) {
      for (let x = 0; x < width; x += 7) {
        histogram[raw[(y * width + x) * channels + c]] += 1;
        total += 1;
      }
    }
    let seen = 0;
    let level = 255;
    for (let l = 0; l < 256; l += 1) {
      seen += histogram[l];
      if (seen >= total * PAPER_WHITE_PERCENTILE) {
        level = l;
        break;
      }
    }
    white.push(level);
  }
  return white;
}

// --- Анализ сетки ----------------------------------------------------------------------------

/** Пики профиля (центроиды тёмных пробегов) вдоль одной оси в полосе. */
function peaksOf(profile, minValue, maxRun) {
  const peaks = [];
  let start = -1;
  let weight = 0;
  let moment = 0;
  for (let i = 0; i <= profile.length; i += 1) {
    const v = i < profile.length ? profile[i] : 0;
    if (v >= minValue) {
      if (start < 0) start = i;
      weight += v;
      moment += v * i;
    } else if (start >= 0) {
      if (i - start <= maxRun) peaks.push(moment / weight);
      start = -1;
      weight = 0;
      moment = 0;
    }
  }
  return peaks;
}

/** Следы линий поперёк полос: от центральной полосы наружу, ближайший пик в допуске. */
function trackLines(stripPeaks, stripPositions, tolerance) {
  const center = Math.floor(stripPeaks.length / 2);
  const lines = [];
  for (const seed of stripPeaks[center]) {
    const points = [{ along: stripPositions[center], across: seed }];
    const walk = (direction) => {
      let last = seed;
      for (let s = center + direction; s >= 0 && s < stripPeaks.length; s += direction) {
        let best = null;
        for (const p of stripPeaks[s]) {
          if (
            Math.abs(p - last) <= tolerance &&
            (best === null || Math.abs(p - last) < Math.abs(best - last))
          )
            best = p;
        }
        if (best === null) break;
        points.push({ along: stripPositions[s], across: best });
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

function linearFit(points) {
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
  for (const { along, across } of points)
    bow = Math.max(bow, Math.abs(across - (intercept + slope * along)));
  return { slope, intercept, bow };
}

async function gridAnalysis(bytes, { dpi, log }) {
  const gray = await decodeGray(bytes);
  const { data, width, height } = gray;
  const pxPerMm = dpi / 25.4;
  const white = paperWhite(gray);
  const inkBelow = white - 60;
  const ink = (x, y) => data[y * width + x] < inkBelow;
  const STRIPS = 17;
  const stripWidth = Math.round(4 * pxPerMm);
  const maxRun = Math.round(2 * pxPerMm);
  const tolerance = Math.round(3 * pxPerMm);
  const inner = 0.06;

  // Горизонтали: полосы-столбцы по x, профиль по y.
  const xPositions = Array.from({ length: STRIPS }, (_, i) =>
    Math.round(width * (inner + ((1 - 2 * inner) * i) / (STRIPS - 1))),
  );
  const hPeaks = xPositions.map((xp) => {
    const profile = new Float64Array(height);
    for (let y = Math.round(height * 0.02); y < height * 0.98; y += 1) {
      let count = 0;
      for (let x = xp - stripWidth / 2; x < xp + stripWidth / 2; x += 1)
        if (ink(Math.round(x), y)) count += 1;
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
        points: points.length,
      };
    })
    .sort((p, q) => p.u - q.u);

  // Вертикали: полосы-строки по y, профиль по x.
  const yPositions = Array.from({ length: STRIPS }, (_, i) =>
    Math.round(height * (inner + ((1 - 2 * inner) * i) / (STRIPS - 1))),
  );
  const vPeaks = yPositions.map((yp) => {
    const profile = new Float64Array(width);
    for (let x = Math.round(width * 0.02); x < width * 0.98; x += 1) {
      let count = 0;
      for (let y = yp - stripWidth / 2; y < yp + stripWidth / 2; y += 1)
        if (ink(x, Math.round(y))) count += 1;
      profile[x] = count;
    }
    return peaksOf(profile, stripWidth * 0.5, maxRun);
  });
  const verticals = trackLines(vPeaks, yPositions, tolerance)
    .filter((points) => points.length >= STRIPS * 0.8)
    .map((points) => {
      const fit = linearFit(points);
      const xCenter = fit.intercept + fit.slope * (height / 2);
      // Наклон вертикали как угол «по часовой» в тех же единицах, что у горизонталей:
      // поворот листа на φ даёт горизонталям dy/dx = tanφ, вертикалям dx/dy = −tanφ.
      const top = points[0];
      const bottom = points[points.length - 1];
      return {
        xMm: xCenter / pxPerMm,
        tilt: Math.atan(fit.slope) / DEG,
        bowMm: fit.bow / pxPerMm,
        driftMm: (bottom.across - top.across) / pxPerMm,
        spanMm: (bottom.along - top.along) / pxPerMm,
        points: points.length,
        samples: points,
      };
    })
    .sort((p, q) => p.xMm - q.xMm);

  log(
    `Сетка ${width}×${height}, ${dpi} dpi, белое ${white}; горизонталей ${horizontals.length}, вертикалей ${verticals.length}`,
  );
  log(
    '\nГоризонтали (u — доля высоты; θ — угол строки, + = правый конец выше; bow — отклонение от прямой):',
  );
  log('   u      y,мм    θ,°      bow,мм  точек');
  for (const h of horizontals) {
    log(
      `  ${h.u.toFixed(3)}  ${h.yMm.toFixed(1).padStart(6)}  ${h.theta.toFixed(3).padStart(7)}  ${h.bowMm.toFixed(2).padStart(6)}  ${h.points}`,
    );
  }
  let fit = null;
  if (horizontals.length >= 3) {
    fit = fitQuadratic(horizontals.map((h) => ({ u: h.u, theta: h.theta })));
    const thetas = horizontals.map((h) => h.theta);
    const fanDeg = Math.max(...thetas) - Math.min(...thetas);
    const lineWidthMm = 190;
    log(
      `\nКвадратика θ(u) = a + b(u−0.5) + c(u−0.5)²: a=${fit.profile.a.toFixed(3)} b=${fit.profile.b.toFixed(3)} c=${fit.profile.c.toFixed(3)}`,
    );
    log(`  максимальный остаток ${fit.maxResidual.toFixed(3)}° (порог плана 0.05°)`);
    log(
      `  веер: ${fanDeg.toFixed(3)}° между крайними строками = ${(lineWidthMm * Math.tan(fanDeg * DEG)).toFixed(2)} мм расхождения концов на ${lineWidthMm} мм`,
    );
    const residualsLinear = (() => {
      const lf = linearFit(horizontals.map((h) => ({ along: h.u, across: h.theta })));
      return Math.max(
        ...horizontals.map((h) => Math.abs(h.theta - (lf.intercept + lf.slope * h.u))),
      );
    })();
    log(`  для сравнения: остаток прямой (a + b·u) ${residualsLinear.toFixed(3)}°`);
  }
  log(
    '\nВертикали (tilt — в единицах угла поворота листа: при повороте tilt ≈ θ горизонталей, при чистом срезе tilt ≈ 0):',
  );
  log('   x,мм    tilt,°   bow,мм  дрейф,мм/пролёт,мм  точек');
  for (const v of verticals) {
    log(
      `  ${v.xMm.toFixed(1).padStart(6)}  ${v.tilt.toFixed(3).padStart(7)}  ${v.bowMm.toFixed(2).padStart(6)}  ${v.driftMm.toFixed(2).padStart(6)} / ${v.spanMm.toFixed(0)}  ${v.points}`,
    );
  }
  if (horizontals.length && verticals.length) {
    const meanH = horizontals.reduce((s, h) => s + h.theta, 0) / horizontals.length;
    const meanV = verticals.reduce((s, v) => s + v.tilt, 0) / verticals.length;
    const meanBow = verticals.reduce((s, v) => s + v.bowMm, 0) / verticals.length;
    log(
      `\nСредний угол горизонталей ${meanH.toFixed(3)}°, средний tilt вертикалей ${meanV.toFixed(3)}°, средний bow вертикалей ${meanBow.toFixed(2)} мм`,
    );
    log(
      `  → ${Math.abs(meanV) < 0.05 ? 'вертикали стоят: искажение — срез (вертикальный сдвиг столбцов достаточен)' : Math.abs(meanV - meanH) < 0.05 ? 'вертикали наклонены как горизонтали: поворот — нужна горизонтальная составляющая' : 'смешанный случай — смотреть профиль дрейфа'}`,
    );
  }
  if (horizontals.length >= 3 && verticals.length) {
    const stepFit = fitStep(horizontals.map((h) => ({ u: h.u, theta: h.theta })));
    log(
      `\nСтупень по горизонталям: ${describeProfile(stepFit.profile)}; максимальный остаток ${stepFit.maxResidual.toFixed(3)}°`,
    );
    // Локальный наклон вертикалей (dx/dy между соседними полосами) против угла строк на той
    // же высоте: отношение — доля бокового дрейфа k (1 — поворот, 0 — срез).
    const sortedH = horizontals.slice().sort((p, q) => p.u - q.u);
    const thetaH = (u) => {
      if (u <= sortedH[0].u) return sortedH[0].theta;
      for (let i = 1; i < sortedH.length; i += 1) {
        if (u <= sortedH[i].u) {
          const t = (u - sortedH[i - 1].u) / (sortedH[i].u - sortedH[i - 1].u);
          return sortedH[i - 1].theta * (1 - t) + sortedH[i].theta * t;
        }
      }
      return sortedH[sortedH.length - 1].theta;
    };
    const buckets = new Map();
    let num = 0;
    let den = 0;
    for (const v of verticals) {
      for (let i = 1; i < v.samples.length; i += 1) {
        const a = v.samples[i - 1];
        const b = v.samples[i];
        const uMid = (a.along + b.along) / 2 / height;
        const tilt = Math.atan((b.across - a.across) / (b.along - a.along)) / DEG;
        const th = thetaH(uMid);
        const key = Math.round(uMid * 100) / 100;
        const bucket = buckets.get(key) ?? { n: 0, tilt: 0, theta: 0 };
        bucket.n += 1;
        bucket.tilt += tilt;
        bucket.theta += th;
        buckets.set(key, bucket);
        if (Math.abs(th) > 0.1) {
          num += tilt * th;
          den += th * th;
        }
      }
    }
    log('\nВертикали локально (между соседними полосами) против угла строк на той же высоте:');
    log('   u     θ строк,°  наклон верт.,°  отношение');
    for (const [key, b] of [...buckets.entries()].sort((p, q) => p[0] - q[0])) {
      const th = b.theta / b.n;
      const tl = b.tilt / b.n;
      log(
        `  ${key.toFixed(2)}   ${th.toFixed(3).padStart(7)}      ${tl.toFixed(3).padStart(7)}      ${Math.abs(th) > 0.1 ? (tl / th).toFixed(2) : '   —'}`,
      );
    }
    log(
      `  k (доля бокового дрейфа, МНК по точкам с |θ| > 0,1°) = ${den > 0 ? (num / den).toFixed(2) : '—'}`,
    );
    // Модель «наклон вертикали = θ строк + φ»: φ — постоянное смещение направления подачи
    // относительно строк (устройство / прошивка); оценка — среднее (tilt − θ) по полосам.
    let phiSum = 0;
    let phiN = 0;
    let phi2 = 0;
    for (const b of buckets.values()) {
      const d = b.tilt / b.n - b.theta / b.n;
      phiSum += d;
      phi2 += d * d;
      phiN += 1;
    }
    const phi = phiSum / phiN;
    log(
      `  φ (наклон вертикалей минус угол строк, среднее по полосам) = ${phi.toFixed(3)}° ± ${Math.sqrt(phi2 / phiN - phi * phi).toFixed(3)}`,
    );
  }
  return {
    horizontals,
    verticals,
    fit: fit?.profile ?? null,
    maxResidual: fit?.maxResidual ?? null,
  };
}

// --- Синтетика для бенча ---------------------------------------------------------------------

function hash(i) {
  let h = (i ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

/** Идеальная «страница текста» (значение серого) в координатах без искажения, мм. */
function idealPage(xMm, yMm) {
  if (xMm < 20 || xMm > 190 || yMm < 25 || yMm > 275) return 1;
  const pitch = 4.5;
  const lineIndex = Math.floor((yMm - 25) / pitch);
  const inLine = yMm - 25 - lineIndex * pitch;
  if (inLine > 2.2) return 1; // межстрочный просвет
  if (hash(lineIndex * 7919) < 0.12 && xMm > 20 + 170 * hash(lineIndex * 31)) return 1; // короткая строка
  const wordIndex = Math.floor(xMm / 1.6);
  if (hash(lineIndex * 104729 + wordIndex) < 0.18) return 1; // пробел между словами
  const stroke =
    hash(lineIndex * 1301 + Math.floor(xMm / 0.45)) < 0.55 || inLine < 0.35 || inLine > 1.85;
  return stroke ? 0.15 : 0.85;
}

/** Синтетический скан: искажённая страница с профилем, шум, JPEG q85. */
async function syntheticScan({ dpi, channels, profile }) {
  const width = Math.round((A4_WIDTH_MM * dpi) / 25.4);
  const height = Math.round((A4_HEIGHT_MM * dpi) / 25.4);
  const pxPerMm = dpi / 25.4;
  const tan = tanRows(profile, height);
  const xc = width / 2;
  const raw = Buffer.allocUnsafe(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const t = tan[y];
    for (let x = 0; x < width; x += 1) {
      // Искажение — обратное коррекции: in(x, y) = ideal(x, y + (x − xc)·tanθ(y)).
      const ySrc = y + (x - xc) * t;
      const v = idealPage(x / pxPerMm, ySrc / pxPerMm);
      const noise = (hash(y * width + x) - 0.5) * 18;
      const g = Math.max(0, Math.min(255, Math.round(v * 240 + 8 + noise)));
      const o = (y * width + x) * channels;
      for (let c = 0; c < channels; c += 1) raw[o + c] = c === 0 ? g : Math.min(255, g + c * 3);
    }
  }
  const bytes = await sharp(raw, { raw: { width, height, channels } })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { bytes, width, height, channels };
}

// --- Измерение и коррекция одного JPEG -----------------------------------------------------

async function measureJpeg(bytes, { log, onBand, family } = {}) {
  const started = performance.now();
  const gray = await decodeGray(bytes, WORKING_LONG_SIDE);
  const decodeMs = performance.now() - started;
  const result = await measureGray(gray, { log, onBand, family });
  return { ...result, decodeMs, working: { width: gray.width, height: gray.height } };
}

async function straightenJpeg(
  bytes,
  profile,
  { dpi, lateral, bandMpx = 1, yieldBetween = true, onBand, quality = 92, k = LATERAL_K },
) {
  const t0 = performance.now();
  const { data, info } = await sharp(bytes, { limitInputPixels: 80_000_000 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const t1 = performance.now();
  const out = await straightenRaw(data, info, profile, {
    lateral,
    k,
    bandMpx,
    yieldBetween,
    onBand,
  });
  const t2 = performance.now();
  const jpeg = await sharp(out, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .jpeg({ quality, chromaSubsampling: '4:4:4' })
    .withMetadata({ density: dpi })
    .toBuffer();
  const t3 = performance.now();
  return { jpeg, info, decodeMs: t1 - t0, warpMs: t2 - t1, encodeMs: t3 - t2 };
}

// --- Воркер: та же коррекция в worker_threads ------------------------------------------------

if (!isMainThread) {
  parentPort.on('message', async ({ bytes, profile, lateral, k, bandMpx, dpi }) => {
    // Буферы sharp непередаваемы (пул / внешняя память): в поток уходят байты JPEG копией, а
    // декод, warp и энкод живут здесь — главный поток сырых пикселей не держит.
    const result = await straightenJpeg(Buffer.from(bytes), profile, {
      dpi,
      lateral,
      k,
      bandMpx,
      yieldBetween: false,
    });
    const jpeg = new Uint8Array(result.jpeg.length);
    jpeg.set(result.jpeg);
    const { decodeMs, warpMs, encodeMs } = result;
    parentPort.postMessage({ jpeg, decodeMs, warpMs, encodeMs }, [jpeg.buffer]);
  });
}

function straightenInWorker(worker, bytes, profile, { lateral, k, bandMpx, dpi }) {
  return new Promise((done, fail) => {
    worker.once('message', (message) => done({ ...message, jpeg: Buffer.from(message.jpeg) }));
    worker.once('error', fail);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    worker.postMessage({ bytes: copy, profile, lateral, k, bandMpx, dpi }, [copy.buffer]);
  });
}

// --- Паузы цикла событий ---------------------------------------------------------------------

function stallProbe() {
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  let maxStall = 0;
  let last = performance.now();
  let rssPeak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const now = performance.now();
    maxStall = Math.max(maxStall, now - last - 25);
    last = now;
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 25);
  return {
    async snapshot() {
      // Синхронный кусок кончается микрозадачей раньше, чем сработает просроченный таймер:
      // без паузы снимок обнулил бы отметку и потерял бы стойло.
      await sleep(30);
      const out = {
        p50: histogram.percentile(50) / 1e6,
        p95: histogram.percentile(95) / 1e6,
        max: histogram.max / 1e6,
        probeMax: Math.max(maxStall, histogram.max / 1e6 - 5),
        rssPeak,
      };
      histogram.reset();
      maxStall = 0;
      last = performance.now();
      rssPeak = process.memoryUsage().rss;
      return out;
    },
    stop() {
      clearInterval(timer);
      histogram.disable();
    },
  };
}

// --- Команды ---------------------------------------------------------------------------------

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dpi: { type: 'string', default: '300' },
    channels: { type: 'string', default: '1' },
    'band-mpx': { type: 'string', default: '1' },
    pages: { type: 'string', default: '3' },
    worker: { type: 'boolean', default: false },
    lateral: { type: 'boolean', default: false },
    out: { type: 'string' },
    profile: { type: 'string' },
    family: { type: 'string', default: 'knots' },
    'band-mm': { type: 'string' },
    'halves-tol': { type: 'string' },
    k: { type: 'string' },
    quiet: { type: 'boolean', default: false },
  },
});
const [command, input] = positionals;
const log = (text) => console.log(text);
const bandLog = options.quiet ? () => {} : log;
const dpi = Number(options.dpi);
const lateralK = options.k === undefined ? LATERAL_K : Number(options.k);
if (options['band-mm'] !== undefined) BAND_MM = Number(options['band-mm']);
if (options['halves-tol'] !== undefined) HALVES_TOLERANCE_DEG = Number(options['halves-tol']);
const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(0);

async function commandGrid() {
  await gridAnalysis(readFileSync(input), { dpi, log });
}

async function commandMeasure() {
  const result = await measureJpeg(readFileSync(input), { log: bandLog, family: options.family });
  log(
    `\nРабочая картинка ${result.working.width}×${result.working.height}; декод ${result.decodeMs.toFixed(0)} мс, полосы ${result.bandsMs.toFixed(0)} мс`,
  );
  log(
    `Полос ${result.bands.length}, валидных ${result.valid}; исход: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`,
  );
  if (result.quad) {
    log(
      `Форма: дуга остаток ${result.quad.maxResidual.toFixed(3)}° (${describeProfile(result.quad.profile)}); ступень остаток ${result.step.maxResidual.toFixed(3)}° (${describeProfile(result.step.profile)})`,
    );
  }
  if (result.fit && result.contrast) {
    const kind = result.linear ? ` (прямая: дыра покрытия ${result.supportGap.toFixed(2)})` : '';
    log(
      `Профиль${kind}: ${describeProfile(result.fit.profile)}; покрытие ${(result.coverage * 100).toFixed(0)}%`,
    );
    log(
      `Контраст строк: до ${result.contrast.before.toExponential(3)} после ${result.contrast.after.toExponential(3)} — ×${result.contrast.ratio.toFixed(2)} (порог ${IMPROVE_K})`,
    );
  }
  return result;
}

async function commandStraighten() {
  if (!options.out) throw new Error('нужен --out <файл.jpg>');
  const bytes = readFileSync(input);
  let profile;
  if (options.profile) {
    const [a, b, c] = options.profile.split(',').map(Number);
    profile = { a, b, c };
  } else {
    const measured = await commandMeasure();
    if (!measured.fit) throw new Error(`профиля нет: ${measured.outcome}`);
    profile = measured.fit.profile;
  }
  const result = await straightenJpeg(bytes, profile, {
    dpi,
    lateral: options.lateral,
    k: lateralK,
    bandMpx: Number(options['band-mpx']),
  });
  writeFileSync(resolve(options.out), result.jpeg);
  log(
    `Записано ${options.out}: ${result.info.width}×${result.info.height}×${result.info.channels}; декод ${result.decodeMs.toFixed(0)} мс, warp ${result.warpMs.toFixed(0)} мс, энкод ${result.encodeMs.toFixed(0)} мс; размер ${(result.jpeg.length / bytes.length).toFixed(2)}× входа`,
  );
}

/** Синтетический скан в файл — для `measure`/`straighten`/`grid` по частям и для U2. */
async function commandSynth() {
  if (!options.out) throw new Error('нужен --out <файл.jpg>');
  const [a = 0.3, b = 0.8, c = 0.5] = (options.profile ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number);
  const scan = await syntheticScan({
    dpi,
    channels: Number(options.channels),
    profile: { a, b, c },
  });
  writeFileSync(resolve(options.out), scan.bytes);
  log(`Записано ${options.out}: ${scan.width}×${scan.height}, профиль a=${a} b=${b} c=${c}`);
}

/**
 * Искажение готовой картинки (например, рендера листа сетки) профилем — обратное коррекции,
 * с боковым дрейфом по --lateral. Проверка анализа сетки и ресэмплера до настоящих сканов.
 */
async function commandDistort() {
  if (!options.out) throw new Error('нужен --out <файл.jpg>');
  const [a = 0.3, b = 0.8, c = 0.5] = (options.profile ?? '')
    .split(',')
    .filter(Boolean)
    .map(Number);
  const profile = { a, b, c };
  const { data, info } = await sharp(readFileSync(input), { limitInputPixels: 80_000_000 })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const tan = tanRows(profile, height);
  const drift = options.lateral ? lateralRows(tan, height) : new Float64Array(height);
  const xc = width / 2;
  const out = Buffer.allocUnsafe(width * height);
  const sample = (x, y) => {
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 255;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ix1 = Math.min(ix + 1, width - 1);
    const iy1 = Math.min(iy + 1, height - 1);
    const top = data[iy * width + ix] * (1 - fx) + data[iy * width + ix1] * fx;
    const bottom = data[iy1 * width + ix] * (1 - fx) + data[iy1 * width + ix1] * fx;
    return top * (1 - fy) + bottom * fy;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Обратное коррекции: in(x, y) = ideal(x − d(y), y + (x − xc)·tanθ(y)).
      const v = sample(x - drift[y], y + (x - xc) * tan[y]);
      const noise = (hash(y * width + x) - 0.5) * 10;
      out[y * width + x] = Math.max(0, Math.min(255, Math.round(v + noise)));
    }
  }
  const jpeg = await sharp(out, { raw: { width, height, channels: 1 } })
    .jpeg({ quality: 85 })
    .toBuffer();
  writeFileSync(resolve(options.out), jpeg);
  log(
    `Записано ${options.out}: ${width}×${height}, профиль a=${a} b=${b} c=${c}${options.lateral ? ', с дрейфом' : ''}`,
  );
}

async function commandBench() {
  const channels = Number(options.channels);
  const pages = Number(options.pages);
  const bandMpx = Number(options['band-mpx']);
  const profile = { a: 0.3, b: 0.8, c: 0.5 };
  log(
    `Синтетика ${dpi} dpi × ${channels} кан., профиль a=${profile.a} b=${profile.b} c=${profile.c}, полоса ${bandMpx} Мпикс, ${options.worker ? 'воркер' : 'inline'}${options.lateral ? ', с боковым дрейфом' : ''}`,
  );
  const t0 = performance.now();
  const scan = await syntheticScan({ dpi, channels, profile });
  log(
    `  вход ${scan.width}×${scan.height}, JPEG ${mb(scan.bytes.length)} МБ, сгенерирован за ${((performance.now() - t0) / 1000).toFixed(1)} с`,
  );
  const worker = options.worker
    ? new Worker(new URL(import.meta.url), { workerData: { role: 'warp' } })
    : null;
  const probe = stallProbe();
  const rssBase = process.memoryUsage().rss;
  const rows = [];
  const bandTimes = [];
  const measureChunks = [];
  try {
    for (let page = 1; page <= pages; page += 1) {
      await probe.snapshot();
      const m = await measureJpeg(scan.bytes, {
        log: () => {},
        onBand: (ms) => measureChunks.push(ms),
        family: options.family,
      });
      const measureStall = await probe.snapshot();
      const measuredProfile = m.fit?.profile ?? profile;
      let decodeMs;
      let warpMs;
      let encodeMs;
      let jpeg;
      let warpStall;
      if (worker) {
        const r = await straightenInWorker(worker, scan.bytes, measuredProfile, {
          lateral: options.lateral,
          k: lateralK,
          bandMpx,
          dpi,
        });
        ({ jpeg, decodeMs, warpMs, encodeMs } = r);
        warpStall = await probe.snapshot();
      } else {
        const tDecode = performance.now();
        const { data, info } = await sharp(scan.bytes, { limitInputPixels: 80_000_000 })
          .raw()
          .toBuffer({ resolveWithObject: true });
        decodeMs = performance.now() - tDecode;
        await probe.snapshot();
        const tWarp = performance.now();
        const warp = await straightenRaw(data, info, measuredProfile, {
          lateral: options.lateral,
          k: lateralK,
          bandMpx,
          onBand: (ms) => bandTimes.push(ms),
        });
        warpMs = performance.now() - tWarp;
        warpStall = await probe.snapshot();
        const tEncode = performance.now();
        jpeg = await sharp(warp, {
          raw: { width: info.width, height: info.height, channels: info.channels },
        })
          .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
          .withMetadata({ density: dpi })
          .toBuffer();
        encodeMs = performance.now() - tEncode;
      }
      const tThumb = performance.now();
      await sharp(jpeg)
        .resize({ width: 320, height: 452, fit: 'inside' })
        .jpeg({ quality: 80 })
        .toBuffer();
      const thumbMs = performance.now() - tThumb;
      const encodeStall = await probe.snapshot();
      const check = await measureJpeg(jpeg, { log: () => {}, family: options.family });
      rows.push({
        page,
        outcome: m.outcome,
        measured: m.fit?.profile ?? null,
        family: options.family,
        measureMs: m.decodeMs + m.bandsMs,
        measureStall,
        decodeMs,
        warpMs,
        warpStall,
        encodeMs,
        thumbMs,
        encodeStall,
        sizeRatio: jpeg.length / scan.bytes.length,
        rssAfterMb: Number(mb(process.memoryUsage().rss - rssBase)),
        checkOutcome: check.outcome,
        checkProfile: check.fit?.profile ?? null,
      });
      const r = rows[rows.length - 1];
      log(
        `  стр.${page}: измерение ${r.measureMs.toFixed(0)} мс (пауза p95 ${r.measureStall.p95.toFixed(1)} / max ${r.measureStall.probeMax.toFixed(0)} мс) | декод ${decodeMs.toFixed(0)} мс | ` +
          `warp ${warpMs.toFixed(0)} мс (пауза p95 ${r.warpStall.p95.toFixed(1)} / max ${r.warpStall.probeMax.toFixed(0)} мс) | энкод ${encodeMs.toFixed(0)} мс, миниатюра ${thumbMs.toFixed(0)} мс | ` +
          `размер ×${r.sizeRatio.toFixed(2)} | RSS сверх базы ${r.rssAfterMb} МБ | исход ${m.outcome} → после ${check.outcome}`,
      );
      if (page === 1 && m.fit) {
        log(
          `    измерено: ${describeProfile(m.fit.profile)}; контраст ×${m.contrast.ratio.toFixed(2)}`,
        );
        if (check.fit) log(`    после коррекции: ${describeProfile(check.fit.profile)}`);
      }
    }
  } finally {
    probe.stop();
    await worker?.terminate();
  }
  const rssPeak = Math.max(
    ...rows.map((r) =>
      Math.max(r.measureStall.rssPeak, r.warpStall.rssPeak, r.encodeStall.rssPeak),
    ),
  );
  const chunkStats = (name, times) => {
    if (!times.length) return;
    const sorted = times.slice().sort((a, b) => a - b);
    log(
      `  чанки ${name}: ${times.length} шт., p50 ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} мс, p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)} мс, max ${sorted[sorted.length - 1].toFixed(1)} мс`,
    );
  };
  chunkStats('измерения (полосы)', measureChunks);
  chunkStats('warp (полосы строк)', bandTimes);
  log(
    `  пик RSS сверх базы ${mb(rssPeak - rssBase)} МБ; плато после ${pages} стр.: ${rows
      .slice(-3)
      .map((r) => r.rssAfterMb)
      .join(' / ')} МБ`,
  );
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  mkdirSync(resolve('temp'), { recursive: true });
  const file = resolve(
    `temp/straighten-bench-${stamp}-${dpi}-${channels}ch-${options.worker ? 'worker' : 'inline'}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify(
      {
        options,
        profile,
        input: { width: scan.width, height: scan.height, bytes: scan.bytes.length },
        rows,
        rssBase,
        rssPeak,
      },
      null,
      2,
    ),
  );
  log(`  JSON: ${file}`);
}

if (isMainThread) {
  const commands = {
    grid: commandGrid,
    measure: commandMeasure,
    straighten: commandStraighten,
    synth: commandSynth,
    distort: commandDistort,
    bench: commandBench,
  };
  const run = commands[command];
  if (!run || (command !== 'bench' && command !== 'synth' && !input)) {
    console.error('Команды: grid <скан> | measure <скан> | straighten <скан> --out <файл> | bench');
    process.exit(2);
  }
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
