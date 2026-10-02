import { COLOR_MODES, fail, ok, type ColorMode, type Result } from '@shared';
import {
  badResponse,
  childOf,
  childrenOf,
  descendantOf,
  displayText,
  isElement,
  NS_PWG,
  NS_SCAN,
  parseXml,
  textOf,
  uintOf,
  type XmlElement,
} from './xml';

// Разбор `ScannerCapabilities` в типизированную структуру (ADR 0006). Каждое значение проверяется:
// неизвестный цветовой режим или формат пропускается, а не попадает в интерфейс строкой.
//
// Capabilities — необходимый вход, но не истина (журнал M1, U1): ET-3850 перечисляет
// `BlackAndWhite1` и отклоняет его с JPEG, заявляет юстировку вправо и кладёт лист по центру.
// Здесь — то, что устройство заявило; что из этого предлагать пользователю, решает
// ./scan-settings.ts.

export const DOCUMENT_FORMATS = ['image/jpeg', 'application/pdf'] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export interface InputCaps {
  /** Пределы региона в 1/300 дюйма. */
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly colorModes: readonly ColorMode[];
  readonly documentFormats: readonly DocumentFormat[];
  /** Разрешения, одинаковые по обеим осям, по возрастанию. */
  readonly resolutions: readonly number[];
}

export interface ScannerCapabilities {
  readonly version: string | null;
  readonly makeAndModel: string | null;
  readonly serialNumber: string | null;
  readonly uuid: string | null;
  readonly hasPlaten: boolean;
  readonly hasAdfDuplex: boolean;
  /** Односторонняя автоподача — единственный источник, с которым работает приложение. */
  readonly adf: InputCaps;
}

// Регион измеряется в 1/300 дюйма; 30 000 — это 2,5 метра. Больше — мусор, а не сканер.
const MAX_SANE_EXTENT = 30_000;
const MAX_SANE_RESOLUTION = 9600;

// Значения для диапазона разрешений: устройство с `ResolutionRange` вместо списка примет любое
// число из диапазона, но предлагать пользователю 137 dpi незачем.
const COMMON_RESOLUTIONS = [75, 100, 150, 200, 300, 400, 600, 1200, 2400];

function discreteResolutions(supported: XmlElement): number[] {
  const list = childOf(supported, NS_SCAN, 'DiscreteResolutions');
  if (list === null) {
    return [];
  }
  return childrenOf(list, NS_SCAN, 'DiscreteResolution').flatMap((entry) => {
    const x = uintOf(entry, NS_SCAN, 'XResolution');
    const y = uintOf(entry, NS_SCAN, 'YResolution');
    return x !== null && x === y ? [x] : [];
  });
}

interface Range {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

function rangeOf(element: XmlElement | null): Range | null {
  if (element === null) {
    return null;
  }
  const min = uintOf(element, NS_SCAN, 'Min');
  const max = uintOf(element, NS_SCAN, 'Max');
  if (min === null || max === null || min > max) {
    return null;
  }
  return { min, max, step: Math.max(uintOf(element, NS_SCAN, 'Step') ?? 1, 1) };
}

const inRange = (range: Range, value: number): boolean =>
  value >= range.min && value <= range.max && (value - range.min) % range.step === 0;

function rangeResolutions(supported: XmlElement): number[] {
  const x = rangeOf(descendantOf(supported, NS_SCAN, 'ResolutionRange', 'XResolutionRange'));
  const y = rangeOf(descendantOf(supported, NS_SCAN, 'ResolutionRange', 'YResolutionRange'));
  if (x === null || y === null) {
    return [];
  }
  return COMMON_RESOLUTIONS.filter((value) => inRange(x, value) && inRange(y, value));
}

function resolutionsOf(profile: XmlElement): number[] {
  const supported = childOf(profile, NS_SCAN, 'SupportedResolutions');
  if (supported === null) {
    return [];
  }
  const values = [...discreteResolutions(supported), ...rangeResolutions(supported)].filter(
    (value) => value > 0 && value <= MAX_SANE_RESOLUTION,
  );
  return [...new Set(values)].sort((a, b) => a - b);
}

function colorModesOf(profile: XmlElement): ColorMode[] {
  const list = childOf(profile, NS_SCAN, 'ColorModes');
  const found = (list === null ? [] : childrenOf(list, NS_SCAN, 'ColorMode')).map((it) => it.text);
  return COLOR_MODES.filter((mode) => found.includes(mode));
}

function documentFormatsOf(profile: XmlElement): DocumentFormat[] {
  const list = childOf(profile, NS_SCAN, 'DocumentFormats');
  if (list === null) {
    return [];
  }
  // Формат объявляется двумя элементами — старым `pwg:DocumentFormat` и новым
  // `scan:DocumentFormatExt`; устройству достаточно назвать его в одном.
  const found = list.children
    .filter(
      (it) =>
        isElement(it, NS_PWG, 'DocumentFormat') || isElement(it, NS_SCAN, 'DocumentFormatExt'),
    )
    .map((it) => it.text.toLowerCase());
  return DOCUMENT_FORMATS.filter((format) => found.includes(format));
}

interface Profile {
  readonly colorModes: ColorMode[];
  readonly documentFormats: DocumentFormat[];
  readonly resolutions: number[];
}

const hasJpeg = (profile: Profile): boolean => profile.documentFormats.includes('image/jpeg');

// Профилей может быть несколько, и значения разных профилей между собой не сочетаются. Берётся
// первый, с которым можно работать: JPEG, хотя бы один режим и одно разрешение.
function profilesOf(inputCaps: XmlElement): Profile[] {
  const list = childOf(inputCaps, NS_SCAN, 'SettingProfiles');
  return (list === null ? [] : childrenOf(list, NS_SCAN, 'SettingProfile')).map((profile) => ({
    colorModes: colorModesOf(profile),
    documentFormats: documentFormatsOf(profile),
    resolutions: resolutionsOf(profile),
  }));
}

function extentOf(inputCaps: XmlElement, name: string): number | null {
  const value = uintOf(inputCaps, NS_SCAN, name);
  return value !== null && value > 0 && value <= MAX_SANE_EXTENT ? value : null;
}

export function parseCapabilities(bytes: Uint8Array): Result<ScannerCapabilities> {
  const parsed = parseXml(bytes);
  if (!parsed.ok) {
    return parsed;
  }
  const root = parsed.value;
  if (!isElement(root, NS_SCAN, 'ScannerCapabilities')) {
    return fail('notEsclScanner');
  }

  const adfCaps = descendantOf(root, NS_SCAN, 'Adf', 'AdfSimplexInputCaps');
  if (adfCaps === null) {
    return fail('scannerNoAdf');
  }

  const maxWidth = extentOf(adfCaps, 'MaxWidth');
  const maxHeight = extentOf(adfCaps, 'MaxHeight');
  if (maxWidth === null || maxHeight === null) {
    return badResponse('adfRegion');
  }

  const jpegProfiles = profilesOf(adfCaps).filter(hasJpeg);
  if (jpegProfiles.length === 0) {
    return fail('scannerNoJpeg');
  }
  const profile = jpegProfiles.find((it) => it.colorModes.length > 0 && it.resolutions.length > 0);
  if (profile === undefined) {
    return badResponse('adfProfile');
  }

  return ok({
    version: displayText(textOf(root, NS_PWG, 'Version')),
    makeAndModel: displayText(textOf(root, NS_PWG, 'MakeAndModel')),
    serialNumber: displayText(textOf(root, NS_PWG, 'SerialNumber')),
    uuid: displayText(textOf(root, NS_SCAN, 'UUID')),
    hasPlaten: descendantOf(root, NS_SCAN, 'Platen', 'PlatenInputCaps') !== null,
    hasAdfDuplex: descendantOf(root, NS_SCAN, 'Adf', 'AdfDuplexInputCaps') !== null,
    adf: {
      minWidth: Math.min(extentOf(adfCaps, 'MinWidth') ?? 1, maxWidth),
      maxWidth,
      minHeight: Math.min(extentOf(adfCaps, 'MinHeight') ?? 1, maxHeight),
      maxHeight,
      ...profile,
    },
  });
}
