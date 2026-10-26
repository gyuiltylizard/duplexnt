import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeIcoEntries,
  encodeIco,
  ICON_PATH,
  ICON_SIZES,
  WINDOW_ICON_PATH,
  WINDOW_ICON_SIZES,
} from '../../scripts/ico';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Кадр 2×2: сверху красный и зелёный, снизу синий и полупрозрачный белый. */
// prettier-ignore
const TINY = Uint8Array.of(
  255, 0, 0, 255,    0, 255, 0, 255,
  0, 0, 255, 255,    255, 255, 255, 128,
);

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

describe('контейнер ICO (B-7)', () => {
  it('заголовок, таблица записей и смещения сходятся', () => {
    const png = Uint8Array.of(...PNG_SIGNATURE, 1, 2, 3);
    const ico = encodeIco([
      { size: 2, rgba: TINY },
      { size: 256, rgba: new Uint8Array(256 * 256 * 4), png },
    ]);
    const header = view(ico);

    expect([
      header.getUint16(0, true),
      header.getUint16(2, true),
      header.getUint16(4, true),
    ]).toEqual([0, 1, 2]);
    // 256 пишется нулём в однобайтовом поле.
    expect([ico[6], ico[7], ico[22], ico[23]]).toEqual([2, 2, 0, 0]);
    const [small, large] = decodeIcoEntries(ico);
    expect(small?.size).toBe(2);
    expect(large?.size).toBe(256);
    expect([...(large?.bytes ?? [])]).toEqual([...png]);
    expect(view(ico).getUint32(6 + 12, true)).toBe(6 + 16 * 2);
  });

  it('DIB-кадр: удвоенная высота, 32 бита, BGRA снизу вверх, нулевая маска', () => {
    const [frame] = decodeIcoEntries(encodeIco([{ size: 2, rgba: TINY }]));
    const dib = frame?.bytes ?? new Uint8Array();
    const info = view(dib);

    expect([info.getUint32(0, true), info.getInt32(4, true), info.getInt32(8, true)]).toEqual([
      40, 2, 4,
    ]);
    expect(info.getUint16(14, true)).toBe(32);
    // Первая строка DIB — нижняя строка кадра: синий, затем полупрозрачный белый.
    expect([...dib.subarray(40, 48)]).toEqual([255, 0, 0, 255, 255, 255, 255, 128]);
    // Вторая — верхняя: красный и зелёный в порядке BGRA.
    expect([...dib.subarray(48, 56)]).toEqual([0, 0, 255, 255, 0, 255, 0, 255]);
    // Маска: строки по 4 байта, нули — прозрачность несёт альфа.
    expect([...dib.subarray(56)]).toEqual(new Array(8).fill(0));
  });

  it('кадр 256 без PNG и кадр не того размера — отказ, а не битый файл', () => {
    expect(() => encodeIco([{ size: 256, rgba: new Uint8Array(256 * 256 * 4) }])).toThrow(/PNG/);
    expect(() => encodeIco([{ size: 2, rgba: new Uint8Array(3) }])).toThrow(/RGBA/);
  });

  it("build/icon.ico: девять кадров handoff'а, мелкие — DIB, 256 — PNG", () => {
    const entries = decodeIcoEntries(new Uint8Array(readFileSync(resolve(ICON_PATH))));

    expect(entries.map((entry) => entry.size)).toEqual([...ICON_SIZES]);
    for (const entry of entries) {
      const isPng = PNG_SIGNATURE.every((byte, index) => entry.bytes[index] === byte);
      expect(isPng).toBe(entry.size === 256);
      if (!isPng) {
        expect(view(entry.bytes).getInt32(4, true)).toBe(entry.size);
      }
    }
  });

  it('build/window-icon.ico: системные размеры 100–200 %, кадр 32 — плитка почти в край', () => {
    const entries = decodeIcoEntries(new Uint8Array(readFileSync(resolve(WINDOW_ICON_PATH))));

    expect(entries.map((entry) => entry.size)).toEqual([...WINDOW_ICON_SIZES]);
    // Панель задач ужимает кадр 32 до 24 px. У icon.svg пиксель (1, 16) — прозрачное поле сетки,
    // у icon-small.svg — уже плитка: значок на панели вровень с соседями.
    const dib = entries.find((entry) => entry.size === 32)?.bytes ?? new Uint8Array();
    const alphaAt = (x: number, y: number): number | undefined =>
      dib[40 + ((31 - y) * 32 + x) * 4 + 3];
    expect(alphaAt(1, 16)).toBe(255);
  });
});
