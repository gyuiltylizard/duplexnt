import { join } from 'node:path';
import { z } from 'zod';
import type { BlankVerdicts } from '@shared';
import { BLANK_DETECTOR_VERSION, isBlank, type BlankDetector } from '../detect/blank';
import { isImageTimeout } from '../image/sharp-image';
import { writeFileAtomic } from './atomic-file';
import { blankDirIn, blankFileName } from './layout';
import { isAlive, pruneStale } from './liveness';
import { limiterOf, type Limiter } from './limiter';
import type { PageInfo } from './session-store';
import { ioOf, type StorageOptions } from './storage-fs';
import type { ThumbnailSource } from './thumbnails';

// Оценки пустых страниц — производное по образцу миниатюр (план M4, U4, KTD3; ADR 0004, амендмент
// 2026-10-22): карта `ключ → вердикт` в памяти и кэш `derived/<id сессии>/blank/<ключ>.json` с
// долей и версией детектора. В журнал оценка не пишется; кэш с другой версией пересчитывается;
// в каталог сессии модуль не пишет. Сбой детектора (не JPEG, предел пикселей, ошибка чтения) —
// тоже результат: `ratio: null`, страница не пуста и оценки больше не ждёт (R6). Срок обработки
// (B-21) — «не пусто» только в памяти, как временный сбой чтения: кэш не пишется, следующее
// открытие оценит страницу заново.
//
// Служба проходов зовёт `ensure` сразу после приёма страницы оборотов и при открытии — для
// страниц без кэша; `load` читает кэш целиком до первого снимка, чтобы лента после перезапуска
// сразу была с флагами. Потерянная страница (без файла) не оценивается: сборка считает её не
// пустой и не ожидающей.

const DEFAULT_CONCURRENCY = 2;

/** Файл кэша: версия детектора и доля чернильных пикселей; `null` — сбой оценки. */
const cacheSchema = z.strictObject({
  v: z.number().int(),
  ratio: z.number().nullable(),
});

/** Откуда оценки берут страницы — тот же срез, что у миниатюр; хранилище сессии подходит. */
export type BlankScoreSource = ThumbnailSource;

export interface BlankScoresOptions extends StorageOptions {
  /**
   * Общий лимитер производного (M6, KTD-4): оценки пустоты идут в нём с обычным приоритетом.
   * Без него — свой, на `concurrency` задач.
   */
  readonly limiter?: Limiter;
  /** Сколько страниц оценивается одновременно, когда лимитер не передан. */
  readonly concurrency?: number;
}

export interface BlankScores {
  /** Вердикты страниц текущей сессии: `true` — пусто; ключа нет — оценки ещё нет. */
  verdicts(): BlankVerdicts;
  /**
   * Читает кэш указанных страниц без детектора: кэш текущей версии — в карту, остальное —
   * как не было. Для открытия: лента получает флаги до первого снимка.
   */
  load(keys: readonly string[]): Promise<void>;
  /**
   * Оценка страницы: уже есть или строится — ничего; иначе кэш, потом детектор, результат — в
   * карту и кэш (по возможности). `true` — в карте появился новый вердикт. Страница, которой
   * у источника уже нет (отброшена, потеряна), вердикта не получает.
   */
  ensure(key: string): Promise<boolean>;
  /** Забывает вердикты страниц, которых у источника больше нет («Остановить», «Новая пачка»). */
  prune(): void;
  /**
   * Отменяет идущие и ждущие оценки (B-18): закрытие каталога сессии не должно догоняться оценкой
   * в полёте, заново создающей `derived/<id>/blank`. Следующие `ensure` работают как обычно.
   */
  abort(): void;
  /** Ждёт конца всех идущих оценок — отменённых или нет. */
  settle(): Promise<void>;
}

interface Entry {
  readonly sessionId: string;
  readonly blank: boolean;
}

export function createBlankScores(
  derivedDir: string,
  source: BlankScoreSource,
  detector: BlankDetector,
  options: BlankScoresOptions = {},
): BlankScores {
  const io = ioOf(options);
  const { fs } = io;
  const limited = options.limiter ?? limiterOf(options.concurrency ?? DEFAULT_CONCURRENCY);
  const entries = new Map<string, Entry>();
  // Одна страница оценивается один раз, сколько бы запросов ни пришло одновременно; ключ —
  // путь кэша, то есть вместе с сессией: тот же ключ новой сессии — другая страница.
  const building = new Map<string, Promise<boolean>>();
  let controller = new AbortController();

  const fileOf = (key: string, info: PageInfo): string =>
    join(blankDirIn(derivedDir, info.sessionId), blankFileName(key));

  const alive = (key: string, info: PageInfo): boolean => isAlive(source, key, info);

  /** Доля из кэша текущей версии; нет файла, не читается, другая версия — `undefined`. */
  async function readCached(file: string): Promise<number | null | undefined> {
    try {
      const parsed = cacheSchema.safeParse(
        JSON.parse(new TextDecoder().decode(await fs.readFile(file))),
      );
      return parsed.success && parsed.data.v === BLANK_DETECTOR_VERSION
        ? parsed.data.ratio
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Доля от детектора; его исключение — тоже сбой оценки, `null` (R6), а не зависший `pending`.
   * `cacheable: false` — срок обработки (B-21): исход «не успели» не свойство страницы.
   */
  async function ratioOf(
    bytes: Uint8Array,
    info: PageInfo,
  ): Promise<{ readonly ratio: number | null; readonly cacheable: boolean }> {
    try {
      return { ratio: await detector(bytes, info.pixelLimit), cacheable: true };
    } catch (error: unknown) {
      return { ratio: null, cacheable: !isImageTimeout(error) };
    }
  }

  async function detect(
    key: string,
    info: PageInfo,
    file: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    // Отмена проверяется до чтения, после чтения и после детектора — до `mkdir` и записи кэша:
    // отменённая оценка не оставляет ни каталога, ни вердикта. Через функцию: сужение типа после
    // `await` иначе считает флаг неизменным.
    const aborted = (): boolean => signal.aborted;
    if (aborted()) {
      return false;
    }
    const page = await source.readPage(key);
    if (aborted()) {
      return false;
    }
    const { ratio, cacheable } = page.ok
      ? await ratioOf(page.value, info)
      : { ratio: null, cacheable: false };
    if (aborted()) {
      return false;
    }
    // Кэш — по возможности: вердикт действует и тогда, когда записать его не удалось. Сбой
    // чтения страницы (не потеря — её отсеивает `alive`) может быть временным: вердикт «не
    // пусто» действует до перезапуска, но в кэш не пишется — следующее открытие оценит заново.
    // Так же — срок обработки (B-21).
    const encoded = new TextEncoder().encode(JSON.stringify({ v: BLANK_DETECTOR_VERSION, ratio }));
    const cached = cacheable
      ? await fs
          .mkdir(blankDirIn(derivedDir, info.sessionId))
          .then(() => writeFileAtomic(file, encoded, io))
          .then(
            () => true,
            () => false,
          )
      : false;
    // Пока страница оценивалась, её могли отбросить («Остановить», «Новая пачка»): такой
    // вердикт не действует и в кэше не остаётся.
    if (!alive(key, info)) {
      if (cached) {
        await fs.unlink(file).catch(() => undefined);
      }
      return false;
    }
    entries.set(key, { sessionId: info.sessionId, blank: isBlank(ratio) });
    return true;
  }

  return {
    verdicts: () => new Map([...entries].map(([key, entry]) => [key, entry.blank])),

    async load(keys) {
      await Promise.all(
        keys.map(async (key) => {
          const info = source.pageInfo(key);
          if (info === null || entries.get(key)?.sessionId === info.sessionId) {
            return;
          }
          const ratio = await readCached(fileOf(key, info));
          if (ratio !== undefined && alive(key, info)) {
            entries.set(key, { sessionId: info.sessionId, blank: isBlank(ratio) });
          }
        }),
      );
    },

    async ensure(key) {
      const info = source.pageInfo(key);
      if (info === null || entries.get(key)?.sessionId === info.sessionId) {
        return false;
      }
      const file = fileOf(key, info);
      const inFlight = building.get(file);
      if (inFlight !== undefined) {
        await inFlight;
        return false;
      }
      const { signal } = controller;
      const run = (async (): Promise<boolean> => {
        const ratio = await readCached(file);
        if (ratio !== undefined) {
          if (!alive(key, info)) {
            return false;
          }
          entries.set(key, { sessionId: info.sessionId, blank: isBlank(ratio) });
          return true;
        }
        return limited(() => detect(key, info, file, signal));
      })().finally(() => building.delete(file));
      building.set(file, run);
      return run;
    },

    prune() {
      pruneStale(entries, source);
    },

    abort() {
      controller.abort(new Error('оценка пустоты отменена'));
      controller = new AbortController();
    },

    async settle() {
      await Promise.allSettled([...building.values()]);
    },
  };
}
