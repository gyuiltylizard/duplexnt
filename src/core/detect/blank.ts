import {
  decodeWorkingGray,
  INK_DELTA,
  marginHistogramOf,
  paperWhiteOf,
  type GrayImage,
} from './gray';

// Детектор пустых страниц (план M4, U2, KTD2; спека → «Пустые обороты»): доля «чернильных»
// пикселей после приведения к серому и уменьшения, внутри обрезки полей. Вердикт «пусто» —
// доля ниже порога. Детектор только предлагает: страница скрывается по режиму сессии и её
// возвращает пометка «это не пустая страница» (ADR 0004, амендмент 2026-10-22).
//
// Константы откалиброваны табличным тестом на настоящих сканах ET-3850
// (`test/integration/blank-detector.test.ts`, фикстуры `test/fixtures/escl/et-3850/scans/`):
// чистый лист, просвечивание и дырокол — пусто; бледный карандаш, одна строка, подпись и
// карандашный номер страницы — не пусто. Любая смена констант поднимает
// `BLANK_DETECTOR_VERSION`: кэш оценок с другой версией пересчитывается (KTD3).
//
// Рабочий размер, обрезка полей, белое бумаги и дельта чернил — общие с детектором перекоса
// подачи (M6) и живут в `gray.ts`.

/**
 * Версия алгоритма и констант; хранится в кэше оценок.
 * 2 — порог 5e-4 → 1.35e-4 (приёмка M4, 2026-10-23): бледный карандашный номер «1о» на
 * 200 dpi давал 2.8e-4 и скрывался.
 */
export const BLANK_DETECTOR_VERSION = 2;

/**
 * Порог доли чернильных пикселей: ниже — пусто. Геометрическая середина между худшим пустым
 * (дырокол, 6.6e-5) и слабейшим содержимым (бледный карандашный номер, 2.8e-4) — запас по
 * двукратному в обе стороны; тест калибровки требует не меньше. Одиночная мелкая бледная
 * пометка всё же может оказаться ниже порога — её покажет переключатель «Пустые».
 */
export const BLANK_THRESHOLD = 0.000135;

/**
 * Доля чернильных пикселей серого изображения внутри обрезки полей (чистая функция —
 * `npm test`). Белое бумаги оценивается по самой картинке: серая или кремовая бумага не
 * становится «чернилами», а просвечивание с обратной стороны, которое светлее дельты, —
 * тоже. Вырожденная область (нет пикселей) — `0`.
 */
export function inkRatioOf(gray: GrayImage): number {
  const { histogram, total } = marginHistogramOf(gray);
  if (total === 0) {
    return 0;
  }
  const inkBelow = paperWhiteOf(histogram, total) - INK_DELTA;
  let ink = 0;
  for (let level = 0; level < inkBelow; level += 1) {
    ink += histogram[level] ?? 0;
  }
  return ink / total;
}

/** Вердикт по доле: `null` (не оценена или сбой) — не пусто. */
export function isBlank(ratio: number | null): boolean {
  return ratio !== null && ratio < BLANK_THRESHOLD;
}

/**
 * Доля чернильных пикселей страницы JPEG (`sharp` — `test:integration`). Сбой — не JPEG,
 * превышение предела пикселей, ошибка декодирования — `null`: такая страница считается не
 * пустой и ошибкой не является (R6). Срок обработки (B-21) — исключение `ImageTimeoutError` из
 * декода: оценки держат «не успели» в памяти, без кэша.
 */
export async function blankRatio(
  bytes: Uint8Array,
  pixelLimit: number | null,
): Promise<number | null> {
  const gray = await decodeWorkingGray(bytes, pixelLimit);
  return gray === null ? null : inkRatioOf(gray);
}

/** Детектор как зависимость службы проходов (KTD3): в тестах службы — заглушка. */
export type BlankDetector = (
  bytes: Uint8Array,
  pixelLimit: number | null,
) => Promise<number | null>;
