import { join } from 'node:path';
import { z } from 'zod';
import type { BlankVerdicts } from '@shared';
import { BLANK_DETECTOR_VERSION, isBlank, type BlankDetector } from '../detect/blank';
import { writeFileAtomic } from './atomic-file';
import { blankDirIn, blankFileName } from './layout';
import { limiterOf } from './limiter';
import type { PageInfo } from './session-store';
import { ioOf, type StorageOptions } from './storage-fs';
import type { ThumbnailSource } from './thumbnails';

// Оценки пустых страниц — производное по образцу миниатюр (план M4, U4, KTD3; ADR 0004, амендмент
// 2026-10-22): карта `ключ → вердикт` в памяти и кэш `derived/<id сессии>/blank/<ключ>.json` с
// долей и версией детектора. В журнал оценка не пишется; кэш с другой версией пересчитывается;
// в каталог сессии модуль не пишет. Сбой детектора (не JPEG, предел пикселей, ошибка чтения) —
// тоже результат: `ratio: null`, страница не пуста и оценки больше не ждёт (R6).
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
  /** Сколько страниц оценивается одновременно. */
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
  const limited = limiterOf(options.concurrency ?? DEFAULT_CONCURRENCY);
  const entries = new Map<string, Entry>();
  // Одна страница оценивается один раз, сколько бы запросов ни пришло одновременно; ключ —
  // путь кэша, то есть вместе с сессией: тот же ключ новой сессии — другая страница.
  const building = new Map<string, Promise<boolean>>();

  const fileOf = (key: string, info: PageInfo): string =>
    join(blankDirIn(derivedDir, info.sessionId), blankFileName(key));

  const alive = (key: string, info: PageInfo): boolean =>
    source.pageInfo(key)?.sessionId === info.sessionId;

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

  async function detect(key: string, info: PageInfo, file: string): Promise<boolean> {
    const page = await source.readPage(key);
    const ratio = page.ok ? await detector(page.value, info.pixelLimit) : null;
    // Кэш — по возможности: вердикт действует и тогда, когда записать его не удалось.
    const encoded = new TextEncoder().encode(JSON.stringify({ v: BLANK_DETECTOR_VERSION, ratio }));
    const cached = await fs
      .mkdir(blankDirIn(derivedDir, info.sessionId))
      .then(() => writeFileAtomic(file, encoded, io))
      .then(
        () => true,
        () => false,
      );
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
      const run = (async (): Promise<boolean> => {
        const ratio = await readCached(file);
        if (ratio !== undefined) {
          if (!alive(key, info)) {
            return false;
          }
          entries.set(key, { sessionId: info.sessionId, blank: isBlank(ratio) });
          return true;
        }
        return limited(() => detect(key, info, file));
      })().finally(() => building.delete(file));
      building.set(file, run);
      return run;
    },

    prune() {
      for (const [key, entry] of entries) {
        if (source.pageInfo(key)?.sessionId !== entry.sessionId) {
          entries.delete(key);
        }
      }
    },
  };
}
