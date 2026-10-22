import { describe, expect, it } from 'vitest';
import {
  BLANK_DETECTOR_VERSION,
  BLANK_THRESHOLD,
  INK_DELTA,
  inkRatioOf,
  isBlank,
  MARGIN_RATIO,
  type GrayImage,
} from './blank';

// Чистая часть детектора (план M4, U2): доля чернильных пикселей по готовым серым пикселям и
// вердикт по порогу. Декодирование и уменьшение через `sharp` — `test/integration`.

/** Серое изображение `width × height`, залитое `fill`, с тёмным прямоугольником `box`. */
function image(
  width: number,
  height: number,
  fill: number,
  box: { x: number; y: number; w: number; h: number; level: number } | null = null,
): GrayImage {
  const data = new Uint8Array(width * height).fill(fill);
  if (box !== null) {
    for (let y = box.y; y < box.y + box.h; y += 1) {
      for (let x = box.x; x < box.x + box.w; x += 1) {
        data[y * width + x] = box.level;
      }
    }
  }
  return { data, width, height };
}

describe('детектор пустых страниц: доля чернильных пикселей', () => {
  it('чистый лист — ноль; серая бумага тоже чистая: белое оценивается по самой странице', () => {
    expect(inkRatioOf(image(100, 100, 255))).toBe(0);
    expect(inkRatioOf(image(100, 100, 180))).toBe(0);
  });

  it('тёмный блок внутри полей считается долей от обрезанной области', () => {
    // Поля 4 % с каждой стороны: обрезанная область 92 × 92 = 8464 пикселя; блок 10 × 10 = 100.
    const ratio = inkRatioOf(image(100, 100, 255, { x: 40, y: 40, w: 10, h: 10, level: 0 }));

    expect(ratio).toBeCloseTo(100 / 8464, 6);
  });

  it('тень по кромке листа в полях не считается', () => {
    const margin = Math.round(100 * MARGIN_RATIO);

    expect(inkRatioOf(image(100, 100, 255, { x: 0, y: 0, w: margin, h: 100, level: 0 }))).toBe(0);
  });

  it('просвечивание светлее дельты — не чернила; штрих темнее дельты — чернила', () => {
    const faint = image(100, 100, 255, { x: 10, y: 10, w: 10, h: 10, level: 255 - INK_DELTA + 1 });
    const ink = image(100, 100, 255, { x: 10, y: 10, w: 10, h: 10, level: 255 - INK_DELTA - 1 });

    expect(inkRatioOf(faint)).toBe(0);
    expect(inkRatioOf(ink)).toBeGreaterThan(0);
  });

  it('вырожденная область — ноль, без деления на ноль', () => {
    expect(inkRatioOf(image(1, 1, 255))).toBe(0);
    expect(inkRatioOf({ data: new Uint8Array(0), width: 0, height: 0 })).toBe(0);
  });
});

describe('детектор пустых страниц: вердикт', () => {
  it('ниже порога — пусто, на пороге и выше — нет; `null` — не пусто', () => {
    expect(isBlank(0)).toBe(true);
    expect(isBlank(BLANK_THRESHOLD / 2)).toBe(true);
    expect(isBlank(BLANK_THRESHOLD)).toBe(false);
    expect(isBlank(BLANK_THRESHOLD * 2)).toBe(false);
    expect(isBlank(null)).toBe(false);
  });

  it('версия алгоритма — целое от единицы: кэш с другой версией пересчитывается', () => {
    expect(Number.isInteger(BLANK_DETECTOR_VERSION)).toBe(true);
    expect(BLANK_DETECTOR_VERSION).toBeGreaterThanOrEqual(1);
  });
});
