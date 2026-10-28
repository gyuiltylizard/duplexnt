import { describe, expect, it } from 'vitest';
import { jfifDpi } from '../pdf/assemble';
import { hasJpegMarkers, withJfifDensity } from './jpeg-markers';

// Обрамление JPEG и плотность в заголовке JFIF (план M6, U3): выход ресэмплера получает APP0 с
// плотностью руками, потому что `withMetadata` у `sharp` тянет за собой sRGB и ICC.

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
/** APP0 JFIF 1.01, единицы 0, плотность 1×1 — как пишет libjpeg. */
const JFIF_NO_DENSITY = [
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
  0x00, 0x00,
];
const DQT_HEAD = [0xff, 0xdb, 0x00, 0x05, 0x00, 0x01, 0x02];

describe('обрамление JPEG', () => {
  it('SOI в начале и EOI в конце; короче четырёх байт — не JPEG', () => {
    expect(hasJpegMarkers(Uint8Array.from([...SOI, ...EOI]))).toBe(true);
    expect(hasJpegMarkers(Uint8Array.from([...SOI, 1, 2, 3]))).toBe(false);
    expect(hasJpegMarkers(Uint8Array.from([0xff, 0xd8, 0xd9]))).toBe(false);
  });
});

describe('плотность в заголовке JFIF', () => {
  it('без APP0 (mozjpeg): заголовок вставляется сразу после SOI, остальное — байт в байт', () => {
    const bare = Uint8Array.from([...SOI, ...DQT_HEAD, ...EOI]);
    const { jpeg, dpi } = withJfifDensity(bare, 300);

    expect(dpi).toBe(300);
    expect(jpeg.length).toBe(bare.length + 18);
    expect(jfifDpi(jpeg)).toBe(300);
    expect([...jpeg.subarray(20)]).toEqual([...DQT_HEAD, ...EOI]);
    expect(jfifDpi(bare)).toBeNull();
  });

  it('с APP0 без плотности: единицы и плотность переписываются в копии, вход не меняется', () => {
    const input = Uint8Array.from([...SOI, ...JFIF_NO_DENSITY, ...DQT_HEAD, ...EOI]);
    const before = Uint8Array.from(input);
    const { jpeg, dpi } = withJfifDensity(input, 600);

    expect(dpi).toBe(600);
    expect(jpeg.length).toBe(input.length);
    expect(jfifDpi(jpeg)).toBe(600);
    expect([...input]).toEqual([...before]);
    expect(jpeg).not.toBe(input);
  });

  it('не JPEG или плотность вне заголовка — вход как есть, dpi null', () => {
    const bare = Uint8Array.from([...SOI, ...DQT_HEAD, ...EOI]);
    for (const dpi of [0, -300, 1.5, 70_000]) {
      const result = withJfifDensity(bare, dpi);
      expect(result.dpi, String(dpi)).toBeNull();
      expect(result.jpeg).toBe(bare);
    }
    const junk = new TextEncoder().encode('<html>');
    expect(withJfifDensity(junk, 300)).toEqual({ jpeg: junk, dpi: null });
  });
});
