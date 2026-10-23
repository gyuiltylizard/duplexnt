import { describe, expect, it } from 'vitest';
import { SCAN_NAME, scanFixture, scanFixtureNames } from '../support/fixtures';

// Настоящие сканы ET-3850 для детектора пустых страниц (M4, U1). Страж приватности читает только
// текст и список значений, а метаданные JPEG могут нести серийный номер устройства — поэтому
// здесь проверяется, что в файлах нет ни EXIF, ни ICC, ни XMP, ни сегментов Photoshop, а имена
// идут по конвенции `<содержимое>-<gray|color>-<dpi>` (test/fixtures/README.md).

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
/** Сегменты без тела: RSTn, SOI, EOI, TEM. */
const STANDALONE = new Set([0x01, SOI, EOI, ...Array.from({ length: 8 }, (_, i) => 0xd0 + i)]);

interface Segment {
  readonly marker: number;
  readonly payload: Buffer;
}

/** Сегменты заголовка JPEG до начала скана (`SOS`); битая разметка — ошибка. */
function headerSegments(bytes: Buffer): Segment[] {
  if (bytes[0] !== 0xff || bytes[1] !== SOI) {
    throw new Error('не JPEG: нет маркера SOI');
  }
  const segments: Segment[] = [];
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new Error(`битая разметка JPEG по смещению ${offset}`);
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === SOS) {
      return segments;
    }
    if (STANDALONE.has(marker)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    segments.push({ marker, payload: bytes.subarray(offset + 4, offset + 2 + length) });
    offset += 2 + length;
  }
  throw new Error('JPEG без сегмента SOS');
}

const METADATA_PREFIXES: readonly [marker: number, prefix: string, what: string][] = [
  [0xe1, 'Exif', 'EXIF'],
  [0xe1, 'http://ns.adobe.com/xap/', 'XMP'],
  [0xe2, 'ICC_PROFILE', 'ICC-профиль'],
  [0xed, 'Photoshop', 'Photoshop (IPTC)'],
  [0xee, 'Adobe', 'Adobe'],
];

const names = scanFixtureNames();

describe('сканы-фикстуры ET-3850 (scans/)', () => {
  it('имена идут по конвенции', () => {
    for (const name of names) {
      expect(name, name).toMatch(SCAN_NAME);
    }
  });

  it.each(names)('%s: JPEG без метаданных устройства', (name) => {
    const bytes = scanFixture(name);
    expect(bytes.byteLength).toBeGreaterThan(0);

    const found = headerSegments(bytes).flatMap(({ marker, payload }) =>
      METADATA_PREFIXES.filter(
        ([expected, prefix]) =>
          marker === expected && payload.subarray(0, prefix.length).toString('latin1') === prefix,
      ).map(([, , what]) => what),
    );

    expect(found, `${name}: метаданные ${found.join(', ')}`).toEqual([]);
  });
});
