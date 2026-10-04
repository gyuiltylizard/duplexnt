import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_SERIAL, PLACEHOLDER_UUID } from '../../../scripts/privacy-guard';
import { ET_3850, readFixture, readFixtureText } from '../../../test/support/fixtures';
import { parseCapabilities, type ScannerCapabilities } from './capabilities';

const ET_3850_XML = readFixtureText(...ET_3850, 'ScannerCapabilities.xml');
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function parsed(xml: string): ScannerCapabilities {
  const result = parseCapabilities(encode(xml));
  if (!result.ok) {
    throw new Error(`не разобрано: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

const failureOf = (xml: string): unknown => {
  const result = parseCapabilities(encode(xml));
  return result.ok ? 'ok' : result.error;
};

// Замена обязана сработать: иначе тест молча проверит исходный документ.
function replaced(xml: string, from: string | RegExp, to: string): string {
  const result = xml.replace(from, to);
  if (result === xml) {
    throw new Error(`замена не сработала: ${String(from)}`);
  }
  return result;
}

const ADF = /<scan:AdfSimplexInputCaps>.*<\/scan:AdfSimplexInputCaps>/s;
const adfOf = (xml: string): string => ADF.exec(xml)?.[0] ?? '';
const inAdf = (edit: (adf: string) => string): string =>
  replaced(ET_3850_XML, ADF, edit(adfOf(ET_3850_XML)));

describe('parseCapabilities: ET-3850', () => {
  const caps = parsed(ET_3850_XML);

  it('автоподача без дуплекса, планшет есть', () => {
    expect(caps.hasAdfDuplex).toBe(false);
    expect(caps.hasPlaten).toBe(true);
  });

  it('идентичность устройства', () => {
    expect(caps).toMatchObject({
      version: '2.9',
      makeAndModel: 'EPSON ET-3850 Series',
      serialNumber: PLACEHOLDER_SERIAL,
      uuid: PLACEHOLDER_UUID,
    });
  });

  it('автоподача: разрешения 100–600, три цветовых режима, JPEG среди форматов', () => {
    expect(caps.adf.resolutions).toEqual([100, 200, 300, 600]);
    expect(caps.adf.colorModes).toEqual(['BlackAndWhite1', 'Grayscale8', 'RGB24']);
    expect(caps.adf.documentFormats).toContain('image/jpeg');
  });

  it('пределы региона — автоподачи, а не планшета', () => {
    expect(caps.adf).toMatchObject({
      minWidth: 96,
      maxWidth: 2550,
      minHeight: 96,
      maxHeight: 4200,
    });
  });

  it('разрешение 1200 планшета в автоподачу не попадает', () => {
    expect(ET_3850_XML).toContain('<scan:XResolution>1200</scan:XResolution>');
    expect(caps.adf.resolutions).not.toContain(1200);
  });
});

describe('parseCapabilities: чужая прошивка', () => {
  it('тот же документ с другими префиксами пространств имён разбирается так же', () => {
    const renamed = ET_3850_XML.replaceAll('scan:', 'e:')
      .replaceAll('pwg:', 'p:')
      .replaceAll('xmlns:e:', 'xmlns:scan:')
      .replace('xmlns:scan=', 'xmlns:e=')
      .replace('xmlns:pwg=', 'xmlns:p=');

    expect(renamed).toContain('<e:ScannerCapabilities xmlns:e=');
    expect(renamed).not.toContain('<scan:');
    expect(parsed(renamed)).toEqual(parsed(ET_3850_XML));
  });

  it('диапазон разрешений вместо списка даёт пригодный набор значений', () => {
    const ranged = inAdf((adf) =>
      replaced(
        adf,
        /<scan:DiscreteResolutions>.*<\/scan:DiscreteResolutions>/s,
        '<scan:ResolutionRange>' +
          '<scan:XResolutionRange><scan:Min>75</scan:Min><scan:Max>600</scan:Max><scan:Normal>300</scan:Normal><scan:Step>1</scan:Step></scan:XResolutionRange>' +
          '<scan:YResolutionRange><scan:Min>75</scan:Min><scan:Max>600</scan:Max><scan:Normal>300</scan:Normal><scan:Step>1</scan:Step></scan:YResolutionRange>' +
          '</scan:ResolutionRange>',
      ),
    );

    expect(parsed(ranged).adf.resolutions).toEqual([75, 100, 150, 200, 300, 400, 600]);
  });

  it('диапазон с шагом оставляет только значения на шаге', () => {
    const range = (axis: string): string =>
      `<scan:${axis}ResolutionRange><scan:Min>100</scan:Min><scan:Max>600</scan:Max><scan:Step>100</scan:Step></scan:${axis}ResolutionRange>`;
    const ranged = inAdf((adf) =>
      replaced(
        adf,
        /<scan:DiscreteResolutions>.*<\/scan:DiscreteResolutions>/s,
        `<scan:ResolutionRange>${range('X')}${range('Y')}</scan:ResolutionRange>`,
      ),
    );

    expect(parsed(ranged).adf.resolutions).toEqual([100, 200, 300, 400, 600]);
  });

  it('разрешение с разными осями и нечисловое пропускаются', () => {
    const odd = inAdf((adf) =>
      replaced(
        adf,
        '<scan:DiscreteResolutions>',
        '<scan:DiscreteResolutions>' +
          '<scan:DiscreteResolution><scan:XResolution>300</scan:XResolution><scan:YResolution>150</scan:YResolution></scan:DiscreteResolution>' +
          '<scan:DiscreteResolution><scan:XResolution>много</scan:XResolution><scan:YResolution>много</scan:YResolution></scan:DiscreteResolution>' +
          '<scan:DiscreteResolution><scan:XResolution>0</scan:XResolution><scan:YResolution>0</scan:YResolution></scan:DiscreteResolution>',
      ),
    );

    expect(parsed(odd).adf.resolutions).toEqual([100, 200, 300, 600]);
  });

  it('неизвестный цветовой режим и формат пропускаются, а не попадают в результат', () => {
    const extra = inAdf((adf) =>
      replaced(
        replaced(
          adf,
          '<scan:ColorModes>',
          '<scan:ColorModes><scan:ColorMode>RGB48</scan:ColorMode><scan:ColorMode>&lt;b&gt;</scan:ColorMode>',
        ),
        '<scan:DocumentFormats>',
        '<scan:DocumentFormats><pwg:DocumentFormat>image/x-secret</pwg:DocumentFormat>',
      ),
    );

    expect(parsed(extra).adf.colorModes).toEqual(['BlackAndWhite1', 'Grayscale8', 'RGB24']);
    expect(parsed(extra).adf.documentFormats).toEqual(['image/jpeg', 'application/pdf']);
  });

  it('JPEG, названный только новым элементом DocumentFormatExt, считается', () => {
    const extOnly = inAdf((adf) =>
      replaced(adf, '<pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>', ''),
    );

    expect(parsed(extOnly).adf.documentFormats).toContain('image/jpeg');
  });

  it('второй профиль с JPEG берётся, если в первом JPEG нет', () => {
    const profile = /<scan:SettingProfile>.*<\/scan:SettingProfile>/s.exec(adfOf(ET_3850_XML));
    const pdfOnly = (profile?.[0] ?? '').replaceAll('image/jpeg', 'image/tiff');
    const twoProfiles = inAdf((adf) =>
      replaced(adf, '<scan:SettingProfiles>', `<scan:SettingProfiles>${pdfOnly}`),
    );

    expect(parsed(twoProfiles).adf.documentFormats).toContain('image/jpeg');
  });

  it('длинная строка модели с управляющими символами обрезается и чистится', () => {
    // Из управляющих символов XML 1.0 пропускает только табуляцию, переводы строк и диапазон C1.
    const noisy = replaced(
      ET_3850_XML,
      'EPSON ET-3850 Series',
      `EPSON\t\u0085\nET ${'Z'.repeat(400)}`,
    );

    const model = parsed(noisy).makeAndModel ?? '';
    expect(model.length).toBe(128);
    expect(model.startsWith('EPSON   ET ZZ')).toBe(true);
  });

  it('управляющий символ, запрещённый в XML, — отказ разбора, а не строка в интерфейсе', () => {
    const noisy = replaced(ET_3850_XML, 'EPSON ET-3850 Series', 'EPSON\u0007ET');

    expect(failureOf(noisy)).toEqual({
      code: 'scannerBadResponse',
      details: { reason: 'malformed' },
    });
  });
});

describe('parseCapabilities: отказы', () => {
  it('capabilities без автоподачи — свой код отказа', () => {
    expect(parseCapabilities(readFixture('escl', 'no-adf', 'ScannerCapabilities.xml'))).toEqual({
      ok: false,
      error: { code: 'scannerNoAdf' },
    });
  });

  it('автоподача только двусторонняя — тоже «нет автоподачи»: нужна односторонняя', () => {
    const duplexOnly = ET_3850_XML.replaceAll('AdfSimplexInputCaps', 'AdfDuplexInputCaps');

    expect(failureOf(duplexOnly)).toEqual({ code: 'scannerNoAdf' });
  });

  it('capabilities без JPEG — другой код отказа', () => {
    const noJpeg = inAdf((adf) => adf.replaceAll('image/jpeg', 'image/tiff'));

    expect(failureOf(noJpeg)).toEqual({ code: 'scannerNoJpeg' });
  });

  it('JPEG только у планшета автоподаче не засчитывается', () => {
    const noJpeg = inAdf((adf) => adf.replaceAll('image/jpeg', 'image/tiff'));

    expect(noJpeg).toContain('image/jpeg');
    expect(failureOf(noJpeg)).toEqual({ code: 'scannerNoJpeg' });
  });

  it.each([
    ['статус вместо capabilities', readFixtureText(...ET_3850, 'ScannerStatus.xml')],
    ['чужой корень', '<rss version="2.0"><channel/></rss>'],
    [
      'то же имя корня в чужом пространстве',
      replaced(ET_3850_XML, 'http://schemas.hp.com/imaging/escl/2011/05/03', 'urn:not-escl'),
    ],
  ])('документ не eSCL даёт код «не сканер eSCL»: %s', (_name, xml) => {
    expect(failureOf(xml)).toEqual({ code: 'notEsclScanner' });
  });

  it('не XML и документ с DOCTYPE — «ответ не разобран» с причиной', () => {
    expect(failureOf('<html><body>Login<br></body></html>')).toEqual({
      code: 'scannerBadResponse',
      details: { reason: 'malformed' },
    });
    expect(failureOf(replaced(ET_3850_XML, '?>', '?><!DOCTYPE x>'))).toEqual({
      code: 'scannerBadResponse',
      details: { reason: 'doctype' },
    });
  });

  it('автоподача без пределов региона или с мусором в них — «ответ не разобран»', () => {
    const noWidth = inAdf((adf) => replaced(adf, '<scan:MaxWidth>2550</scan:MaxWidth>', ''));
    const hugeHeight = inAdf((adf) =>
      replaced(
        adf,
        '<scan:MaxHeight>4200</scan:MaxHeight>',
        '<scan:MaxHeight>99999999</scan:MaxHeight>',
      ),
    );

    for (const xml of [noWidth, hugeHeight]) {
      expect(failureOf(xml)).toEqual({
        code: 'scannerBadResponse',
        details: { reason: 'adfRegion' },
      });
    }
  });

  it('профиль с JPEG, но без разрешений — «ответ не разобран», а не «нет JPEG»', () => {
    const noResolutions = inAdf((adf) =>
      replaced(adf, /<scan:SupportedResolutions>.*<\/scan:SupportedResolutions>/s, ''),
    );

    expect(failureOf(noResolutions)).toEqual({
      code: 'scannerBadResponse',
      details: { reason: 'adfProfile' },
    });
  });
});
