import { join } from 'node:path';
import { z } from 'zod';
import { fail, ok, STRAIGHTEN_GEOMETRY_VERSION, type Result } from '@shared';
import { SKEW_DETECTOR_VERSION } from '../detect/skew';
import type { StraightenResult } from '../image/straighten';
import { isTempName, writeFileAtomic } from './atomic-file';
import { isAlive, pruneStale } from './liveness';
import {
  parseStraightFileName,
  straightDirIn,
  straightFileName,
  straightRecordName,
  UNKNOWN_DETECTOR,
  type StraightVersions,
} from './layout';
import type { PageInfo } from './session-store';
import { ioOf, listDir, type StorageOptions } from './storage-fs';
import type { ThumbnailSource } from './thumbnails';

// Выправленные страницы — производное с одной истиной и одним писателем (план M6, U11;
// KTD-11, KTD-12; ADR 0004, амендмент 2026-10-28; B-19). Файлы в `derived/<id сессии>/straight/`:
// пара JPEG `<ключ>.v<G>.d<D>.jpg` и запись о коррекции `<ключ>.v<G>.d<D>.json`, G — версия
// геометрии, D — детектора, которым получен профиль; прежний формат `<ключ>.v<G>.*` без детектора
// (до B-19) читается как пара с детектором «неизвестен». Статус «выправлена» определяет только
// запись: JPEG без записи — сирота (убирается при открытии), запись без файла или с другим
// размером — «оценки нет». Пары любой известной версии действительны для показа и сохранения,
// пока пересчёт не запишет текущую (AE13); годна для пропуска очереди только пара текущих версий
// (`isCurrentStraightened`). `resolve` отдаёт текущую пару, а без неё — самую новую действительную
// — единственный источник пути для протокола картинок, миниатюр и снимка PDF (страж
// `test/guards/straight-paths.test.ts`). Пишет сюда только очередь коррекции через `store`:
// сначала JPEG целиком, потом запись; прочие пары ключа удаляются после записи новой — по
// листингу каталога, потому что детекторы прежних пар наперёд не известны.

/** Запись о коррекции рядом с JPEG тех же версий. */
const recordSchema = z.strictObject({
  v: z.number().int().min(1),
  /** Версия детектора (B-19); записи до неё — без поля: детектор «неизвестен». */
  detector: z.number().int().min(1).optional(),
  encoding: z.string().min(1),
  /** Плотность, записанная в JPEG; `null` — не записана. */
  dpi: z.number().nullable(),
  file: z.strictObject({ name: z.string().min(1), bytes: z.number().int().nonnegative() }),
});

export type StraightenedSource = ThumbnailSource;

export interface StraightenedFile extends StraightVersions {
  /** Путь к выправленному JPEG. */
  readonly path: string;
  readonly bytes: number;
  readonly encoding: string;
  readonly dpi: number | null;
}

/** Пара текущих версий — геометрии и детектора: такую очередь пропускает (B-19, KTD-2). */
export const isCurrentStraightened = (file: StraightVersions): boolean =>
  file.version === STRAIGHTEN_GEOMETRY_VERSION && file.detector === SKEW_DETECTOR_VERSION;

export interface Straightened {
  /**
   * Пара страницы текущей сессии: текущих версий, а без неё — самая новая действительная любой
   * известной версии; `null` — выправленного вида нет (не выправлена, запись негодна, страницы
   * нет).
   */
  resolve(key: string): StraightenedFile | null;
  /**
   * Байты выправленного файла, который отдал `resolve` или снимок пакета (KTD-8): размер
   * сверяется с записью о коррекции (KTD-11); файла нет или он другого размера —
   * `pageUnavailable` с причиной `straightened`. Единственный читатель для протокола картинок,
   * миниатюр и сборки PDF.
   */
  read(file: StraightenedFile): Promise<Result<Uint8Array>>;
  /**
   * Открытие сессии: читает записи указанных страниц и сверяет размер файла; временные файлы
   * незаконченных записей, негодные пары и пары сверх выбранной убираются. Пары с геометрией
   * новее известной не трогаются и не отдаются.
   */
  load(keys: readonly string[]): Promise<void>;
  /**
   * Записывает исход коррекции текущих версий: JPEG, затем запись; после записи страница
   * проверяется снова — отброшенная не оставляет файлов (KTD-12). Прочие пары ключа удаляются
   * после. Сбой записи — исключение вызывающему (очередь переводит в `deferred`).
   */
  store(key: string, result: StraightenResult): Promise<void>;
  /**
   * Убирает выправленный вид страницы (B-19): вердикт текущих версий не «выправлять», а пара
   * прежних версий есть — страница следует вердикту. Файлы под `hold` — после отпускания.
   */
  discard(key: string): Promise<void>;
  /**
   * Держит прежние пары, пока на них ссылается снимок пакета (KTD-8; AE13): пересчёт пишет новую
   * пару, а прежнюю удаляет только после отпускания. Возвращает отпускание; вложенные удержания
   * считаются.
   */
  hold(): () => void;
  /** Забывает записи страниц, которых у источника больше нет. */
  prune(): void;
}

interface Entry {
  readonly sessionId: string;
  readonly file: StraightenedFile;
}

/** Пара известной геометрии — наша; новее — от будущего приложения, не трогаем. */
const isKnown = (pair: StraightVersions): boolean => pair.version <= STRAIGHTEN_GEOMETRY_VERSION;

const samePair = (left: StraightVersions, right: StraightVersions): boolean =>
  left.version === right.version && left.detector === right.detector;

/** Порядок предпочтения пар: текущая, затем по убыванию геометрии и детектора. */
function byPreference(left: StraightVersions, right: StraightVersions): number {
  const currentFirst = Number(isCurrentStraightened(right)) - Number(isCurrentStraightened(left));
  return currentFirst !== 0
    ? currentFirst
    : right.version - left.version || right.detector - left.detector;
}

export function createStraightened(
  derivedDir: string,
  source: StraightenedSource,
  options: StorageOptions = {},
): Straightened {
  const io = ioOf(options);
  const { fs } = io;
  const entries = new Map<string, Entry>();
  /** Снимков пакета, держащих прежние пары; отложенные удаления — по каталогу, ключу и версиям. */
  let held = 0;
  const postponed: {
    readonly dir: string;
    readonly key: string;
    readonly pair: StraightVersions;
  }[] = [];

  const dirOf = (info: PageInfo): string => straightDirIn(derivedDir, info.sessionId);
  const alive = (key: string, info: PageInfo): boolean => isAlive(source, key, info);

  /** Запись пары `pair` страницы, если она действительна: файл на месте и того размера. */
  async function readRecord(
    dir: string,
    key: string,
    pair: StraightVersions,
  ): Promise<StraightenedFile | null> {
    try {
      const parsed = recordSchema.safeParse(
        JSON.parse(
          new TextDecoder().decode(
            await fs.readFile(join(dir, straightRecordName(key, pair.version, pair.detector))),
          ),
        ),
      );
      if (
        !parsed.success ||
        parsed.data.v !== pair.version ||
        (parsed.data.detector ?? UNKNOWN_DETECTOR) !== pair.detector ||
        parsed.data.file.name !== straightFileName(key, pair.version, pair.detector)
      ) {
        return null;
      }
      const path = join(dir, parsed.data.file.name);
      if ((await fs.size(path)) !== parsed.data.file.bytes) {
        return null;
      }
      return {
        path,
        version: pair.version,
        detector: pair.detector,
        bytes: parsed.data.file.bytes,
        encoding: parsed.data.encoding,
        dpi: parsed.data.dpi,
      };
    } catch {
      return null;
    }
  }

  /** Пары каталога по ключу — из листинга; временные файлы убираются по пути. */
  async function pairsIn(dir: string): Promise<Map<string, StraightVersions[]>> {
    const byKey = new Map<string, StraightVersions[]>();
    for (const name of await listDir(fs, dir)) {
      if (isTempName(name)) {
        await fs.unlink(join(dir, name)).catch(() => undefined);
        continue;
      }
      const parsed = parseStraightFileName(name);
      if (parsed === null) {
        continue;
      }
      const pairs = byKey.get(parsed.key) ?? [];
      if (!pairs.some((pair) => samePair(pair, parsed))) {
        pairs.push({ version: parsed.version, detector: parsed.detector });
      }
      byKey.set(parsed.key, pairs);
    }
    return byKey;
  }

  async function removePair(dir: string, key: string, pair: StraightVersions): Promise<void> {
    for (const name of [
      straightFileName(key, pair.version, pair.detector),
      straightRecordName(key, pair.version, pair.detector),
    ]) {
      await fs.unlink(join(dir, name)).catch(() => undefined);
    }
  }

  /**
   * Прочие пары ключа известной геометрии — в удаление, под `hold` — в отложенные (снимок пакета
   * читает прежнюю пару по пути до отпускания; ревью сессий 3–4).
   */
  async function retireOthers(
    dir: string,
    key: string,
    keep: StraightVersions | null,
  ): Promise<void> {
    for (const pair of (await pairsIn(dir)).get(key) ?? []) {
      if (!isKnown(pair) || (keep !== null && samePair(pair, keep))) {
        continue;
      }
      if (held > 0) {
        postponed.push({ dir, key, pair });
      } else {
        await removePair(dir, key, pair);
      }
    }
  }

  return {
    resolve(key) {
      const entry = entries.get(key);
      const info = source.pageInfo(key);
      return entry !== undefined && info !== null && entry.sessionId === info.sessionId
        ? entry.file
        : null;
    },

    async load(keys) {
      const wanted = new Map<string, PageInfo>();
      for (const key of keys) {
        const info = source.pageInfo(key);
        if (info !== null) {
          wanted.set(key, info);
        }
      }
      const first = wanted.values().next();
      if (first.done) {
        return;
      }
      const dir = dirOf(first.value);
      const pairs = await pairsIn(dir);
      // Страницы независимы: записи читаются параллельно, а не по одной.
      await Promise.all(
        [...wanted].map(async ([key, info]) => {
          const known = (pairs.get(key) ?? []).filter(isKnown).sort(byPreference);
          let found: StraightenedFile | null = null;
          for (const pair of known) {
            if (found === null) {
              found = await readRecord(dir, key, pair);
              if (found !== null) {
                continue;
              }
            }
            // Сирота (JPEG без записи, запись без файла нужного размера) или лишняя пара сверх
            // выбранной (пересчёт прервался до чистки) — не отдаётся и убирается, чтобы не
            // копиться. Новее известной геометрии — не наша, не трогаем.
            await removePair(dir, key, pair);
          }
          if (found !== null && alive(key, info)) {
            entries.set(key, { sessionId: info.sessionId, file: found });
          }
        }),
      );
    },

    async read(file) {
      try {
        const bytes = await fs.readFile(file.path);
        return bytes.byteLength === file.bytes
          ? ok(bytes)
          : fail('pageUnavailable', { reason: 'straightened' });
      } catch {
        return fail('pageUnavailable', { reason: 'straightened' });
      }
    },

    async store(key, result) {
      const info = source.pageInfo(key);
      if (info === null) {
        return;
      }
      const dir = dirOf(info);
      const pair: StraightVersions = {
        version: STRAIGHTEN_GEOMETRY_VERSION,
        detector: SKEW_DETECTOR_VERSION,
      };
      const name = straightFileName(key, pair.version, pair.detector);
      const path = join(dir, name);
      // Каталог создаётся только у живой страницы (KTD-12).
      await fs.mkdir(dir);
      await writeFileAtomic(path, result.jpeg, io);
      const record = {
        v: pair.version,
        detector: pair.detector,
        encoding: result.encoding,
        dpi: result.dpi,
        file: { name, bytes: result.jpeg.byteLength },
      };
      try {
        await writeFileAtomic(
          join(dir, straightRecordName(key, pair.version, pair.detector)),
          new TextEncoder().encode(JSON.stringify(record)),
          io,
        );
      } catch (error) {
        // Запись не состоялась (`ENOSPC`): готовый JPEG без записи — сирота на полном диске до
        // следующего открытия; убирается сразу, отказ — вызывающему (ревью сессий 3–4). Прежняя
        // пара цела: у неё другое имя.
        await removePair(dir, key, pair);
        throw error;
      }
      // Пока шла запись, страницу могли отбросить: такой исход не действует и файлов не оставляет.
      if (!alive(key, info)) {
        await removePair(dir, key, pair);
        return;
      }
      entries.set(key, {
        sessionId: info.sessionId,
        file: {
          path,
          version: pair.version,
          detector: pair.detector,
          bytes: result.jpeg.byteLength,
          encoding: result.encoding,
          dpi: result.dpi,
        },
      });
      // Прочие пары — после записи новой (AE13): до неё показывалась прежняя. Пока снимок пакета
      // держит прежние файлы, удаление откладывается до отпускания: иначе сборка PDF по снимку не
      // нашла бы файл посреди записи (ревью сессий 3–4).
      await retireOthers(dir, key, pair);
    },

    async discard(key) {
      const info = source.pageInfo(key);
      entries.delete(key);
      if (info === null) {
        return;
      }
      await retireOthers(dirOf(info), key, null);
    },

    hold() {
      held += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        held -= 1;
        if (held === 0) {
          const due = postponed.splice(0);
          void Promise.all(due.map((item) => removePair(item.dir, item.key, item.pair)));
        }
      };
    },

    prune() {
      pruneStale(entries, source);
    },
  };
}
