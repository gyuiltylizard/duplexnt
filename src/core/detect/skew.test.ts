import { describe, expect, it } from 'vitest';
import type { SkewMeasure, SkewProfile } from '@shared';
import { skewThetaAt } from '@shared';
import {
  fullLineNear,
  lineEndsAt,
  quadraticTheta,
  stepTheta,
  syntheticGray,
  type ThetaOf,
} from '../../../test/support/synthetic-page';
import {
  alignmentContrast,
  BAND_MM,
  FALLBACK_BAND_MM,
  IMPROVE_RATIO,
  isLevel,
  LEVEL_DEG,
  measureSkew,
  SKEW_DETECTOR_VERSION,
  verdictOf,
} from './skew';
import { marginHistogramOf, paperWhiteOf } from './gray';

// Чистая часть детектора перекоса (план M6, U2) на синтетике рабочего размера: знак и ось
// KTD-1, узлы в допуске к заданному θ(u), гейты и исход. Декод через `sharp` и настоящие
// сканы — `test/integration/skew-detector.test.ts`.

/** Сразу, без макрозадачи: тестам точка уступки не нужна, но считается. */
const immediate = () => Promise.resolve();

async function measure(theta: ThetaOf, content?: 'text' | 'blank' | 'band' | 'photo') {
  const yields: number[] = [];
  const gray = syntheticGray({ theta, ...(content === undefined ? {} : { content }) });
  const result = await measureSkew(gray, {
    yieldBetween: () => {
      yields.push(1);
      return Promise.resolve();
    },
  });
  return { result, yields: yields.length, gray };
}

/** Узлы профиля против заданного θ(u): наибольшее расхождение по узлам, удовлетворяющим `where`. */
function knotError(
  profile: SkewProfile,
  theta: ThetaOf,
  where: (u: number) => boolean = () => true,
) {
  let worst = 0;
  profile.us.forEach((u, i) => {
    if (where(u)) {
      worst = Math.max(worst, Math.abs((profile.thetas[i] ?? 0) - theta(u)));
    }
  });
  return worst;
}

const profileOf = (result: SkewMeasure): SkewProfile => {
  expect(result.profile, result.reason ?? result.outcome).not.toBeNull();
  return result.profile ?? { kind: 'knots', us: [], thetas: [] };
};

describe('детектор перекоса: знак, ось и узлы на синтетике', () => {
  it('ступень: верх ровный, низ по часовой на 0,8° — узлы в допуске 0,05° вне колена, исход willStraighten', async () => {
    const theta = stepTheta(0, -0.8, 0.55, 0.12);
    const { result, gray } = await measure(theta);
    const profile = profileOf(result);

    expect(result.outcome).toBe('willStraighten');
    expect(result.bandMm).toBe(BAND_MM);
    expect(knotError(profile, theta, (u) => Math.abs(u - 0.55) > 0.12)).toBeLessThanOrEqual(0.05);
    expect(knotError(profile, theta)).toBeLessThanOrEqual(0.15);
    expect(skewThetaAt(profile, 0.2)).toBeCloseTo(0, 1);
    expect(skewThetaAt(profile, 0.9)).toBeCloseTo(-0.8, 1);

    // Соглашение о знаке по пикселям: θ < 0 внизу — правый конец строки ниже (больший y).
    const bottom = lineEndsAt(gray, fullLineNear(48));
    const top = lineEndsAt(gray, fullLineNear(8));
    expect(bottom).not.toBeNull();
    expect(top).not.toBeNull();
    expect((bottom?.right ?? 0) - (bottom?.left ?? 0)).toBeGreaterThan(5);
    expect(Math.abs((top?.right ?? 0) - (top?.left ?? 0))).toBeLessThan(1.5);
  });

  it('ступень в другую сторону (верх против часовой) ложится так же — семейство не предполагается', async () => {
    const theta = stepTheta(0.9, 0.1, 0.4, 0.16);
    const { result } = await measure(theta);

    expect(result.outcome).toBe('willStraighten');
    expect(
      knotError(profileOf(result), theta, (u) => Math.abs(u - 0.4) > 0.16),
    ).toBeLessThanOrEqual(0.05);
  });

  it('общий наклон 0,5° — все узлы ≈ 0,5°, веер ≈ 0, выправляется', async () => {
    const theta: ThetaOf = () => 0.5;
    const { result } = await measure(theta);
    const profile = profileOf(result);

    expect(result.outcome).toBe('willStraighten');
    expect(knotError(profile, theta)).toBeLessThanOrEqual(0.05);
    expect(result.fanMm ?? 1).toBeLessThan(0.4);
  });

  it('дуга с амплитудой 0,8° — узлы в допуске 0,05°', async () => {
    const theta = quadraticTheta(0.2, 0.4, -3.2);
    const { result } = await measure(theta);

    expect(result.outcome).toBe('willStraighten');
    expect(knotError(profileOf(result), theta)).toBeLessThanOrEqual(0.05);
  });
});

describe('детектор перекоса: гейты и исход', () => {
  it('ровная страница — level, без метрики; слегка косая ниже порога движения — тоже level', async () => {
    const level = await measure(() => 0);
    const faint = await measure(() => LEVEL_DEG / 2);

    expect(level.result.outcome).toBe('level');
    expect(level.result.contrast).toBeNull();
    expect(faint.result.outcome).toBe('level');
  });

  it('искажённая страница — willStraighten с ростом контраста не меньше запаса', async () => {
    const { result } = await measure(stepTheta(0.3, -0.7, 0.5, 0.16));

    expect(result.outcome).toBe('willStraighten');
    expect(result.contrast?.ratio ?? 0).toBeGreaterThanOrEqual(IMPROVE_RATIO);
  });

  it('чистый лист — unmeasurable: ни одной полосы с чернилами', async () => {
    const { result } = await measure(() => 0.5, 'blank');

    expect(result.outcome).toBe('unmeasurable');
    expect(result.profile).toBeNull();
    expect(result.bands.every((band) => band.reason === 'no-ink')).toBe(true);
  });

  it('строки только в одной узкой полосе — unmeasurable: мало полос или покрытия', async () => {
    const { result } = await measure(() => 0.5, 'band');

    expect(result.outcome).toBe('unmeasurable');
    expect(result.reason).toMatch(/полос|покрытие/);
  });

  it('«фотография» без строк — unmeasurable: чернил больше допустимого', async () => {
    const { result } = await measure(() => 0.5, 'photo');

    expect(result.outcome).toBe('unmeasurable');
    expect(result.bands.some((band) => band.reason === 'too-much-ink')).toBe(true);
  });

  it('точка уступки вызывается между полосами; подсказка устройства принимается и не меняет исход', async () => {
    const theta = stepTheta(0, -0.8, 0.55, 0.12);
    const gray = syntheticGray({ theta });
    const { result, yields } = await measure(theta);
    const withPrior = await measureSkew(gray, {
      yieldBetween: immediate,
      prior: { kind: 'step', u0: 0.3, w: 0.1, bottomDeg: 1.5 },
    });

    expect(yields).toBeGreaterThanOrEqual(result.bands.length);
    expect(withPrior).toEqual(result);
  });

  it('отмена между полосами: промис отклоняется причиной сигнала, дальше полосы не считаются', async () => {
    const gray = syntheticGray({ theta: stepTheta(0, -0.8, 0.55, 0.12) });
    const controller = new AbortController();
    let chunks = 0;
    const run = measureSkew(gray, {
      yieldBetween: immediate,
      signal: controller.signal,
      onChunk: () => {
        chunks += 1;
        if (chunks === 2) {
          controller.abort(new Error('стоп'));
        }
      },
    });

    await expect(run).rejects.toThrow('стоп');
    expect(chunks).toBe(2);
  });

  it('запасной проход полосами 50 мм помечается в результате', async () => {
    // Строки с разной фазой в двух колонках ловушку в чистой синтетике не дают; проверяется
    // только то, что обычный проход идёт 30 мм — запасной проверяют фикстуры (две колонки).
    const { result } = await measure(() => 0.5);

    expect([BAND_MM, FALLBACK_BAND_MM]).toContain(result.bandMm);
    expect(result.bandMm).toBe(BAND_MM);
  });
});

describe('детектор перекоса: метрика «не хуже» и пороги', () => {
  it('isLevel — по наибольшему |θ|; verdictOf — по запасу роста контраста', () => {
    expect(isLevel({ kind: 'knots', us: [0.2, 0.8], thetas: [0.05, -0.09] })).toBe(true);
    expect(isLevel({ kind: 'knots', us: [0.2, 0.8], thetas: [0.05, -0.1] })).toBe(false);
    expect(verdictOf({ before: 1, after: IMPROVE_RATIO, ratio: IMPROVE_RATIO })).toBe(
      'willStraighten',
    );
    expect(verdictOf({ before: 1, after: 1.2, ratio: 1.2 })).toBe('notImproved');
  });

  it('контраст: верный профиль делает строки резче, обратный по знаку — тупее', () => {
    const theta = stepTheta(0, -0.8, 0.55, 0.12);
    const gray = syntheticGray({ theta });
    const { histogram, total } = marginHistogramOf(gray);
    const white = paperWhiteOf(histogram, total);
    const us = [0.1, 0.3, 0.5, 0.7, 0.9];
    const right: SkewProfile = { kind: 'knots', us, thetas: us.map(theta) };
    const wrong: SkewProfile = { kind: 'knots', us, thetas: us.map((u) => -theta(u)) };

    expect(alignmentContrast(gray, white, right).ratio).toBeGreaterThan(IMPROVE_RATIO);
    expect(alignmentContrast(gray, white, wrong).ratio).toBeLessThan(1);
  });

  it('версия детектора — целое от единицы', () => {
    expect(Number.isInteger(SKEW_DETECTOR_VERSION)).toBe(true);
    expect(SKEW_DETECTOR_VERSION).toBeGreaterThanOrEqual(1);
  });
});
