import { describe, expect, it } from 'vitest';
import { ET_3850, readFixture } from '../../../test/support/fixtures';
import { parseCapabilities, type InputCaps } from './capabilities';
import { PAPER_SIZES, regionFor, type ScanRegion } from './region';

function et3850Adf(): InputCaps {
  const result = parseCapabilities(readFixture(...ET_3850, 'ScannerCapabilities.xml'));
  if (!result.ok) {
    throw new Error('фикстура capabilities не разобрана');
  }
  return result.value.adf;
}

const ADF = et3850Adf();
const withLimits = (limits: Partial<InputCaps>): InputCaps => ({ ...ADF, ...limits });

function region(paper: (typeof PAPER_SIZES)[number], adf = ADF): ScanRegion {
  const result = regionFor(paper, adf);
  if (!result.ok) {
    throw new Error(`регион отклонён: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

describe('regionFor: размер листа в 1/300 дюйма', () => {
  it('A4 даёт 2480 × 3507', () => {
    expect(region('A4')).toMatchObject({ width: 2480, height: 3507 });
  });

  it('Letter даёт 2550 × 3300', () => {
    expect(region('Letter')).toMatchObject({ width: 2550, height: 3300 });
  });

  it('регион не шире и не длиннее листа: доли единицы отбрасываются, а не округляются вверх', () => {
    // A4 — 210 × 297 мм, то есть 2480,31 × 3507,87 единицы.
    const a4 = region('A4');

    expect(a4.width).toBeLessThanOrEqual((210 / 25.4) * 300);
    expect(a4.height).toBeLessThanOrEqual((297 / 25.4) * 300);
    expect(a4.height).toBe(3507);
  });

  it('у функции нет параметра разрешения: регион от DPI не зависит', () => {
    expect(regionFor).toHaveLength(2);
  });
});

describe('regionFor: положение в поле автоподачи', () => {
  it('лист ставится по центру поля: A4 — смещение 35, Letter — 0 (журнал M1, U1)', () => {
    expect(region('A4')).toEqual({ xOffset: 35, yOffset: 0, width: 2480, height: 3507 });
    expect(region('Letter')).toEqual({ xOffset: 0, yOffset: 0, width: 2550, height: 3300 });
  });

  it('смещение считается от ширины поля устройства, а не зашито', () => {
    expect(region('A4', withLimits({ maxWidth: 2600 })).xOffset).toBe(60);
    expect(region('A4', withLimits({ maxWidth: 2480 })).xOffset).toBe(0);
  });

  it('нечётный остаток ширины не выводит регион за поле', () => {
    const narrow = withLimits({ maxWidth: 2485 });
    const { xOffset, width } = region('A4', narrow);

    expect(xOffset).toBe(2);
    expect(xOffset + width).toBeLessThanOrEqual(narrow.maxWidth);
  });

  it('регион целиком лежит в поле при любых пределах, которые его принимают', () => {
    for (const maxWidth of [2480, 2481, 2550, 3000]) {
      for (const paper of PAPER_SIZES) {
        const result = regionFor(paper, withLimits({ maxWidth }));
        if (result.ok) {
          expect(result.value.xOffset).toBeGreaterThanOrEqual(0);
          expect(result.value.xOffset + result.value.width).toBeLessThanOrEqual(maxWidth);
        }
      }
    }
  });
});

describe('regionFor: пределы автоподачи', () => {
  const rejected = {
    ok: false,
    error: { code: 'scanParamsUnsupported', details: { field: 'paperSize' } },
  };

  it('лист шире предела автоподачи отклоняется, а не обрезается молча', () => {
    expect(regionFor('Letter', withLimits({ maxWidth: 2549 }))).toEqual(rejected);
    expect(regionFor('A4', withLimits({ maxWidth: 2479 }))).toEqual(rejected);
  });

  it('лист длиннее предела отклоняется', () => {
    expect(regionFor('A4', withLimits({ maxHeight: 3506 }))).toEqual(rejected);
    expect(regionFor('A4', withLimits({ maxHeight: 3507 })).ok).toBe(true);
  });

  it('лист меньше наименьшего региона устройства отклоняется', () => {
    expect(regionFor('A4', withLimits({ minWidth: 2481 }))).toEqual(rejected);
    expect(regionFor('A4', withLimits({ minHeight: 3508 }))).toEqual(rejected);
  });

  it('лист ровно в пределах принимается', () => {
    const exact = withLimits({ minWidth: 2550, maxWidth: 2550, minHeight: 3300, maxHeight: 3300 });

    expect(region('Letter', exact)).toEqual({ xOffset: 0, yOffset: 0, width: 2550, height: 3300 });
  });
});
