import { setImmediate as nextTick } from 'node:timers/promises';
import { degrees, PDFDocument, type PDFImage } from '@cantoo/pdf-lib';
import { fail, ok, type Result } from '@shared';
import { decodePixelLimit } from '../storage/thumbnails';

// Сборка PDF (план M2, U5; ADR 0007): упорядоченный список JPEG-страниц → байты документа.
// JPEG вкладывается как есть (`embedJpg` → `DCTDecode`, без перекодирования); поворот — только
// свойством страницы `/Rotate 180` (KTD-2), байты изображения не меняются ни в одном сценарии.
//
// Размер страницы — из размеров JPEG и DPI прохода (KTD-9): пункты = пиксели / DPI × 72;
// формата-константы нет. DPI неизвестен (журнал пересобран, `origin = null`) — берётся
// плотность из JFIF-заголовка, иначе 300: данные пользователя спасаемы, сборка не падает.
//
// Документ собирается в памяти целиком (KTD-12): сборка асинхронна по страницам — между
// страницами управление возвращается циклу событий; пик памяти проверяется тестом на худшем
// замеренном объёме, а не предположением.

export interface PdfPageInput {
  /** Байты JPEG — исходник страницы с устройства, как лежит на диске. */
  readonly bytes: Uint8Array;
  /** Повернуть страницу на 180° (`/Rotate`): флаг прохода оборотов (KTD-2). */
  readonly rotate180: boolean;
  /** DPI прохода (`origin.params.resolution`); `null` — параметры прохода неизвестны. */
  readonly dpi: number | null;
  /** Предел пикселей страницы (`origin.pixelLimit`); `null` — встроенный потолок (KTD-37). */
  readonly pixelLimit: number | null;
}

const POINTS_PER_INCH = 72;
const FALLBACK_DPI = 300;
const DPCM_TO_DPI = 2.54;

/**
 * Плотность из JFIF-заголовка (APP0, сразу после SOI): единицы 1 — точки на дюйм, 2 — на
 * сантиметр, 0 — только пропорции, плотности нет. Берётся горизонтальная: страницы устройства
 * квадратно-пиксельные.
 */
export function jfifDpi(bytes: Uint8Array): number | null {
  // SOI, затем APP0 длиной не меньше 16: маркер, длина, "JFIF\0", версия, единицы, плотности.
  if (bytes.length < 18 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  if (bytes[2] !== 0xff || bytes[3] !== 0xe0) {
    return null;
  }
  const isJfif =
    bytes[6] === 0x4a &&
    bytes[7] === 0x46 &&
    bytes[8] === 0x49 &&
    bytes[9] === 0x46 &&
    bytes[10] === 0;
  if (!isJfif) {
    return null;
  }
  const units = bytes[13];
  const density = ((bytes[14] ?? 0) << 8) | (bytes[15] ?? 0);
  if (density === 0) {
    return null;
  }
  if (units === 1) {
    return density;
  }
  return units === 2 ? Math.round(density * DPCM_TO_DPI) : null;
}

/** Сборка документа из страниц в собранном порядке. Пустой набор — отказ, не пустой PDF. */
export async function assemblePdf(pages: readonly PdfPageInput[]): Promise<Result<Uint8Array>> {
  if (pages.length === 0) {
    return fail('invalidInput', { field: 'pages', problem: 'empty' });
  }
  const document = await PDFDocument.create();
  for (const [index, page] of pages.entries()) {
    const unreadable = (): Result<never> => fail('pdfPageUnreadable', { page: index + 1 });
    let image: PDFImage;
    try {
      image = await document.embedJpg(page.bytes);
    } catch {
      return unreadable();
    }
    if (image.width <= 0 || image.height <= 0) {
      return unreadable();
    }
    // Потолок sharp не ослабляется (KTD-9): что нельзя показать, то не собирается молча.
    if (image.width * image.height > decodePixelLimit(page.pixelLimit)) {
      return fail('pdfPageTooLarge', { page: index + 1 });
    }
    const dpi = page.dpi ?? jfifDpi(page.bytes) ?? FALLBACK_DPI;
    const width = (image.width / dpi) * POINTS_PER_INCH;
    const height = (image.height / dpi) * POINTS_PER_INCH;
    const sheet = document.addPage([width, height]);
    sheet.drawImage(image, { x: 0, y: 0, width, height });
    if (page.rotate180) {
      sheet.setRotation(degrees(180));
    }
    // Воздух циклу событий между страницами (KTD-12): сборка не держит процесс.
    await nextTick();
  }
  return ok(await document.save());
}
