import { describe, expect, it } from 'vitest';
import { ET_3850, readFixture, readFixtureText } from '../../../test/support/fixtures';
import { parseCapabilities, type ScannerCapabilities } from './capabilities';
import {
  buildScanSettings,
  DEFAULT_SCAN_PARAMS,
  resolveScanParams,
  scanOptionsOf,
  type ScanParams,
} from './scan-settings';
import { descendantOf, NS_PWG, NS_SCAN, parseXml, textOf, uintOf, type XmlElement } from './xml';

function et3850(): ScannerCapabilities {
  const result = parseCapabilities(readFixture(...ET_3850, 'ScannerCapabilities.xml'));
  if (!result.ok) {
    throw new Error('фикстура capabilities не разобрана');
  }
  return result.value;
}

const CAPS = et3850();
const withAdf = (adf: Partial<ScannerCapabilities['adf']>): ScannerCapabilities => ({
  ...CAPS,
  adf: { ...CAPS.adf, ...adf },
});

const A4_GRAY_300: ScanParams = { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' };

function built(params: ScanParams, capabilities = CAPS): string {
  const result = buildScanSettings(params, capabilities);
  if (!result.ok) {
    throw new Error(`запрос отклонён: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function treeOf(xml: string): XmlElement {
  const result = parseXml(new TextEncoder().encode(xml));
  if (!result.ok) {
    throw new Error(`запрос не разобран: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function regionOf(xml: string): Record<string, number | null> {
  const region = descendantOf(treeOf(xml), NS_PWG, 'ScanRegions', 'ScanRegion');
  if (region === null) {
    throw new Error('в запросе нет региона');
  }
  return {
    xOffset: uintOf(region, NS_PWG, 'XOffset'),
    yOffset: uintOf(region, NS_PWG, 'YOffset'),
    width: uintOf(region, NS_PWG, 'Width'),
    height: uintOf(region, NS_PWG, 'Height'),
  };
}

const rejected = (field: string) => ({
  ok: false,
  error: { code: 'scanParamsUnsupported', details: { field } },
});

describe('scanOptionsOf: варианты для интерфейса из capabilities', () => {
  it('ET-3850: серый и цвет, четыре разрешения, A4 и Letter', () => {
    expect(scanOptionsOf(CAPS)).toEqual({
      colorModes: ['Grayscale8', 'RGB24'],
      resolutions: [100, 200, 300, 600],
      paperSizes: ['A4', 'Letter'],
    });
  });

  it('чёрно-белый режим не предлагается, хотя устройство его заявляет', () => {
    expect(CAPS.adf.colorModes).toContain('BlackAndWhite1');
    expect(scanOptionsOf(CAPS).colorModes).not.toContain('BlackAndWhite1');
  });

  it('лист, который не помещается в поле автоподачи, не предлагается', () => {
    expect(scanOptionsOf(withAdf({ maxWidth: 2500 })).paperSizes).toEqual(['A4']);
    expect(scanOptionsOf(withAdf({ maxHeight: 3400 })).paperSizes).toEqual(['Letter']);
    expect(scanOptionsOf(withAdf({ maxWidth: 2000 })).paperSizes).toEqual([]);
  });

  it('варианты повторяют устройство, а не хардкод', () => {
    const other = withAdf({ colorModes: ['RGB24'], resolutions: [150, 400] });

    expect(scanOptionsOf(other)).toMatchObject({ colorModes: ['RGB24'], resolutions: [150, 400] });
  });
});

describe('resolveScanParams: запомненные параметры против устройства (KTD-13)', () => {
  const options = scanOptionsOf(CAPS);

  it('без запомненных — значения по умолчанию: серый, 300 dpi, A4', () => {
    expect(resolveScanParams(null, options)).toEqual(DEFAULT_SCAN_PARAMS);
    expect(DEFAULT_SCAN_PARAMS).toEqual(A4_GRAY_300);
  });

  it('запомненное, которое у устройства есть, остаётся', () => {
    const remembered: ScanParams = { colorMode: 'RGB24', resolution: 600, paperSize: 'Letter' };

    expect(resolveScanParams(remembered, options)).toEqual(remembered);
  });

  it('запомненное разрешение, которого нет у устройства, заменяется значением по умолчанию', () => {
    const remembered: ScanParams = { colorMode: 'RGB24', resolution: 1200, paperSize: 'A4' };

    expect(resolveScanParams(remembered, options)).toEqual({ ...remembered, resolution: 300 });
  });

  it('нет у устройства и значения по умолчанию — берётся первое доступное', () => {
    const narrow = scanOptionsOf(
      withAdf({ colorModes: ['RGB24'], resolutions: [150, 600], maxHeight: 3400 }),
    );

    expect(resolveScanParams({ ...A4_GRAY_300, resolution: 1200 }, narrow)).toEqual({
      colorMode: 'RGB24',
      resolution: 150,
      paperSize: 'Letter',
    });
  });

  it('значение, пришедшее мимо типов, заменяется', () => {
    const garbage = { colorMode: 'BlackAndWhite1', resolution: '300', paperSize: 'A3' };

    expect(resolveScanParams(garbage as unknown as ScanParams, options)).toEqual(A4_GRAY_300);
  });
});

describe('buildScanSettings: запрос задания', () => {
  it('для параметров фикстуры даёт запрос, принятый устройством, — байт в байт', () => {
    expect(built(A4_GRAY_300)).toBe(readFixtureText(...ET_3850, 'ScanSettings.a4-gray-300.xml'));
  });

  it('собранный XML разбирается сборщиком дерева и несёт автоподачу и JPEG', () => {
    const root = treeOf(built({ colorMode: 'RGB24', resolution: 600, paperSize: 'Letter' }));

    expect(root).toMatchObject({ ns: NS_SCAN, name: 'ScanSettings' });
    expect(textOf(root, NS_PWG, 'InputSource')).toBe('Feeder');
    expect(textOf(root, NS_PWG, 'DocumentFormat')).toBe('image/jpeg');
    expect(textOf(root, NS_SCAN, 'DocumentFormatExt')).toBe('image/jpeg');
    expect(textOf(root, NS_SCAN, 'ColorMode')).toBe('RGB24');
    expect(uintOf(root, NS_SCAN, 'XResolution')).toBe(600);
    expect(uintOf(root, NS_SCAN, 'YResolution')).toBe(600);
    expect(textOf(root, NS_PWG, 'Version')).toBe('2.9');
    expect(
      textOf(
        descendantOf(root, NS_PWG, 'ScanRegions', 'ScanRegion') ?? root,
        NS_PWG,
        'ContentRegionUnits',
      ),
    ).toBe('escl:ThreeHundredthsOfInches');
  });

  it('A4 даёт 2480 × 3507 при 200, 300 и 600 dpi: регион от разрешения не зависит', () => {
    for (const resolution of [100, 200, 300, 600]) {
      expect(regionOf(built({ ...A4_GRAY_300, resolution })), String(resolution)).toEqual({
        xOffset: 35,
        yOffset: 0,
        width: 2480,
        height: 3507,
      });
    }
  });

  it('Letter даёт 2550 × 3300 от левого края поля', () => {
    expect(regionOf(built({ ...A4_GRAY_300, paperSize: 'Letter' }))).toEqual({
      xOffset: 0,
      yOffset: 0,
      width: 2550,
      height: 3300,
    });
  });

  it('элемента Intent в запросе нет', () => {
    expect(built(A4_GRAY_300)).not.toContain('Intent');
  });
});

describe('buildScanSettings: сверка с capabilities', () => {
  it('разрешение, которого нет у автоподачи, отклоняется', () => {
    // 1200 dpi есть у планшета ET-3850, но не у автоподачи: устройство отвечает на него `409`.
    expect(buildScanSettings({ ...A4_GRAY_300, resolution: 1200 }, CAPS)).toEqual(
      rejected('resolution'),
    );
    expect(buildScanSettings({ ...A4_GRAY_300, resolution: 150 }, CAPS)).toEqual(
      rejected('resolution'),
    );
  });

  it('режим, которого нет в capabilities, отклоняется', () => {
    const grayOnly = withAdf({ colorModes: ['Grayscale8'] });

    expect(buildScanSettings({ ...A4_GRAY_300, colorMode: 'RGB24' }, grayOnly)).toEqual(
      rejected('colorMode'),
    );
  });

  it('чёрно-белый режим отклоняется, хотя устройство его заявляет', () => {
    expect(buildScanSettings({ ...A4_GRAY_300, colorMode: 'BlackAndWhite1' }, CAPS)).toEqual(
      rejected('colorMode'),
    );
  });

  it('лист шире предела автоподачи отклоняется, а не обрезается молча', () => {
    expect(
      buildScanSettings({ ...A4_GRAY_300, paperSize: 'Letter' }, withAdf({ maxWidth: 2500 })),
    ).toEqual(rejected('paperSize'));
  });

  it('значения, пришедшие мимо типов, в запрос не попадают', () => {
    const forged = {
      colorMode: 'Grayscale8</scan:ColorMode><x>',
      resolution: Number.NaN,
      paperSize: 'A4',
    } as unknown as ScanParams;

    expect(buildScanSettings(forged, CAPS)).toEqual(rejected('colorMode'));
    expect(buildScanSettings({ ...A4_GRAY_300, resolution: Number.NaN }, CAPS)).toEqual(
      rejected('resolution'),
    );
  });
});

describe('buildScanSettings: версия протокола', () => {
  it('повторяет версию устройства', () => {
    const xml = built(A4_GRAY_300, { ...CAPS, version: '2.63' });

    expect(textOf(treeOf(xml), NS_PWG, 'Version')).toBe('2.63');
  });

  it.each([null, '', '2.9<x/>', 'latest', '2', '2.9.1'])(
    'версия не вида «число.число» в запрос не идёт: %s',
    (version) => {
      const xml = built(A4_GRAY_300, { ...CAPS, version });

      expect(textOf(treeOf(xml), NS_PWG, 'Version')).toBe('2.0');
    },
  );
});
