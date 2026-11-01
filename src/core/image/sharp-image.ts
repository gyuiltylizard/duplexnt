import sharp, { type Sharp } from 'sharp';

// Единственный вход ядра в `sharp` для страниц пользователя (B-21, план 2026-11-01-001; KTD-1):
// каждый вызов идёт с двумя сроками. Срок libvips — настоящая отмена: `sharp` проверяет его в
// колбэке прогресса и прерывает обработку между кусками вывода, поток освобождается. Запасной
// срок приложения — для обработки, застрявшей без прогресса (зацикливание внутри одного вызова
// событий прогресса не даёт): ожидание бросается, ячейка лимитера, `merge` и `settleDerived`
// свободны, а застрявший поток libvips остаётся занятым до своего конца (KTD-3). Входы — байты в
// памяти: брошенная обработка не держит файлов каталога сессии. Страж импорта —
// `test/guards/sharp-entry.test.ts`.

/** Срок libvips, секунды: декод страницы 600 dpi цвет — до секунды, запас ×30 (KTD-2). */
export const IMAGE_TIMEOUT_SECONDS = 30;

/** Запасной срок приложения, мс: срок libvips и запас на его срабатывание (KTD-3). */
export const IMAGE_DEADLINE_MS = 35_000;

/** Наибольший срок libvips, который принимает `sharp`; 0 срок выключает — не допускаем. */
const MAX_TIMEOUT_SECONDS = 3600;

/** Текст ошибки срока libvips (`VipsProgressCallBack` в `sharp/src/common.cc`). */
const LIBVIPS_TIMEOUT = /timeout: \d+% complete/;

/** Обработка не уложилась в срок — любым из двух слоёв. Исход «не успели», не порча файла. */
export class ImageTimeoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImageTimeoutError';
  }
}

/** Вход обработки: JPEG с пределом пикселей или сырые пиксели (кодирование выпрямления). */
export type ImageInput =
  | { readonly kind: 'jpeg'; readonly bytes: Uint8Array; readonly pixelLimit: number }
  | {
      readonly kind: 'raw';
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
      readonly channels: 1 | 3;
    };

/** Подмена сроков — только для тестов; по умолчанию — константы выше. */
export interface ImageDeadlines {
  /** Срок libvips, целые секунды 1…3600. */
  readonly seconds?: number;
  /** Запасной срок, мс. */
  readonly deadlineMs?: number;
}

/** Срок ли это — ошибка помощника; вызывающие отличают по ней «не успели» от прочих сбоев. */
export function isImageTimeout(error: unknown): error is ImageTimeoutError {
  return error instanceof ImageTimeoutError;
}

function open(input: ImageInput, seconds: number): Sharp {
  const image =
    input.kind === 'jpeg'
      ? sharp(input.bytes, { limitInputPixels: input.pixelLimit })
      : sharp(input.bytes, {
          raw: { width: input.width, height: input.height, channels: input.channels },
        });
  return image.timeout({ seconds });
}

/**
 * Срок ли отказ `sharp` (KTD-4). Буфер ошибок libvips общий на процесс и чистится после каждой
 * обработки: при соседних обработках текст срока может оказаться не первым или стереться. Поэтому
 * сроком считается и текст где угодно в сообщении, и любой отказ не раньше срока по часам.
 */
function isLibvipsTimeout(error: unknown, elapsedMs: number, seconds: number): boolean {
  return (
    (error instanceof Error && LIBVIPS_TIMEOUT.test(error.message)) || elapsedMs >= seconds * 1000
  );
}

/**
 * Обработка картинки со сроками: `work` получает экземпляр `sharp` со сроком libvips и делает с
 * ним всё — от чтения заголовка до готового буфера. Срок любого слоя — `ImageTimeoutError`;
 * прочие отказы пробрасываются как есть.
 */
export async function processImage<T>(
  input: ImageInput,
  work: (image: Sharp) => Promise<T>,
  deadlines: ImageDeadlines = {},
): Promise<T> {
  const seconds = deadlines.seconds ?? IMAGE_TIMEOUT_SECONDS;
  const deadlineMs = deadlines.deadlineMs ?? IMAGE_DEADLINE_MS;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
    throw new RangeError(`срок libvips — целые секунды 1…${String(MAX_TIMEOUT_SECONDS)}`);
  }
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const backstop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ImageTimeoutError(`обработка картинки не ответила за ${String(deadlineMs)} мс`));
    }, deadlineMs);
  });
  const running = Promise.resolve().then(() => work(open(input, seconds)));
  // Проигравшая гонку обработка может отказать позже — без обработчика это был бы unhandled.
  void running.catch(() => undefined);
  try {
    return await Promise.race([running, backstop]);
  } catch (error: unknown) {
    if (isImageTimeout(error)) {
      throw error;
    }
    if (isLibvipsTimeout(error, performance.now() - started, seconds)) {
      throw new ImageTimeoutError(`обработка картинки не уложилась в ${String(seconds)} с`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
