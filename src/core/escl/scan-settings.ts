import { z } from 'zod';
import {
  COLOR_MODES,
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

/** Одна схема на журнал, настройки и вход команды моста: строгая, без приведения типов. */
export const scanParamsSchema = z.strictObject({
  colorMode: z.enum(COLOR_MODES),
  resolution: z.number().int().min(1).max(9600),
  paperSize: z.enum(PAPER_SIZES),
}) satisfies z.ZodType<ScanParams>;

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

/** Первый параметр, которого нет среди вариантов устройства; `null` — все поддержаны. */
export function unsupportedField(
  params: ScanParams,
  options: ScanOptions,
): 'colorMode' | 'resolution' | 'paperSize' | null {
  if (!options.colorModes.includes(params.colorMode)) {
    return 'colorMode';
  }
  if (!options.resolutions.includes(params.resolution)) {
    return 'resolution';
  }
  return options.paperSizes.includes(params.paperSize) ? null : 'paperSize';
}

// Параметры по умолчанию и правило KTD-13 переехали в `@shared/scan-params` (U22): ими пользуется
// и «Сбросить параметры» в интерфейсе. Реэкспорт — чтобы клиент сканера брал их по-прежнему здесь.
export { DEFAULT_SCAN_PARAMS, resolveScanParams } from '@shared';

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
