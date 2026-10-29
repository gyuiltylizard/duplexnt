import { describe, expect, it } from 'vitest';
import {
  isSkewProfile,
  skewFanMm,
  skewLateralRows,
  skewMaxAbsDeg,
  skewProfileOf,
  skewTanRows,
  skewThetaAt,
  STRAIGHTEN_GEOMETRY_VERSION,
} from './skew';

// Профиль наклона узлами (план M6, U2; амендмент 2026-10-28): сплайн между узлами монотонен,
// за крайними узлами — константа, дрейф — интеграл tanθ от середины высоты.

const step = skewProfileOf([
  { u: 0.1, theta: 0.3 },
  { u: 0.3, theta: 0.3 },
  { u: 0.5, theta: 0.3 },
  { u: 0.6, theta: -0.5 },
  { u: 0.8, theta: -0.8 },
  { u: 0.95, theta: -0.8 },
]);

describe('профиль наклона узлами', () => {
  it('в узлах — заданные углы, за крайними узлами — константа', () => {
    expect(skewThetaAt(step, 0.3)).toBeCloseTo(0.3, 9);
    expect(skewThetaAt(step, 0.6)).toBeCloseTo(-0.5, 9);
    expect(skewThetaAt(step, 0)).toBe(0.3);
    expect(skewThetaAt(step, 1)).toBe(-0.8);
  });

  it('между узлами сплайн монотонен: ступень без перехлёста и ложных волн', () => {
    let previous = skewThetaAt(step, 0);
    for (let u = 0.001; u <= 1; u += 0.001) {
      const theta = skewThetaAt(step, u);
      expect(theta).toBeLessThanOrEqual(previous + 1e-12);
      expect(theta).toBeGreaterThanOrEqual(-0.8 - 1e-12);
      expect(theta).toBeLessThanOrEqual(0.3 + 1e-12);
      previous = theta;
    }
  });

  it('один узел — постоянный наклон; два узла — прямая между ними', () => {
    const one = skewProfileOf([{ u: 0.4, theta: 0.5 }]);
    const two = skewProfileOf([
      { u: 0, theta: -1 },
      { u: 1, theta: 1 },
    ]);

    expect(skewThetaAt(one, 0)).toBe(0.5);
    expect(skewThetaAt(one, 1)).toBe(0.5);
    expect(skewThetaAt(two, 0.25)).toBeCloseTo(-0.5, 9);
    expect(skewThetaAt(two, 0.75)).toBeCloseTo(0.5, 9);
  });

  it('узлы сортируются по высоте; пустой список, повтор, выход за [0, 1] и нечисло — ошибка', () => {
    expect(
      skewProfileOf([
        { u: 0.8, theta: 2 },
        { u: 0.2, theta: 1 },
      ]).us,
    ).toEqual([0.2, 0.8]);
    expect(() => skewProfileOf([])).toThrow(/без узлов/);
    expect(() =>
      skewProfileOf([
        { u: 0.5, theta: 1 },
        { u: 0.5, theta: 2 },
      ]),
    ).toThrow(/одной высоте/);
    expect(() => skewProfileOf([{ u: 1.5, theta: 1 }])).toThrow(/вне допустимого/);
    expect(() => skewProfileOf([{ u: 0.5, theta: NaN }])).toThrow(/вне допустимого/);
  });

  it('проверка формы с диска: валидный профиль проходит, кривые — нет', () => {
    expect(isSkewProfile(step)).toBe(true);
    expect(isSkewProfile({ kind: 'knots', us: [0.2, 0.1], thetas: [1, 2] })).toBe(false);
    expect(isSkewProfile({ kind: 'knots', us: [0.2], thetas: [1, 2] })).toBe(false);
    expect(isSkewProfile({ kind: 'knots', us: ['a'], thetas: [1] })).toBe(false);
    expect(isSkewProfile({ kind: 'step', us: [0.2], thetas: [1] })).toBe(false);
    expect(isSkewProfile(null)).toBe(false);
  });

  it('tanθ по строкам — центр строки; дрейф — интеграл от середины, нулевой в ней, с долей k', () => {
    const flat = skewProfileOf([{ u: 0.5, theta: 1 }]);
    const tan = skewTanRows(flat, 100);
    const drift = skewLateralRows(tan, 1);
    const half = skewLateralRows(tan, 0.5);

    expect(tan[0]).toBeCloseTo(Math.tan(Math.PI / 180), 12);
    expect(drift[50]).toBe(0);
    expect(drift[60]).toBeCloseTo(10 * Math.tan(Math.PI / 180), 9);
    expect(drift[40]).toBeCloseTo(-10 * Math.tan(Math.PI / 180), 9);
    expect(half[60]).toBeCloseTo(5 * Math.tan(Math.PI / 180), 9);
  });

  it('наибольший |θ| и веер: веер — расхождение концов 190 мм между крайними углами', () => {
    expect(skewMaxAbsDeg(step)).toBe(0.8);
    expect(skewFanMm(step)).toBeCloseTo(190 * Math.tan((1.1 * Math.PI) / 180), 6);
    expect(skewFanMm(skewProfileOf([{ u: 0.5, theta: 2 }]))).toBe(0);
  });

  it('версия геометрии — целое от единицы', () => {
    expect(Number.isInteger(STRAIGHTEN_GEOMETRY_VERSION)).toBe(true);
    expect(STRAIGHTEN_GEOMETRY_VERSION).toBeGreaterThanOrEqual(1);
  });
});
