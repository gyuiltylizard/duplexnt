// Признак JPEG по обрамлению (план M1, KTD-31): начало `SOI`, конец `EOI`. Одно место правила
// для задания сканирования (проверяет поток по ходу), миниатюр и детектора пустых страниц
// (проверяют буфер до декодирования): `Content-Type` и расширение доказательством не считаются.

export const SOI = [0xff, 0xd8] as const;
export const EOI = [0xff, 0xd9] as const;

/** Буфер начинается с `SOI` и кончается `EOI`; короче четырёх байт — не JPEG. */
export function hasJpegMarkers(bytes: Uint8Array): boolean {
  const { byteLength: length } = bytes;
  return (
    length >= SOI.length + EOI.length &&
    bytes[0] === SOI[0] &&
    bytes[1] === SOI[1] &&
    bytes[length - 2] === EOI[0] &&
    bytes[length - 1] === EOI[1]
  );
}

/** Заголовок JFIF (APP0 длиной 16) с плотностью в точках на дюйм, X = Y = dpi, без миниатюры. */
function jfifApp0(dpi: number): Uint8Array {
  return Uint8Array.of(
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x01,
    dpi >> 8,
    dpi & 0xff,
    dpi >> 8,
    dpi & 0xff,
    0x00,
    0x00,
  );
}

/**
 * JPEG с плотностью в заголовке JFIF — APP0 сразу после SOI, как читает `jfifDpi`: уже есть
 * заголовок — плотность переписывается в копии, нет (mozjpeg в `sharp` его не пишет) —
 * заголовок вставляется. `withMetadata({density})` у `sharp` 0.35 заодно переводит выход в
 * sRGB с профилем ICC — серый становится трёхканальным, файл тяжелее; поэтому плотность
 * пишется руками, без профиля. Не JPEG или dpi вне JFIF — вход как есть, `null`.
 */
export function withJfifDensity(
  jpeg: Uint8Array,
  dpi: number,
): { jpeg: Uint8Array; dpi: number | null } {
  if (!Number.isInteger(dpi) || dpi <= 0 || dpi > 0xffff || !hasJpegMarkers(jpeg)) {
    return { jpeg, dpi: null };
  }
  const hasJfif =
    jpeg.length >= 18 &&
    jpeg[2] === 0xff &&
    jpeg[3] === 0xe0 &&
    (((jpeg[4] ?? 0) << 8) | (jpeg[5] ?? 0)) >= 16 &&
    jpeg[6] === 0x4a &&
    jpeg[7] === 0x46 &&
    jpeg[8] === 0x49 &&
    jpeg[9] === 0x46 &&
    jpeg[10] === 0;
  if (hasJfif) {
    const copy = Uint8Array.from(jpeg);
    copy.set(jfifApp0(dpi).subarray(11, 16), 13);
    return { jpeg: copy, dpi };
  }
  const app0 = jfifApp0(dpi);
  const out = new Uint8Array(jpeg.length + app0.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(jpeg.subarray(2), 2 + app0.length);
  return { jpeg: out, dpi };
}
