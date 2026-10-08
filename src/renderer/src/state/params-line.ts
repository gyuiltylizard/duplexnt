import type { ScanParams } from '@shared';
import type { TFunction } from 'i18next';
import { lowerFirst } from './error-text';

/** Строка параметров прохода: «300 dpi · оттенки серого · A4» — экран `scan` и модалка `add`. */
export function paramsLine(t: TFunction, params: ScanParams): string {
  return t('scan.params', {
    resolution: params.resolution,
    color: lowerFirst(t(`setup.params.colorMode.${params.colorMode}`)),
    size: params.paperSize,
  });
}
