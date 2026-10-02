import {
  fail,
  ok,
  PAPER_SIZES,
  type ColorMode,
  type Result,
  type ScanOptions,
  type ScanParams,
} from '@shared';
import type { ScannerCapabilities } from './capabilities';
import { regionFor } from './region';
import { NS_PWG, NS_SCAN } from './xml';

// Параметры сканирования: что предложить пользователю и как собрать запрос задания (ADR 0006).
// Запрос собирается шаблоном; каждое значение перед подстановкой сверяется с вариантами,
// выведенными из capabilities, — одним и тем же списком пользуются интерфейс и проверка.
// Типы параметров и вариантов — в `@shared`: они идут в снимок интерфейса.

// Capabilities — необходимый вход, но не истина: ET-3850 перечисляет `BlackAndWhite1` и отвечает
// `409` на задание с ним и JPEG (журнал M1, U1). Страницы приложение берёт только в JPEG,
// поэтому режим не предлагается ни одному устройству.
const JPEG_INCOMPATIBLE: readonly ColorMode[] = ['BlackAndWhite1'];

/** Варианты параметров для интерфейса — из capabilities устройства, не из хардкода. */
export function scanOptionsOf(capabilities: ScannerCapabilities): ScanOptions {
  const { adf } = capabilities;
  return {
    colorModes: adf.colorModes.filter((mode) => !JPEG_INCOMPATIBLE.includes(mode)),
    resolutions: adf.resolutions,
    paperSizes: PAPER_SIZES.filter((paper) => regionFor(paper, adf).ok),
  };
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
 * от значений по умолчанию.
 */
export function resolveScanParams(remembered: ScanParams | null, options: ScanOptions): ScanParams {
  const fallback = DEFAULT_SCAN_PARAMS;
  return {
    colorMode: pick(remembered?.colorMode, fallback.colorMode, options.colorModes),
    resolution: pick(remembered?.resolution, fallback.resolution, options.resolutions),
    paperSize: pick(remembered?.paperSize, fallback.paperSize, options.paperSizes),
  };
}

// Версию протокола клиент повторяет за устройством; значение — данные устройства и в запрос идёт
// только в виде «число.число». Проверено на ET-3850 (2.9); остальное — запасной ход.
const VERSION = /^\d{1,2}\.\d{1,2}$/;
const FALLBACK_VERSION = '2.0';

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};
const escapeXml = (value: string | number): string =>
  String(value).replace(/[&<>"']/g, (char) => ESCAPES[char] ?? '');

/**
 * Тело `POST /ScanJobs` для односторонней автоподачи. Порядок и набор элементов — те, на которые
 * ET-3850 ответил `201` (фикстура `ScanSettings.a4-gray-300.xml`); элемента `Intent` нет.
 */
export function buildScanSettings(
  params: ScanParams,
  capabilities: ScannerCapabilities,
): Result<string> {
  const options = scanOptionsOf(capabilities);
  if (!options.colorModes.includes(params.colorMode)) {
    return fail('scanParamsUnsupported', { field: 'colorMode' });
  }
  if (!options.resolutions.includes(params.resolution)) {
    return fail('scanParamsUnsupported', { field: 'resolution' });
  }
  const region = regionFor(params.paperSize, capabilities.adf);
  if (!region.ok) {
    return region;
  }

  const version =
    capabilities.version !== null && VERSION.test(capabilities.version)
      ? capabilities.version
      : FALLBACK_VERSION;
  const { xOffset, yOffset, width, height } = region.value;
  const e = escapeXml;

  return ok(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      `<scan:ScanSettings xmlns:scan="${NS_SCAN}" xmlns:pwg="${NS_PWG}">` +
      `<pwg:Version>${e(version)}</pwg:Version>` +
      '<pwg:ScanRegions><pwg:ScanRegion>' +
      '<pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>' +
      `<pwg:XOffset>${e(xOffset)}</pwg:XOffset>` +
      `<pwg:YOffset>${e(yOffset)}</pwg:YOffset>` +
      `<pwg:Width>${e(width)}</pwg:Width>` +
      `<pwg:Height>${e(height)}</pwg:Height>` +
      '</pwg:ScanRegion></pwg:ScanRegions>' +
      '<pwg:InputSource>Feeder</pwg:InputSource>' +
      `<scan:ColorMode>${e(params.colorMode)}</scan:ColorMode>` +
      '<pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>' +
      '<scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>' +
      `<scan:XResolution>${e(params.resolution)}</scan:XResolution>` +
      `<scan:YResolution>${e(params.resolution)}</scan:YResolution>` +
      '</scan:ScanSettings>',
  );
}
