import { join } from 'node:path';
import { z } from 'zod';
import { STRAIGHTEN_GEOMETRY_VERSION } from '@shared';
import type { StraightenResult } from '../image/straighten';
import { isTempName, writeFileAtomic } from './atomic-file';
import {
  parseStraightFileName,
  straightDirIn,
  straightFileName,
  straightRecordName,
} from './layout';
import type { PageInfo } from './session-store';
import { ioOf, listDir, type StorageOptions } from './storage-fs';
import type { ThumbnailSource } from './thumbnails';

// Выправленные страницы — производное с одной истиной и одним писателем (план M6, U11;
// KTD-11, KTD-12; ADR 0004, амендмент 2026-10-28). Файлы в `derived/<id сессии>/straight/`:
// JPEG `<ключ>.v<N>.jpg` и запись о коррекции `<ключ>.v<N>.json`, N — версия геометрии. Статус
// «выправлена» определяет только запись: JPEG без записи — сирота (убирается при открытии),
// запись без файла или с другим размером — «оценки нет». Записи любой известной версии
// действительны для показа и сохранения, пока пересчёт не запишет новую (AE13); `resolve`
// отдаёт самую новую действительную — единственный источник пути для протокола картинок,
// миниатюр и снимка PDF (страж `test/guards/straight-paths.test.ts`). Пишет сюда только
// очередь коррекции через `store`: сначала JPEG целиком, потом запись; файлы прежних версий
// удаляются после записи новой.

/** Запись о коррекции рядом с JPEG той же версии. */
const recordSchema = z.strictObject({
  v: z.number().int().min(1),
  encoding: z.string().min(1),
  /** Плотность, записанная в JPEG; `null` — не записана. */
  dpi: z.number().nullable(),
  file: z.strictObject({ name: z.string().min(1), bytes: z.number().int().nonnegative() }),
});

export type StraightenedSource = ThumbnailSource;

export interface StraightenedFile {
  /** Путь к выправленному JPEG. */
  readonly path: string;
  /** Версия геометрии, которой он получен. */
  readonly version: number;
  readonly bytes: number;
  readonly encoding: string;
  readonly dpi: number | null;
}

export interface Straightened {
  /**
   * Самая новая действительная запись страницы текущей сессии любой известной версии; `null`
   * — выправленного вида нет (не выправлена, запись негодна, страницы нет).
   */
  resolve(key: string): StraightenedFile | null;
  /**
   * Открытие сессии: читает записи указанных страниц и сверяет размер файла; временные файлы
   * незаконченных записей и JPEG без записи убираются. Записи новее известной версии не
   * трогаются и не отдаются.
   */
  load(keys: readonly string[]): Promise<void>;
  /**
   * Записывает исход коррекции текущей версии: JPEG, затем запись; после записи страница
   * проверяется снова — отброшенная не оставляет файлов (KTD-12). Файлы прежних версий
   * удаляются после. Сбой записи — исключение вызывающему (очередь переводит в `deferred`).
   */
  store(key: string, result: StraightenResult): Promise<void>;
  /** Забывает записи страниц, которых у источника больше нет. */
  prune(): void;
}

interface Entry {
  readonly sessionId: string;
  readonly file: StraightenedFile;
}

export function createStraightened(
  derivedDir: string,
  source: StraightenedSource,
  options: StorageOptions = {},
): Straightened {
  const io = ioOf(options);
  const { fs } = io;
  const entries = new Map<string, Entry>();

  const dirOf = (info: PageInfo): string => straightDirIn(derivedDir, info.sessionId);
  const alive = (key: string, info: PageInfo): boolean =>
    source.pageInfo(key)?.sessionId === info.sessionId;

  /** Запись версии `version` страницы, если она действительна: файл на месте и того размера. */
  async function readRecord(
    dir: string,
    key: string,
    version: number,
  ): Promise<StraightenedFile | null> {
    try {
      const parsed = recordSchema.safeParse(
        JSON.parse(
          new TextDecoder().decode(await fs.readFile(join(dir, straightRecordName(key, version)))),
        ),
      );
      if (
        !parsed.success ||
        parsed.data.v !== version ||
        parsed.data.file.name !== straightFileName(key, version)
      ) {
        return null;
      }
      const path = join(dir, parsed.data.file.name);
      if ((await fs.size(path)) !== parsed.data.file.bytes) {
        return null;
      }
      return {
        path,
        version,
        bytes: parsed.data.file.bytes,
        encoding: parsed.data.encoding,
        dpi: parsed.data.dpi,
      };
    } catch {
      return null;
    }
  }

  /** Имена файлов каталога по ключу и версии; временные — убираются по пути. */
  async function filesIn(dir: string): Promise<Map<string, Map<number, string[]>>> {
    const byKey = new Map<string, Map<number, string[]>>();
    for (const name of await listDir(fs, dir)) {
      if (isTempName(name)) {
        await fs.unlink(join(dir, name)).catch(() => undefined);
        continue;
      }
      const parsed = parseStraightFileName(name);
      if (parsed === null) {
        continue;
      }
      const versions = byKey.get(parsed.key) ?? new Map<number, string[]>();
      versions.set(parsed.version, [...(versions.get(parsed.version) ?? []), name]);
      byKey.set(parsed.key, versions);
    }
    return byKey;
  }

  async function removeVersion(dir: string, key: string, version: number): Promise<void> {
    for (const name of [straightFileName(key, version), straightRecordName(key, version)]) {
      await fs.unlink(join(dir, name)).catch(() => undefined);
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
      const files = await filesIn(dir);
      for (const [key, info] of wanted) {
        const versions = [...(files.get(key)?.keys() ?? [])]
          .filter((version) => version <= STRAIGHTEN_GEOMETRY_VERSION)
          .sort((p, q) => q - p);
        let found: StraightenedFile | null = null;
        for (const version of versions) {
          found = await readRecord(dir, key, version);
          if (found !== null) {
            break;
          }
          // Сирота: JPEG без записи или запись без файла нужного размера — не отдаётся и
          // убирается, чтобы не копиться. Новее известной версии — не наша, не трогаем.
          await removeVersion(dir, key, version);
        }
        if (found !== null && alive(key, info)) {
          entries.set(key, { sessionId: info.sessionId, file: found });
        }
      }
    },

    async store(key, result) {
      const info = source.pageInfo(key);
      if (info === null) {
        return;
      }
      const dir = dirOf(info);
      const version = STRAIGHTEN_GEOMETRY_VERSION;
      const name = straightFileName(key, version);
      const path = join(dir, name);
      // Каталог создаётся только у живой страницы (KTD-12).
      await fs.mkdir(dir);
      await writeFileAtomic(path, result.jpeg, io);
      const record = {
        v: version,
        encoding: result.encoding,
        dpi: result.dpi,
        file: { name, bytes: result.jpeg.byteLength },
      };
      await writeFileAtomic(
        join(dir, straightRecordName(key, version)),
        new TextEncoder().encode(JSON.stringify(record)),
        io,
      );
      // Пока шла запись, страницу могли отбросить: такой исход не действует и файлов не оставляет.
      if (!alive(key, info)) {
        await removeVersion(dir, key, version);
        return;
      }
      entries.set(key, {
        sessionId: info.sessionId,
        file: {
          path,
          version,
          bytes: result.jpeg.byteLength,
          encoding: result.encoding,
          dpi: result.dpi,
        },
      });
      // Прежние версии — после записи новой (AE13): до неё показывалась старая. Новее известной
      // (от будущего приложения) — не наша, не трогаем.
      for (const old of [...((await filesIn(dir)).get(key)?.keys() ?? [])]) {
        if (old < version) {
          await removeVersion(dir, key, old);
        }
      }
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
