// Профиль перекоса подачи (M6; план `docs/plans/2026-10-28-001-feat-m6-straighten-plan.md`,
// KTD-1 с амендментом 2026-10-28, KTD-9). Контракт между ядром, main и интерфейсом: здесь
// только типы, единицы и чистая математика профиля — ни Node, ни DOM, ни Electron.
//
// Геометрия (KTD-1): линейный сенсор снимает по строке за такт; лист, повёрнутый на θ(y) в
// момент строки y, даёт точке с колонкой x вертикальное смещение (x − xc)·tanθ(y). Лист
// поворачивается целиком (сетки ET-3850: k ≈ 1), поэтому строка ещё уезжает вбок на интеграл
// tanθ по высоте. Знак: θ > 0 — правый конец строки выше (меньший y). Единицы — градусы и
// доли высоты (u = y / H), от DPI не зависят.

/**
 * Версия геометрии коррекции: модель, семейство профиля, знак и ось. Пишется в записи
 * измерения и коррекции; запись с другой версией пересчитывается фоном (KTD-6, KTD-11, AE13).
 * 1 — узлы по полосам, вертикальный сдвиг плюс горизонтальный проход с k = 1 (амендмент
 * плана 2026-10-28).
 */
export const STRAIGHTEN_GEOMETRY_VERSION = 1;

/**
 * Профиль наклона θ(u) узлами по полосам: `us` — доли высоты по возрастанию (центроид чернил
 * каждой валидной полосы), `thetas` — угол строк там, в градусах. Между узлами — монотонный
 * кубический сплайн (без выбросов между узлами), за крайними узлами — константа. Семейство
 * формы не предполагается: ступень у остановки подачи, дуга, чистый наклон и чужой сканер
 * ложатся одинаково. Один узел — постоянный наклон по всей высоте.
 */
export interface SkewProfile {
  readonly kind: 'knots';
  readonly us: readonly number[];
  readonly thetas: readonly number[];
}

/**
 * Подсказка устройства для детектора (R4; точка врезки M6.5). Форма — сглаженная ступень у
 * остановки подачи, какой её даёт ET-3850: угол низа после остановки `bottomDeg`, положение
 * `u0` и ширина `w` перехода (логистика, 76 % перехода внутри ±w/2). В M6 подсказка всегда
 * отсутствует, а детектор её принимает и игнорирует.
 */
export interface SkewPrior {
  readonly kind: 'step';
  readonly u0: number;
  readonly w: number;
  readonly bottomDeg: number;
}

/**
 * Исход измерения страницы (KTD-5, KTD-9): `unmeasurable` — не по чему мерить или полосы
 * не ложатся на гладкий профиль; `level` — профиль ниже порога движения, оригинал байт в байт;
 * `notImproved` — сдвиг по профилю не делает строки резче с запасом; `willStraighten` — в
 * очередь коррекции попадает только он.
 */
export const SKEW_OUTCOMES = ['unmeasurable', 'level', 'notImproved', 'willStraighten'] as const;

export type SkewOutcome = (typeof SKEW_OUTCOMES)[number];

export type SkewBandReason = 'no-ink' | 'too-much-ink' | 'low-confidence' | 'halves-disagree';

/** Полоса измерения — для журнала вехи, тестов и подсказки M6.5; в снимок не идёт. */
export interface SkewBand {
  /** Доля высоты — центроид чернил полосы. */
  readonly u: number;
  /** Угол строк, градусы; `null` — полоса без угла (нет чернил или их слишком много). */
  readonly angle: number | null;
  /** Уверенность: отношение лучшего счёта резкости к худшему по грубому перебору. */
  readonly confidence: number;
  /** Доля чернильных пикселей полосы. */
  readonly inkFraction: number;
  /** Расхождение углов левой и правой половин, градусы; `Infinity` — половина не померена. */
  readonly halvesGap: number;
  /** Почему полоса отброшена; `null` — полоса валидна. */
  readonly reason: SkewBandReason | null;
}

/** Независимая метрика выровненности до и после сдвига и их отношение (KTD-5). */
export interface SkewContrast {
  readonly before: number;
  readonly after: number;
  readonly ratio: number;
}

/**
 * Результат измерения (R1, R3, R10). Профиль есть у всех исходов, кроме `unmeasurable`;
 * контраст «до/после» — у `notImproved` и `willStraighten`. `reason` — человеку и журналу
 * вехи, не интерфейсу.
 */
export interface SkewMeasure {
  readonly outcome: SkewOutcome;
  /** `STRAIGHTEN_GEOMETRY_VERSION` на момент измерения. */
  readonly geometryVersion: number;
  readonly profile: SkewProfile | null;
  readonly contrast: SkewContrast | null;
  /** Веер профиля: расхождение концов строки длиной `FAN_LINE_MM` между крайними углами, мм. */
  readonly fanMm: number | null;
  /**
   * Полосы, включая отброшенные, в порядке прохода сверху вниз; `u` — центроид чернил полосы,
   * при перекрытии полос строгого возрастания не гарантирует.
   */
  readonly bands: readonly SkewBand[];
  /** Ширина полосы, мм: 30, а при провале гейта формы — запасной проход 50. */
  readonly bandMm: number;
  /** Доля высоты, покрытая валидными полосами. */
  readonly coverage: number;
  /** Остаток формы: min(остаток дуги, остаток ступени) по валидным полосам, градусы. */
  readonly shapeResidual: number | null;
  readonly reason: string | null;
}

/** Длина горизонтальной линии, по которой считается веер (R23: 190 мм на ширину A4). */
export const FAN_LINE_MM = 190;

const DEG = Math.PI / 180;

/**
 * Наклоны монотонного кубического сплайна (Fritsch–Carlson): между узлами сплайн не выходит
 * за их значения — ступень не даёт перехлёста и ложных волн.
 */
function pchipSlopes(us: readonly number[], ys: readonly number[]): number[] {
  const n = us.length;
  const d = new Array<number>(n).fill(0);
  if (n < 2) {
    return d;
  }
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const du = (us[i + 1] ?? 0) - (us[i] ?? 0);
    h.push(du);
    delta.push(((ys[i + 1] ?? 0) - (ys[i] ?? 0)) / du);
  }
  if (n === 2) {
    return [delta[0] ?? 0, delta[0] ?? 0];
  }
  for (let i = 1; i < n - 1; i += 1) {
    const d0 = delta[i - 1] ?? 0;
    const d1 = delta[i] ?? 0;
    if (d0 * d1 <= 0) {
      d[i] = 0;
    } else {
      const w1 = 2 * (h[i] ?? 0) + (h[i - 1] ?? 0);
      const w2 = (h[i] ?? 0) + 2 * (h[i - 1] ?? 0);
      d[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
    }
  }
  const endSlope = (h0: number, h1: number, d0: number, d1: number): number => {
    let slope = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (Math.sign(slope) !== Math.sign(d0)) {
      slope = 0;
    } else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(slope) > 3 * Math.abs(d0)) {
      slope = 3 * d0;
    }
    return slope;
  };
  d[0] = endSlope(h[0] ?? 0, h[1] ?? 0, delta[0] ?? 0, delta[1] ?? 0);
  d[n - 1] = endSlope(h[n - 2] ?? 0, h[n - 3] ?? 0, delta[n - 2] ?? 0, delta[n - 3] ?? 0);
  return d;
}

/**
 * Профиль из узлов: сортирует по `u`, проверяет форму. Пустой список, повтор `u`, `u` вне
 * [0, 1] или нечисло — ошибка: профиль в журнале и снимке обязан быть валидным.
 */
export function skewProfileOf(knots: readonly { u: number; theta: number }[]): SkewProfile {
  if (knots.length === 0) {
    throw new Error('профиль наклона без узлов');
  }
  const sorted = knots.slice().sort((p, q) => p.u - q.u);
  for (let i = 0; i < sorted.length; i += 1) {
    const { u, theta } = sorted[i] ?? { u: NaN, theta: NaN };
    if (!(u >= 0 && u <= 1) || !Number.isFinite(theta)) {
      throw new Error(`узел профиля наклона вне допустимого: u=${u}, theta=${theta}`);
    }
    if (i > 0 && u === sorted[i - 1]?.u) {
      throw new Error(`два узла профиля наклона на одной высоте u=${u}`);
    }
  }
  return { kind: 'knots', us: sorted.map((p) => p.u), thetas: sorted.map((p) => p.theta) };
}

/** Профиль валиден по форме — для записей журнала, прочитанных с диска. */
export function isSkewProfile(value: unknown): value is SkewProfile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { kind, us, thetas } = value as Partial<Record<keyof SkewProfile, unknown>>;
  if (kind !== 'knots' || !Array.isArray(us) || !Array.isArray(thetas)) {
    return false;
  }
  if (us.length !== thetas.length) {
    return false;
  }
  const knots = us.map((u, i) => ({ u: u as number, theta: thetas[i] as number }));
  if (knots.some((p) => typeof p.u !== 'number' || typeof p.theta !== 'number')) {
    return false;
  }
  for (let i = 1; i < knots.length; i += 1) {
    if ((knots[i]?.u ?? 0) <= (knots[i - 1]?.u ?? 0)) {
      return false;
    }
  }
  try {
    skewProfileOf(knots);
  } catch {
    return false;
  }
  return true;
}

function thetaWithSlopes(profile: SkewProfile, slopes: readonly number[], u: number): number {
  const { us, thetas } = profile;
  const last = us.length - 1;
  const first = thetas[0] ?? 0;
  if (u <= (us[0] ?? 0)) {
    return first;
  }
  if (u >= (us[last] ?? 0)) {
    return thetas[last] ?? first;
  }
  let i = 0;
  while ((us[i + 1] ?? Infinity) < u) {
    i += 1;
  }
  const u0 = us[i] ?? 0;
  const h = (us[i + 1] ?? 0) - u0;
  const t = (u - u0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * (thetas[i] ?? 0) +
    (t3 - 2 * t2 + t) * h * (slopes[i] ?? 0) +
    (-2 * t3 + 3 * t2) * (thetas[i + 1] ?? 0) +
    (t3 - t2) * h * (slopes[i + 1] ?? 0)
  );
}

/**
 * Угол строк на доле высоты `u`, градусы: монотонный кубический сплайн между узлами, константа
 * за крайними. Для циклов по строкам — `skewTanRows`, он считает наклоны один раз.
 */
export function skewThetaAt(profile: SkewProfile, u: number): number {
  return thetaWithSlopes(profile, pchipSlopes(profile.us, profile.thetas), u);
}

/** tanθ для каждой строки картинки высотой `height` (центр строки — (y + 0,5) / height). */
export function skewTanRows(profile: SkewProfile, height: number): Float64Array {
  const slopes = pchipSlopes(profile.us, profile.thetas);
  const out = new Float64Array(height);
  for (let y = 0; y < height; y += 1) {
    out[y] = Math.tan(thetaWithSlopes(profile, slopes, (y + 0.5) / height) * DEG);
  }
  return out;
}

/**
 * Боковой дрейф строк в пикселях: интеграл tanθ от середины высоты, `k` — доля дрейфа от
 * интеграла (1 — лист поворачивается целиком, 0 — чистый срез). Обратное отображение
 * коррекции: `x_src = x + drift[y]`.
 */
export function skewLateralRows(tan: Float64Array, k: number): Float64Array {
  const height = tan.length;
  const out = new Float64Array(height);
  const yc = Math.floor(height / 2);
  let acc = 0;
  for (let y = yc; y < height; y += 1) {
    out[y] = acc * k;
    acc += tan[y] ?? 0;
  }
  acc = 0;
  for (let y = yc - 1; y >= 0; y -= 1) {
    acc -= tan[y] ?? 0;
    out[y] = acc * k;
  }
  return out;
}

/** Наибольший |θ| профиля по высоте, градусы: сплайн между узлами монотонен, экстремум — в узле. */
export function skewMaxAbsDeg(profile: SkewProfile): number {
  return Math.max(...profile.thetas.map(Math.abs));
}

/**
 * Веер профиля: расхождение концов строки длиной `lineMm` между наибольшим и наименьшим углом
 * по высоте, мм (R23). У профиля с одним узлом — 0: общий наклон веером не является.
 */
export function skewFanMm(profile: SkewProfile, lineMm: number = FAN_LINE_MM): number {
  const max = Math.max(...profile.thetas);
  const min = Math.min(...profile.thetas);
  return lineMm * Math.tan((max - min) * DEG);
}
