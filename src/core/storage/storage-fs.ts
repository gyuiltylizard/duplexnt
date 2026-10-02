import * as nodeFs from 'node:fs/promises';
import type { DomainError } from '@shared';
import type { AtomicFs, RetryPolicy } from './atomic-file';

// Срез файловой системы для хранилища и перевод её ошибок в доменные коды — одним помощником
// (журнал M1, сессия 2). Всё, что хранилище меняет на диске, идёт через этот срез: тесты подменяют
// его, чтобы ввести сбой на любом шаге записи.

export interface StorageFs extends AtomicFs {
  /** Создаёт каталог вместе с родителями; существующий — не ошибка. */
  mkdir(path: string): Promise<void>;
  /** Удаляет только пустой каталог. */
  rmdir(path: string): Promise<void>;
  /** Удаляет каталог со всем содержимым. Только для производного кэша. */
  removeTree(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  /** Размер файла в байтах. */
  size(path: string): Promise<number>;
  /** Свободное место на томе, где лежит путь, в байтах. */
  freeBytes(path: string): Promise<number>;
}

export const realStorageFs: StorageFs = {
  open: (path, flags) => nodeFs.open(path, flags),
  rename: (from, to) => nodeFs.rename(from, to),
  unlink: (path) => nodeFs.unlink(path),
  readdir: (path) => nodeFs.readdir(path),
  mkdir: async (path) => {
    await nodeFs.mkdir(path, { recursive: true });
  },
  rmdir: (path) => nodeFs.rmdir(path),
  removeTree: (path) => nodeFs.rm(path, { recursive: true, force: true }),
  // Вид на те же байты без методов `Buffer`: наружу хранилище отдаёт обычный `Uint8Array`.
  readFile: async (path) => {
    const buffer = await nodeFs.readFile(path);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  },
  size: async (path) => (await nodeFs.stat(path)).size,
  freeBytes: async (path) => {
    const stats = await nodeFs.statfs(path);
    return stats.bavail * stats.bsize;
  },
};

export interface StorageOptions {
  readonly fs?: StorageFs;
  readonly retry?: Partial<RetryPolicy>;
}

export function fsErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

export const isMissing = (error: unknown): boolean => fsErrorCode(error) === 'ENOENT';

/** Имена в каталоге; каталога нет — пусто. */
export async function listDir(fs: StorageFs, path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

/** Отказ хранилища; несёт доменную ошибку для конверта — как `TransportError` у сети. */
export class StorageError extends Error {
  constructor(readonly failure: DomainError) {
    super(failure.code);
    this.name = 'StorageError';
  }
}

const FULL_CODES = new Set(['ENOSPC', 'EDQUOT']);

/**
 * Любая ошибка, пойманная на записи, — в доменный код. Нехватка места отличима от остального:
 * ей пользователь может помочь сам. Сообщение ошибки наружу не идёт — в нём бывают пути.
 */
export function storageFailure(error: unknown): DomainError {
  if (error instanceof StorageError) {
    return error.failure;
  }
  const reason = fsErrorCode(error);
  return FULL_CODES.has(reason)
    ? { code: 'storageFull' }
    : { code: 'storageFailed', details: { reason } };
}
