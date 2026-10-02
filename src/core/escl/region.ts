import { fail, ok, type Result } from '@shared';
import type { InputCaps } from './capabilities';

// Регион сканирования — ВСЕГДА в 1/300 дюйма, независимо от выбранного разрешения
// (docs/duplexnt-tech.md). Это единственное место, где размер листа переводится в единицы
// протокола; параметра разрешения у функции нет намеренно.

export const REGION_UNITS_PER_INCH = 300;
const MM_PER_INCH = 25.4;

export const PAPER_SIZES = ['A4', 'Letter'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export interface ScanRegion {
  readonly xOffset: number;
  readonly yOffset: number;
  readonly width: number;
  readonly height: number;
}

// Доли единицы отбрасываются: регион не должен выйти за лист. A4 — 2480,31 × 3507,87 единицы,
// в запрос идёт 2480 × 3507; ET-3850 отдаёт страницу ровно этого размера (журнал M1, U1).
const fromMm = (mm: number): number => Math.floor((mm * REGION_UNITS_PER_INCH) / MM_PER_INCH);
const fromInches = (inches: number): number => Math.floor(inches * REGION_UNITS_PER_INCH);

function sheetOf(paper: PaperSize): { readonly width: number; readonly height: number } {
  switch (paper) {
    case 'A4':
      return { width: fromMm(210), height: fromMm(297) };
    case 'Letter':
      return { width: fromInches(8.5), height: fromInches(11) };
  }
}

/**
 * Регион листа в поле автоподачи. Лист, который не помещается в пределы устройства, отклоняется:
 * ET-3850 слишком широкий регион принимает молча, проверка — на нашей стороне.
 *
 * По горизонтали лист ставится по центру поля. Заявленная устройством юстировка в расчёт не
 * идёт: ET-3850 заявляет «вправо», а лист кладёт по центру (журнал M1, U1). По вертикали — от
 * начала поля: лист подаётся верхним краем.
 */
export function regionFor(paper: PaperSize, adf: InputCaps): Result<ScanRegion> {
  const { width, height } = sheetOf(paper);
  const fits =
    width >= adf.minWidth &&
    width <= adf.maxWidth &&
    height >= adf.minHeight &&
    height <= adf.maxHeight;
  if (!fits) {
    return fail('scanParamsUnsupported', { field: 'paperSize' });
  }
  return ok({ xOffset: Math.floor((adf.maxWidth - width) / 2), yOffset: 0, width, height });
}
