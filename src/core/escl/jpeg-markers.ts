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
