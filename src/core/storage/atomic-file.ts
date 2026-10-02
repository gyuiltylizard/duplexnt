import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Атомарная запись и удаление — один помощник, на котором стоит всё хранилище (план M1, KTD-18,
// KTD-19, KTD-20). Запись: временный файл рядом с конечным → `fsync` → закрытие → переименование.
// Сбой на любом шаге до переименования оставляет прежний файл нетронутым. `fsync` каталога на
// Windows не выполняется: отключение питания может откатить последнее переименование, и сверка
// при запуске с этим живёт.

export interface AtomicFileHandle {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Срез файловой системы, которым пользуется помощник; в тестах подменяется для сбоев. */
export interface AtomicFs {
  open(path: string, flags: 'wx'): Promise<AtomicFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

export interface RetryPolicy {
  /** Сколько всего можно прождать между попытками переименования. */
  readonly ceilingMs: number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface AtomicOptions {
  readonly fs?: AtomicFs;
  readonly retry?: Partial<RetryPolicy>;
}

export interface RemovalReport {
  readonly removed: readonly string[];
  /** Файлы, которые удалить не удалось: вызывающий оставляет пометку об удалении в журнале. */
  readonly failed: readonly { readonly name: string; readonly code: string }[];
}

const realFs: AtomicFs = {
  open: (path, flags) => nodeFs.open(path, flags),
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: (path) => nodeFs.unlink(path),
  readdir: (path) => nodeFs.readdir(path),
};

// Антивирус и индексатор Windows держат только что созданный файл открытым: переименование
// отказывает этими кодами и проходит через мгновение (тот же список повторяет graceful-fs).
// `ENOSPC` и всё остальное повтором не лечится.
const RETRIED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_CEILING_MS = 5000;
const RETRY_FIRST_DELAY_MS = 10;
const RETRY_MAX_DELAY_MS = 250;

const TEMP_SUFFIX = /\.[0-9a-f]{12}\.tmp$/;

/** Временный файл записи: конечное имя, случайный хвост, `.tmp`. Страницей не считается. */
export function isTempName(name: string): boolean {
  return TEMP_SUFFIX.test(name);
}

function tempPathFor(path: string): string {
  return join(dirname(path), `${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

/** Переименование файла или каталога с ограниченными повторами при `EPERM`, `EBUSY`, `EACCES`. */
export async function renameWithRetry(
  from: string,
  to: string,
  options: AtomicOptions = {},
): Promise<void> {
  const fs = options.fs ?? realFs;
  const ceilingMs = options.retry?.ceilingMs ?? RETRY_CEILING_MS;
  const now = options.retry?.now ?? Date.now;
  const sleep = options.retry?.sleep ?? ((ms: number) => delay(ms));

  const startedAt = now();
  let pause = RETRY_FIRST_DELAY_MS;
  for (;;) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const waited = now() - startedAt;
      if (!RETRIED_CODES.has(errorCode(error)) || waited + pause > ceilingMs) {
        throw error;
      }
      await sleep(pause);
      pause = Math.min(pause * 2, RETRY_MAX_DELAY_MS);
    }
  }
}

async function writeAll(handle: AtomicFileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) {
      throw Object.assign(new Error('запись не продвигается: записано 0 байт'), { code: 'EIO' });
    }
    offset += bytesWritten;
  }
}

async function writeAtomic(
  path: string,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: AtomicOptions,
): Promise<number> {
  const fs = options.fs ?? realFs;
  const tempPath = tempPathFor(path);
  let written = 0;

  try {
    const handle = await fs.open(tempPath, 'wx');
    try {
      for await (const chunk of source) {
        await writeAll(handle, chunk);
        written += chunk.byteLength;
      }
      await handle.sync();
    } catch (error) {
      // Ошибка закрытия не должна заслонить причину сбоя.
      await handle.close().catch(() => undefined);
      throw error;
    }
    await handle.close();
    await renameWithRetry(tempPath, path, options);
  } catch (error) {
    // Уборка — по возможности: оставшийся временный файл удалит сверка при запуске.
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
  return written;
}

/** Записывает файл целиком: либо новое содержимое, либо прежнее — половины не бывает. */
export async function writeFileAtomic(
  path: string,
  data: Uint8Array,
  options: AtomicOptions = {},
): Promise<void> {
  await writeAtomic(path, [data], options);
}

/**
 * Записывает поток в файл; возвращает число байт. Оборванный поток файла с конечным именем
 * не даёт: до переименования дело не доходит.
 */
export function writeStreamAtomic(
  path: string,
  source: AsyncIterable<Uint8Array>,
  options: AtomicOptions = {},
): Promise<number> {
  return writeAtomic(path, source, options);
}

/**
 * Удаляет из каталога файлы, имя которых начинается с префикса ключа И подходит под шаблон
 * ключа. Посторонние файлы не трогает. Неудаляемый файл попадает в отчёт: удаление одной попыткой,
 * без повторов, — его доводит до конца сверка при запуске (KTD-20).
 */
export async function removeByPrefix(
  directory: string,
  prefix: string,
  pattern: RegExp,
  options: AtomicOptions = {},
): Promise<RemovalReport> {
  if (prefix === '') {
    throw new Error('удаление по префиксу: пустой префикс удалил бы все страницы каталога');
  }
  const fs = options.fs ?? realFs;

  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { removed: [], failed: [] };
    }
    throw error;
  }

  const removed: string[] = [];
  const failed: { name: string; code: string }[] = [];
  for (const name of names.filter((it) => it.startsWith(prefix) && pattern.test(it)).sort()) {
    try {
      await fs.unlink(join(directory, name));
      removed.push(name);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') {
        removed.push(name);
      } else {
        failed.push({ name, code });
      }
    }
  }
  return { removed, failed };
}
