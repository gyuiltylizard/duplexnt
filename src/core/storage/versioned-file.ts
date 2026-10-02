import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { renameWithRetry, writeFileAtomic } from './atomic-file';
import { isMissing, type StorageFs, type StorageIo, type StorageOptions } from './storage-fs';

// Файл с маркером версии: журнал сессии, настройки, незакрытые задания (ADR 0004; план M1,
// KTD-34, KTD-35). Правила одни на все три:
//
// - маркер — поле `version` верхнего уровня; его имя не меняется никогда. Он читается отдельным
//   терпимым шагом ДО проверки схемы: данные более новой версии могут выглядеть как угодно;
// - схема строгая: неизвестное поле при текущей версии — тоже несовместимость. Файл с неизвестным
//   полем несовместим, даже когда в нём есть и другие ошибки;
// - несовместимый файл не переписывается и не отодвигается; нечитаемый — отодвигается, но не
//   удаляется.

export const VERSION_FIELD = 'version';

export type VersionedRead<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'incompatible'; readonly reason: 'newerVersion' | 'unknownField' }
  | { readonly kind: 'unreadable'; readonly reason: 'empty' | 'notJson' | 'schema' };

export type VersionedParse<T> = Exclude<VersionedRead<T>, { kind: 'missing' }>;

export function parseVersioned<T>(
  bytes: Uint8Array,
  schema: z.ZodType<T>,
  version: number,
): VersionedParse<T> {
  if (bytes.byteLength === 0) {
    return { kind: 'unreadable', reason: 'empty' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { kind: 'unreadable', reason: 'notJson' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'unreadable', reason: 'schema' };
  }

  const marker = (raw as Record<string, unknown>)[VERSION_FIELD];
  if (typeof marker === 'number' && marker > version) {
    return { kind: 'incompatible', reason: 'newerVersion' };
  }

  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return { kind: 'ok', value: parsed.data };
  }
  return parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys')
    ? { kind: 'incompatible', reason: 'unknownField' }
    : { kind: 'unreadable', reason: 'schema' };
}

export async function readVersioned<T>(
  fs: StorageFs,
  path: string,
  schema: z.ZodType<T>,
  version: number,
): Promise<VersionedRead<T>> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(path);
  } catch (error) {
    if (isMissing(error)) {
      return { kind: 'missing' };
    }
    throw error;
  }
  return parseVersioned(bytes, schema, version);
}

/** Читаемый человеком JSON: данные пользователя достаются без приложения. */
export function serializeVersioned(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeVersioned(
  path: string,
  value: unknown,
  options: StorageOptions,
): Promise<void> {
  return writeFileAtomic(path, serializeVersioned(value), options);
}

const SET_ASIDE_SUFFIX = /\.unreadable-[0-9a-f]{12}$/;

/** Отодвинутая копия нечитаемого файла `baseName`. */
export function isSetAsideName(name: string, baseName: string): boolean {
  return name.startsWith(`${baseName}.`) && SET_ASIDE_SUFFIX.test(name.slice(baseName.length));
}

/**
 * Отодвигает нечитаемый файл под уникальным именем рядом с прежним. Файла уже нет — не ошибка:
 * повторная сверка после сбоя приходит сюда второй раз.
 */
export async function setAside(path: string, options: StorageIo): Promise<void> {
  try {
    await renameWithRetry(path, `${path}.unreadable-${randomBytes(6).toString('hex')}`, options);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}
