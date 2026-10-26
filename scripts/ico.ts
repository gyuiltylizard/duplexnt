// Контейнер ICO (B-7, KTD-2): заголовок, таблица записей и кадры. Кадры меньше 256 px —
// классический DIB: 32-битный BGRA снизу вверх и нулевая AND-маска (прозрачность несёт альфа);
// 256 px — PNG внутри ICO. DIB-кадры читают все потребители значка, включая установщик NSIS и
// редактор ресурсов exe. Своё, а не `png-to-ico`: формат — несколько десятков строк.

/** Кадр значка: квадрат `size`×`size`, пиксели RGBA построчно сверху вниз. */
export interface IcoFrame {
  readonly size: number;
  readonly rgba: Uint8Array;
  /** Готовый PNG того же кадра — для 256 px. */
  readonly png?: Uint8Array;
}

/** Размеры значка приложения (handoff B-7) и путь собранного файла. */
export const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 256] as const;
export const ICON_PATH = 'build/icon.ico';

const HEADER_SIZE = 6;
const ENTRY_SIZE = 16;
const BITMAPINFOHEADER_SIZE = 40;
/** С этого размера кадр пишется PNG (так велит handoff и так делает Windows). */
export const PNG_FRAME_SIZE = 256;

/** DIB-кадр: BITMAPINFOHEADER, BGRA снизу вверх, AND-маска (строки по 4 байта, нули). */
function dibOf({ size, rgba }: IcoFrame): Uint8Array {
  if (rgba.length !== size * size * 4) {
    throw new Error(
      `кадр ${String(size)}: ждали ${String(size * size * 4)} байт RGBA, пришло ${String(rgba.length)}`,
    );
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const pixels = size * size * 4;
  const out = new Uint8Array(BITMAPINFOHEADER_SIZE + pixels + maskRow * size);
  const view = new DataView(out.buffer);
  view.setUint32(0, BITMAPINFOHEADER_SIZE, true);
  view.setInt32(4, size, true);
  // Высота — удвоенная: в ICO под DIB лежат и цвет, и маска.
  view.setInt32(8, size * 2, true);
  view.setUint16(12, 1, true); // плоскости
  view.setUint16(14, 32, true); // бит на пиксель
  view.setUint32(16, 0, true); // BI_RGB, без сжатия
  view.setUint32(20, pixels + maskRow * size, true);
  for (let row = 0; row < size; row += 1) {
    const from = (size - 1 - row) * size * 4;
    const to = BITMAPINFOHEADER_SIZE + row * size * 4;
    for (let x = 0; x < size; x += 1) {
      const s = from + x * 4;
      const d = to + x * 4;
      out[d] = rgba[s + 2] ?? 0;
      out[d + 1] = rgba[s + 1] ?? 0;
      out[d + 2] = rgba[s] ?? 0;
      out[d + 3] = rgba[s + 3] ?? 0;
    }
  }
  return out;
}

/** Файл ICO из кадров в заданном порядке. */
export function encodeIco(frames: readonly IcoFrame[]): Uint8Array {
  const images = frames.map((frame) => {
    if (frame.size >= PNG_FRAME_SIZE) {
      if (frame.png === undefined) {
        throw new Error(`кадр ${String(frame.size)}: нужен PNG`);
      }
      return frame.png;
    }
    return dibOf(frame);
  });
  const total = images.reduce(
    (sum, image) => sum + image.length,
    HEADER_SIZE + ENTRY_SIZE * frames.length,
  );
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // зарезервировано
  view.setUint16(2, 1, true); // тип: значок
  view.setUint16(4, frames.length, true);
  let offset = HEADER_SIZE + ENTRY_SIZE * frames.length;
  frames.forEach((frame, index) => {
    const image = images[index] ?? new Uint8Array();
    const entry = HEADER_SIZE + ENTRY_SIZE * index;
    // 256 пишется нулём: поле — один байт.
    view.setUint8(entry, frame.size >= 256 ? 0 : frame.size);
    view.setUint8(entry + 1, frame.size >= 256 ? 0 : frame.size);
    view.setUint8(entry + 2, 0); // палитры нет
    view.setUint8(entry + 3, 0);
    view.setUint16(entry + 4, 1, true); // плоскости
    view.setUint16(entry + 6, 32, true); // бит на пиксель
    view.setUint32(entry + 8, image.length, true);
    view.setUint32(entry + 12, offset, true);
    out.set(image, offset);
    offset += image.length;
  });
  return out;
}

export interface IcoEntry {
  readonly size: number;
  readonly bytes: Uint8Array;
}

/** Разбор ICO обратно в записи — для тестов и проверки собранного файла. */
export function decodeIcoEntries(ico: Uint8Array): IcoEntry[] {
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
    throw new Error('не ICO: заголовок не тот');
  }
  return Array.from({ length: view.getUint16(4, true) }, (_, index) => {
    const entry = HEADER_SIZE + ENTRY_SIZE * index;
    const width = view.getUint8(entry);
    const length = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    return { size: width === 0 ? 256 : width, bytes: ico.subarray(offset, offset + length) };
  });
}
