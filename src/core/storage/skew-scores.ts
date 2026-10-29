import { join } from 'node:path';
import { z } from 'zod';
import {
  isSkewProfile,
  SKEW_OUTCOMES,
  STRAIGHTEN_GEOMETRY_VERSION,
  type SkewMeasure,
  type SkewVerdict,
  type SkewVerdicts,
} from '@shared';
import { SKEW_DETECTOR_VERSION } from '../detect/skew';
import type { ImageWorker } from '../image/image-worker';
import { writeFileAtomic } from './atomic-file';
import { skewDirIn, skewFileName } from './layout';
import { isAlive, pruneStale } from './liveness';
import { limiterOf, type Limiter } from './limiter';
import type { PageInfo } from './session-store';
import { ioOf, type StorageOptions } from './storage-fs';
import type { ThumbnailSource } from './thumbnails';

// Оценки перекоса подачи — производное по образцу оценок пустых страниц (план M6, U5; KTD-4,
// KTD-11, KTD-12; ADR 0004, амендмент 2026-10-28): карта `ключ → вердикт` в памяти и кэш
// `derived/<id сессии>/skew/<ключ>.json` с версиями геометрии и детектора, профилем, контрастом
// и причиной. Запись пишет только стадия измерения и только один раз для версии; кэш другой
// версии или мусор — пересчёт. В журнал оценка не пишется; в каталог сессии модуль не пишет.
//
// Измерение идёт через общий лимитер производного с низким приоритетом: миниатюры и вердикты
// пустоты, которых человек ждёт глазами, его обгоняют. Сбой измерения — не JPEG, предел
// пикселей, ошибка декодирования, исключение исполнителя — тоже результат: `unmeasurable`
// (R3), страница остаётся оригиналом. Отмена (`abort`) — исключение: вердикта нет, кэша нет,
// страница ждёт следующего `ensure`.

const DEFAULT_CONCURRENCY = 2;

const profileSchema = z.custom<SkewMeasure['profile']>(
  (value) => value === null || isSkewProfile(value),
);

/** Файл кэша (KTD-11): версии, исход, профиль, контраст, веер, причина и размер исходника. */
const cacheSchema = z.strictObject({
  v: z.strictObject({ geometry: z.number().int(), detector: z.number().int() }),
  outcome: z.enum(SKEW_OUTCOMES),
  profile: profileSchema,
  contrast: z.strictObject({ before: z.number(), after: z.number(), ratio: z.number() }).nullable(),
  fanMm: z.number().nullable(),
  reason: z.string().nullable(),
  source: z.strictObject({ bytes: z.number().int() }),
});

type CacheRecord = z.infer<typeof cacheSchema>;

/** Откуда оценки берут страницы — тот же срез, что у миниатюр; хранилище сессии подходит. */
export type SkewScoreSource = ThumbnailSource;

/** Измерение страницы — `ImageWorker.measure` (KTD-10): в тестах службы — заглушка. */
export type SkewMeasurer = ImageWorker['measure'];

export interface SkewScoresOptions extends StorageOptions {
  /** Общий лимитер производного (KTD-4); без него — свой, на `concurrency` задач. */
  readonly limiter?: Limiter;
  readonly concurrency?: number;
}

export interface SkewScores {
  /** Вердикты страниц текущей сессии; ключа нет — оценки ещё нет. */
  verdicts(): SkewVerdicts;
  /**
   * Читает кэш указанных страниц без измерения: кэш текущих версий — в карту, остальное —
   * как не было. Для открытия: лента получает статусы до первого снимка.
   */
  load(keys: readonly string[]): Promise<void>;
  /**
   * Оценка страницы: уже есть или строится — ничего; иначе кэш, потом измерение с низким
   * приоритетом, результат — в карту и кэш (по возможности). `true` — в карте появился новый
   * вердикт. Страница, которой у источника уже нет (отброшена, потеряна), вердикта не получает;
   * отменённое измерение — тоже `false`.
   */
  ensure(key: string): Promise<boolean>;
  /** Забывает вердикты страниц, которых у источника больше нет («Остановить», «Новая пачка»). */
  prune(): void;
  /** Отменяет идущие и ждущие измерения (KTD-12); следующие `ensure` работают как обычно. */
  abort(): void;
  /** Ждёт конца всех идущих измерений — отменённых или нет. */
  settle(): Promise<void>;
}

interface Entry {
  readonly sessionId: string;
  readonly verdict: SkewVerdict;
}

const UNMEASURABLE: SkewVerdict = { outcome: 'unmeasurable', profile: null };

/** Запись кэша из результата измерения; `null` (сбой декода) — `unmeasurable` с причиной. */
function recordOf(measure: SkewMeasure | null, bytes: number, reason: string | null): CacheRecord {
  const v = { geometry: STRAIGHTEN_GEOMETRY_VERSION, detector: SKEW_DETECTOR_VERSION };
  return measure === null
    ? {
        v,
        outcome: 'unmeasurable',
        profile: null,
        contrast: null,
        fanMm: null,
        reason: reason ?? 'страница не декодируется',
        source: { bytes },
      }
    : {
        v,
        outcome: measure.outcome,
        profile: measure.profile,
        contrast: measure.contrast,
        fanMm: measure.fanMm,
        reason: measure.reason,
        source: { bytes },
      };
}

export function createSkewScores(
  derivedDir: string,
  source: SkewScoreSource,
  measurer: SkewMeasurer,
  options: SkewScoresOptions = {},
): SkewScores {
  const io = ioOf(options);
  const { fs } = io;
  const limited = options.limiter ?? limiterOf(options.concurrency ?? DEFAULT_CONCURRENCY);
  const entries = new Map<string, Entry>();
  // Одна страница измеряется один раз, сколько бы запросов ни пришло одновременно; ключ — путь
  // кэша, то есть вместе с сессией: тот же ключ новой сессии — другая страница.
  const building = new Map<string, Promise<boolean>>();
  // Отмена — на все измерения в полёте и в очереди разом; после неё — новый сигнал.
  let controller = new AbortController();

  const fileOf = (key: string, info: PageInfo): string =>
    join(skewDirIn(derivedDir, info.sessionId), skewFileName(key));

  const alive = (key: string, info: PageInfo): boolean => isAlive(source, key, info);

  const verdictOf = (record: CacheRecord): SkewVerdict => ({
    outcome: record.outcome,
    profile: record.profile,
  });

  /** Вердикт из кэша текущих версий; нет файла, не читается, другая версия — `undefined`. */
  async function readCached(file: string): Promise<SkewVerdict | undefined> {
    try {
      const parsed = cacheSchema.safeParse(
        JSON.parse(new TextDecoder().decode(await fs.readFile(file))),
      );
      return parsed.success &&
        parsed.data.v.geometry === STRAIGHTEN_GEOMETRY_VERSION &&
        parsed.data.v.detector === SKEW_DETECTOR_VERSION
        ? verdictOf(parsed.data)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function measure(
    key: string,
    info: PageInfo,
    file: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    // Отменённое, пока ждало места в лимитере, — не читает страницу.
    signal.throwIfAborted();
    const page = await source.readPage(key);
    if (!page.ok) {
      // Сбой чтения (не потеря — её отсеивает `alive`) может быть временным: «не измерена» до
      // перезапуска, в кэш не пишется — следующее открытие измерит заново. Отказ по закрытию
      // сессии — не сбой страницы: закрытие могло не состояться, и страница дождётся следующего
      // `ensure` (ревью сессий 3–4).
      if (!alive(key, info) || page.error.details?.reason === 'closing') {
        return false;
      }
      entries.set(key, { sessionId: info.sessionId, verdict: UNMEASURABLE });
      return true;
    }
    let record: CacheRecord;
    try {
      const measured = await measurer(page.value, info.pixelLimit, { signal });
      record = recordOf(measured, page.value.byteLength, null);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      // Исключение исполнителя — тоже сбой измерения, `unmeasurable` (R3), а не вечный `pending`.
      record = recordOf(null, page.value.byteLength, `сбой измерения: ${String(error)}`);
    }
    signal.throwIfAborted();
    // Каталог создаётся только у живой страницы (KTD-12): «Остановить» и «Новая пачка» не
    // должны получить пересозданный каталог закрытой сессии.
    if (!alive(key, info)) {
      return false;
    }
    const encoded = new TextEncoder().encode(JSON.stringify(record));
    // Кэш — по возможности: вердикт действует и тогда, когда записать его не удалось.
    const cached = await fs
      .mkdir(skewDirIn(derivedDir, info.sessionId))
      .then(() => writeFileAtomic(file, encoded, io))
      .then(
        () => true,
        () => false,
      );
    if (!alive(key, info)) {
      if (cached) {
        await fs.unlink(file).catch(() => undefined);
      }
      return false;
    }
    entries.set(key, { sessionId: info.sessionId, verdict: verdictOf(record) });
    return true;
  }

  return {
    verdicts: () => new Map([...entries].map(([key, entry]) => [key, entry.verdict])),

    async load(keys) {
      await Promise.all(
        keys.map(async (key) => {
          const info = source.pageInfo(key);
          if (info === null || entries.get(key)?.sessionId === info.sessionId) {
            return;
          }
          const verdict = await readCached(fileOf(key, info));
          if (verdict !== undefined && alive(key, info)) {
            entries.set(key, { sessionId: info.sessionId, verdict });
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
        const verdict = await readCached(file);
        if (verdict !== undefined) {
          if (!alive(key, info)) {
            return false;
          }
          entries.set(key, { sessionId: info.sessionId, verdict });
          return true;
        }
        try {
          return await limited(() => measure(key, info, file, signal), 'low');
        } catch (error) {
          // Отмена — не сбой: вердикта нет, страница ждёт следующего `ensure`.
          if (signal.aborted) {
            return false;
          }
          throw error;
        }
      })().finally(() => building.delete(file));
      building.set(file, run);
      return run;
    },

    prune() {
      pruneStale(entries, source);
    },

    abort() {
      controller.abort(new Error('измерение перекоса отменено'));
      controller = new AbortController();
    },

    async settle() {
      await Promise.allSettled([...building.values()]);
    },
  };
}
