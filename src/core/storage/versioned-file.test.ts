import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { ioOf, realStorageFs, StorageError } from './storage-fs';
import { writeVersioned } from './versioned-file';

// Запись файла с маркером версии — с проверкой структуры до и после (CLAUDE.md, «Данные
// пользователя священны»): то, что приложение не смогло бы прочитать обратно, оно не записывает.

const VERSION = 1;
const schema = z.strictObject({ version: z.literal(VERSION), count: z.number().int().min(0) });
type Value = z.infer<typeof schema>;

describe('writeVersioned', () => {
  it('годное значение записано и читается обратно', async () => {
    const path = join(await makeTempDataRoot(), 'file.json');

    await writeVersioned(path, schema, VERSION, { version: 1, count: 3 }, ioOf({}));

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, count: 3 });
  });

  it.each([
    ['лишнее поле', { version: 1, count: 3, extra: true }],
    ['значение вне диапазона', { version: 1, count: -1 }],
    ['чужая версия', { version: 2, count: 3 }],
  ])('%s — отказ до записи, прежний файл цел', async (_title, value) => {
    const root = await makeTempDataRoot();
    const path = join(root, 'file.json');
    await writeFile(path, 'прежнее');
    const { fs, calls } = interceptFs(realStorageFs);

    const failure = writeVersioned(path, schema, VERSION, value as Value, ioOf({ fs }));

    await expect(failure).rejects.toBeInstanceOf(StorageError);
    await expect(failure).rejects.toMatchObject({
      failure: { code: 'storageFailed', details: { reason: 'schema' } },
    });
    expect(calls).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe('прежнее');
    expect(await readdir(root)).toEqual(['file.json']);
  });

  it('записанное, которое не читается обратно, — отказ', async () => {
    const path = join(await makeTempDataRoot(), 'file.json');
    const fs = {
      ...realStorageFs,
      // Диск вернул не то, что на него записали.
      readFile: () => Promise.resolve(new TextEncoder().encode('{ "version": 1, "count": ')),
    };

    await expect(
      writeVersioned(path, schema, VERSION, { version: 1, count: 3 }, ioOf({ fs })),
    ).rejects.toMatchObject({ failure: { code: 'storageFailed', details: { reason: 'verify' } } });
  });

  it('записанное не удалось перечитать (файл занят) — не отказ: запись прошла', async () => {
    const path = join(await makeTempDataRoot(), 'file.json');
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (call.op === 'readFile') {
        throw fsError('EBUSY');
      }
    });

    await writeVersioned(path, schema, VERSION, { version: 1, count: 3 }, ioOf({ fs }));

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, count: 3 });
  });
});
