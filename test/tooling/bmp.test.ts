import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bmpRowSize, decodeBmp24, encodeBmp24, INSTALLER_ART } from '../../scripts/bmp';

// BMP 24 бит для мастера NSIS (B-26, handoff installer-art): заголовки, строки снизу вверх с
// выравниванием до 4 байт, и собранные картинки в репозитории — того размера и тех цветов, что
// велит handoff (фон плитки `#1c1a16`, D `#fbfaf7`, апостроф `#a06a2a`, шапка на белом).

/** 3×2: верхняя строка красный, зелёный, синий; нижняя — белый, чёрный, серый. */
// prettier-ignore
const TINY = Uint8Array.of(
  255, 0, 0,   0, 255, 0,   0, 0, 255,
  255, 255, 255,   0, 0, 0,   128, 128, 128,
);

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const pixelAt = (
  image: { readonly width: number; readonly rgb: Uint8Array },
  x: number,
  y: number,
): string =>
  '#' +
  [0, 1, 2]
    .map((channel) =>
      (image.rgb[(y * image.width + x) * 3 + channel] ?? 0).toString(16).padStart(2, '0'),
    )
    .join('');

describe('BMP 24 бит (B-26)', () => {
  it('заголовки: BM, размер файла, смещение 54, 24 бита без сжатия, строки выровнены до 4', () => {
    const bmp = encodeBmp24({ width: 3, height: 2, rgb: TINY });
    const header = view(bmp);

    expect(bmpRowSize(3)).toBe(12);
    expect([bmp[0], bmp[1]]).toEqual([0x42, 0x4d]);
    expect(header.getUint32(2, true)).toBe(54 + 12 * 2);
    expect(bmp.length).toBe(54 + 12 * 2);
    expect(header.getUint32(10, true)).toBe(54);
    expect(header.getUint32(14, true)).toBe(40);
    expect([header.getInt32(18, true), header.getInt32(22, true)]).toEqual([3, 2]);
    expect([header.getUint16(26, true), header.getUint16(28, true)]).toEqual([1, 24]);
    expect(header.getUint32(30, true)).toBe(0);
    expect(header.getUint32(34, true)).toBe(24);
  });

  it('пиксели — BGR снизу вверх: первая строка файла — нижняя строка картинки', () => {
    const bmp = encodeBmp24({ width: 3, height: 2, rgb: TINY });

    // Нижняя строка (белый, чёрный, серый) + 3 байта выравнивания, затем верхняя.
    expect([...bmp.subarray(54, 54 + 12)]).toEqual([
      255, 255, 255, 0, 0, 0, 128, 128, 128, 0, 0, 0,
    ]);
    expect([...bmp.subarray(66, 66 + 9)]).toEqual([0, 0, 255, 0, 255, 0, 255, 0, 0]);
  });

  it('разбор возвращает исходный растр; не BMP и не 24 бита — ошибка', () => {
    const bmp = encodeBmp24({ width: 3, height: 2, rgb: TINY });

    expect(decodeBmp24(bmp)).toEqual({ width: 3, height: 2, rgb: TINY });
    expect(() => decodeBmp24(Uint8Array.of(0x50, 0x4e, 0, 0))).toThrow(/не BMP/);
    const wrongDepth = encodeBmp24({ width: 1, height: 1, rgb: Uint8Array.of(1, 2, 3) });
    view(wrongDepth).setUint16(28, 32, true);
    expect(() => decodeBmp24(wrongDepth)).toThrow(/24 бит/);
  });

  it('растр не того размера не кодируется', () => {
    expect(() => encodeBmp24({ width: 2, height: 2, rgb: TINY })).toThrow(/ждали 12 байт/);
  });
});

describe('картинки мастера в репозитории (handoff installer-art)', () => {
  const [sidebar, header] = INSTALLER_ART.map((art) =>
    decodeBmp24(new Uint8Array(readFileSync(resolve(art.bmp)))),
  );

  it('боковая 164 × 314: чернильная плитка, D из песка, апостроф янтарём, низ пустой', () => {
    expect([sidebar?.width, sidebar?.height]).toEqual([164, 314]);
    if (sidebar === undefined) {
      throw new Error('нет боковой');
    }
    expect(pixelAt(sidebar, 0, 0)).toBe('#1c1a16');
    expect(pixelAt(sidebar, 163, 313)).toBe('#1c1a16');
    // D: x 27…111, y 86…182 — внутри вертикальной ножки буквы.
    expect(pixelAt(sidebar, 35, 134)).toBe('#fbfaf7');
    // Апостроф: x 120…138, y 86…125.
    expect(pixelAt(sidebar, 129, 100)).toBe('#a06a2a');
    // Нижние ~130 px пустые: там галка «Запустить» на странице «Готово».
    expect(pixelAt(sidebar, 82, 250)).toBe('#1c1a16');
  });

  it('шапка 150 × 57: белый фон, плитка значка x 99…141, y 8…50', () => {
    expect([header?.width, header?.height]).toEqual([150, 57]);
    if (header === undefined) {
      throw new Error('нет шапки');
    }
    expect(pixelAt(header, 0, 0)).toBe('#ffffff');
    expect(pixelAt(header, 50, 28)).toBe('#ffffff');
    expect(pixelAt(header, 149, 56)).toBe('#ffffff');
    // Плитка со скруглёнными углами: точки — на краях посередине и внутри, D из песка в центре.
    expect(pixelAt(header, 99, 29)).toBe('#1c1a16');
    expect(pixelAt(header, 120, 8)).toBe('#1c1a16');
    expect(pixelAt(header, 137, 29)).toBe('#1c1a16');
    expect(pixelAt(header, 120, 46)).toBe('#1c1a16');
    expect(pixelAt(header, 110, 29)).toBe('#fbfaf7');
    expect(pixelAt(header, 141, 29)).toBe('#ffffff');
    expect(pixelAt(header, 120, 50)).toBe('#ffffff');
  });
});
