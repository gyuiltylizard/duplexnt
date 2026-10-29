import { join } from 'node:path';
import sharp from 'sharp';
import { fail, ok, type Result } from '@shared';
import type { InputCaps } from '../escl/capabilities';
import { hasJpegMarkers } from '../escl/jpeg-markers';
import { REGION_UNITS_PER_INCH } from '../escl/region';
import { writeFileAtomic } from './atomic-file';
import { pageFileName, straightFileName, straightThumbsDirIn, thumbsDirIn } from './layout';
import { limiterOf, type Limiter } from './limiter';
import type { PageInfo } from './session-store';
import { ioOf, listDir, type StorageOptions } from './storage-fs';
import type { Straightened, StraightenedFile } from './straightened';

// Миниатюры — производное (ADR 0004; план M1, U16, KTD-22, KTD-37). Строятся по требованию из
// исходника и кэшируются вне каталога сессии, под её идентификатором: кэш прошлой сессии не
// может показаться в новой, а очистка кэша не может задеть исходники. Модуль знает только корень
// кэша и чтение страницы по ключу — пути к исходникам у него нет, и в каталог сессии он не пишет.
//
// `sharp` видит только JPEG (KTD-37): libvips выбирает загрузчик по содержимому, и без проверки
// под видом страницы в main попал бы любой его формат. Маркеры проверяются до декодирования,
// формат и размер — по заголовку, предел пикселей — ещё раз самим декодером.
//
// Миниатюра выправленной страницы (M6, U6; KTD-7) — отдельный вариант в `straight-thumbs/` с
// версией геометрии в имени: строится из файла, который отдаёт `straightened.resolve`
// (единственный источник пути, KTD-11), тем же конвейером и с тем же пределом; миниатюры
// прежних версий убираются после записи новой. Нет записи о коррекции — отказ `pageUnavailable`,
// и протокол отдаёт обычную миниатюру.

/** Миниатюра вписывается в эту рамку; пропорции — как у A4. Вдвое крупнее, чем показывает лента. */
export const THUMBNAIL_BOX = { width: 320, height: 452 } as const;
const THUMBNAIL_QUALITY = 80;
const DEFAULT_CONCURRENCY = 2;

/**
 * Потолок для прохода с неизвестными параметрами (журнал пересобран по файлам): поле 8,5 × 14
 * дюймов при 1200 dpi.
 */
export const FALLBACK_PIXEL_LIMIT = 10_200 * 16_800;

/**
 * Потолок в коде — встроенный предел `sharp`. Предел страницы приходит из capabilities, то есть
 * от самого устройства, и из журнала, то есть с диска: оба могут предел только понизить. Без
 * потолка враждебное устройство заявило бы поле и разрешение, при которых декодер не ограничен
 * ничем, и страница в несколько мегабайт заняла бы гигабайты памяти в main.
 */
export const MAX_PAGE_PIXELS = 0x3fff * 0x3fff;

/** Предел, с которым страница декодируется: из журнала, но не выше потолка. */
export function decodePixelLimit(pixelLimit: number | null): number {
  return Math.min(pixelLimit ?? FALLBACK_PIXEL_LIMIT, MAX_PAGE_PIXELS);
}

/**
 * Предел пикселей страницы (KTD-37): наибольший регион автоподачи при наибольшем разрешении,
 * но не выше потолка в коде.
 * Считается при начале прохода и записывается в журнал — миниатюры строятся и при выключенном
 * сканере.
 */
export function pagePixelLimit(adf: InputCaps): number {
  const resolution = Math.max(...adf.resolutions);
  const side = (units: number): number => Math.ceil((units * resolution) / REGION_UNITS_PER_INCH);
  return Math.min(side(adf.maxWidth) * side(adf.maxHeight), MAX_PAGE_PIXELS);
}

/** Откуда миниатюры берут страницы; хранилище сессии этому интерфейсу подходит. */
export interface ThumbnailSource {
  /** Страница текущей сессии, у которой есть файл; иначе `null`. */
  pageInfo(key: string): PageInfo | null;
  readPage(key: string): Promise<Result<Uint8Array>>;
}

export interface ThumbnailOptions extends StorageOptions {
  /**
   * Общий лимитер производного (M6, KTD-4): миниатюры идут в нём с обычным приоритетом. Без него
   * — свой, на `concurrency` задач.
   */
  readonly limiter?: Limiter;
  /** Сколько миниатюр строится одновременно, когда лимитер не передан. */
  readonly concurrency?: number;
  /** Выправленные страницы (M6, KTD-7) — для варианта `straight`; без них он всегда отказывает. */
  readonly straightened?: Pick<Straightened, 'resolve'>;
}

export interface Thumbnails {
  /**
   * Миниатюра страницы в JPEG — из кэша или построенная. Для потерянной и неизвестной страницы
   * отказывает даже при тёплом кэше.
   */
  get(key: string): Promise<Result<Uint8Array>>;
  /**
   * Миниатюра выправленной страницы (M6, KTD-7) — из кэша или построенная по файлу из
   * `straightened.resolve`; без записи о коррекции отказывает `pageUnavailable`.
   */
  getStraight(key: string): Promise<Result<Uint8Array>>;
}

type FailureReason = 'notJpeg' | 'tooLarge' | 'decode';
const failed = (reason: FailureReason): Result<never> => fail('thumbnailFailed', { reason });
const UNAVAILABLE = fail('pageUnavailable', { reason: 'unknown' });
const NOT_STRAIGHTENED = fail('pageUnavailable', { reason: 'notStraightened' });

async function render(source: Uint8Array, pixelLimit: number): Promise<Result<Uint8Array>> {
  if (!hasJpegMarkers(source)) {
    return failed('notJpeg');
  }
  try {
    const image = sharp(source, { limitInputPixels: pixelLimit });
    const { format, width, height } = await image.metadata();
    if (format !== 'jpeg') {
      return failed('notJpeg');
    }
    if (width * height > pixelLimit) {
      return failed('tooLarge');
    }
    const thumbnail = await image
      .resize({ ...THUMBNAIL_BOX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: THUMBNAIL_QUALITY })
      .toBuffer();
    return ok(new Uint8Array(thumbnail.buffer, thumbnail.byteOffset, thumbnail.byteLength));
  } catch (error) {
    return failed(/pixel limit/i.test(String(error)) ? 'tooLarge' : 'decode');
  }
}

export function createThumbnails(
  derivedDir: string,
  source: ThumbnailSource,
  options: ThumbnailOptions = {},
): Thumbnails {
  const io = ioOf(options);
  const { fs } = io;
  const limited = options.limiter ?? limiterOf(options.concurrency ?? DEFAULT_CONCURRENCY);
  const straightened = options.straightened ?? { resolve: () => null };

  /** Миниатюра из байтов источника в кэш `dir/file`; страницу могли отбросить, пока строилась. */
  async function build(
    key: string,
    info: PageInfo,
    dir: string,
    file: string,
    read: () => Promise<Result<Uint8Array>>,
    stillWanted: () => boolean = () => true,
  ): Promise<Result<Uint8Array>> {
    const page = await read();
    if (!page.ok) {
      return page;
    }
    const rendered = await render(page.value, decodePixelLimit(info.pixelLimit));
    if (!rendered.ok) {
      return rendered;
    }
    // Кэш — по возможности: миниатюра отдаётся и тогда, когда записать её не удалось.
    const cached = await fs
      .mkdir(dir)
      .then(() => writeFileAtomic(file, rendered.value, io))
      .then(
        () => true,
        () => false,
      );
    // Пока миниатюра строилась, страницу могли отбросить («Остановить», «Новая пачка») или
    // откатить к другой версии: такая миниатюра не отдаётся и в кэше не остаётся.
    if (source.pageInfo(key)?.sessionId !== info.sessionId || !stillWanted()) {
      if (cached) {
        await fs.unlink(file).catch(() => undefined);
      }
      return UNAVAILABLE;
    }
    return rendered;
  }

  /** Выправленный файл в байтах; размер сверяется с записью о коррекции (KTD-11). */
  async function readStraight(file: StraightenedFile): Promise<Result<Uint8Array>> {
    try {
      const bytes = await fs.readFile(file.path);
      return bytes.byteLength === file.bytes ? ok(bytes) : NOT_STRAIGHTENED;
    } catch {
      return NOT_STRAIGHTENED;
    }
  }

  /** Миниатюры прежних версий страницы — после записи новой. */
  async function dropOldVersions(dir: string, key: string, keep: string): Promise<void> {
    for (const name of await listDir(fs, dir)) {
      if (name !== keep && name.startsWith(`${key}.v`) && name.endsWith('.jpg')) {
        await fs.unlink(join(dir, name)).catch(() => undefined);
      }
    }
  }

  // Одна страница строится один раз, сколько бы запросов ни пришло одновременно.
  const building = new Map<string, Promise<Result<Uint8Array>>>();

  async function cachedOrBuilt(
    file: string,
    make: () => Promise<Result<Uint8Array>>,
  ): Promise<Result<Uint8Array>> {
    try {
      const cached = await fs.readFile(file);
      if (cached.byteLength > 0) {
        return ok(cached);
      }
    } catch {
      // Кэша нет или он не читается — миниатюра строится заново.
    }
    const inFlight = building.get(file);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const run = limited(make).finally(() => building.delete(file));
    building.set(file, run);
    return run;
  }

  return {
    get(key) {
      const info = source.pageInfo(key);
      if (info === null) {
        return Promise.resolve(UNAVAILABLE);
      }
      const dir = thumbsDirIn(derivedDir, info.sessionId);
      const file = join(dir, pageFileName(key));
      return cachedOrBuilt(file, () => build(key, info, dir, file, () => source.readPage(key)));
    },

    getStraight(key) {
      const info = source.pageInfo(key);
      const straight = straightened.resolve(key);
      if (info === null || straight === null) {
        return Promise.resolve(NOT_STRAIGHTENED);
      }
      const dir = straightThumbsDirIn(derivedDir, info.sessionId);
      const name = straightFileName(key, straight.version);
      const file = join(dir, name);
      return cachedOrBuilt(file, async () => {
        const built = await build(
          key,
          info,
          dir,
          file,
          () => readStraight(straight),
          () => straightened.resolve(key)?.version === straight.version,
        );
        if (built.ok) {
          await dropOldVersions(dir, key, name);
        }
        return built;
      });
    },
  };
}
