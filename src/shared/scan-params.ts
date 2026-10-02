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
