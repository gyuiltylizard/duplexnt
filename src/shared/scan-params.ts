// Параметры сканирования — то, что интерфейс показывает и выбирает, а ядро сверяет с
// capabilities устройства (план M1, R4, KTD-13). Перечисления здесь — словарь протокола eSCL;
// какие из значений предложить, решает ядро по capabilities, а не этот список.

export const COLOR_MODES = ['BlackAndWhite1', 'Grayscale8', 'RGB24'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export const PAPER_SIZES = ['A4', 'Letter'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export interface ScanParams {
  readonly colorMode: ColorMode;
  readonly resolution: number;
  readonly paperSize: PaperSize;
}

/** Варианты параметров, выведенные из capabilities устройства. */
export interface ScanOptions {
  readonly colorModes: readonly ColorMode[];
  readonly resolutions: readonly number[];
  readonly paperSizes: readonly PaperSize[];
}

/** Параметры по умолчанию (план M1, KTD-13): оттенки серого, 300 dpi, A4. */
export const DEFAULT_SCAN_PARAMS: ScanParams = {
  colorMode: 'Grayscale8',
  resolution: 300,
  paperSize: 'A4',
};

const pick = <T>(remembered: T | undefined, fallback: T, available: readonly T[]): T =>
  remembered !== undefined && available.includes(remembered)
    ? remembered
    : available.includes(fallback)
      ? fallback
      : (available[0] ?? fallback);

/**
 * Параметры для устройства (KTD-13): запомненный параметр, которого у устройства нет, заменяется
 * значением по умолчанию, а если нет и его — первым доступным. Без запомненных — то же правило
 * от значений по умолчанию. Правило одно на ядро и интерфейс: им же «Сбросить параметры»
 * считает дефолты против вариантов устройства.
 */
export function resolveScanParams(remembered: ScanParams | null, options: ScanOptions): ScanParams {
  const fallback = DEFAULT_SCAN_PARAMS;
  return {
    colorMode: pick(remembered?.colorMode, fallback.colorMode, options.colorModes),
    resolution: pick(remembered?.resolution, fallback.resolution, options.resolutions),
    paperSize: pick(remembered?.paperSize, fallback.paperSize, options.paperSizes),
  };
}
