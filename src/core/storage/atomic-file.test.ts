import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import {
  isTempName,
  removeByPrefix,
  renameWithRetry,
  writeFileAtomic,
  writeStreamAtomic,
  type AtomicFs,
  type AtomicOptions,
} from './atomic-file';

const PAGE_FILE = /^p\d{2}-s\d{2}-\d{4}\.jpg$/;

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const fsError = (code: string): Error => Object.assign(new Error(code), { code });

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    await Promise.resolve();
    yield part;
  }
}

// Настоящая файловая система с записью порядка вызовов и подменой отдельных операций.
function recordingFs(overrides: Partial<AtomicFs> = {}) {
  const calls: string[] = [];
  const opened: string[] = [];
  const fs: AtomicFs = {
    open: async (path, flags) => {
      calls.push('open');
      opened.push(path);
      if (overrides.open !== undefined) {
        return overrides.open(path, flags);
      }
      const handle = await nodeFs.open(path, flags);
      return {
        write: (buffer, offset, length) => {
          calls.push('write');
          return handle.write(buffer, offset, length);
        },
        sync: () => {
          calls.push('sync');
          return handle.sync();
        },
        close: () => {
          calls.push('close');
          return handle.close();
        },
      };
    },
    rename: (from, to) => {
      calls.push('rename');
      return (overrides.rename ?? nodeFs.rename)(from, to);
    },
    unlink: (path) => {
      calls.push('unlink');
      return (overrides.unlink ?? nodeFs.unlink)(path);
    },
    readdir: (path) => (overrides.readdir ?? ((dir: string) => nodeFs.readdir(dir)))(path),
  };
  return { fs, calls, opened };
}

// Часы без настоящего ожидания: `sleep` только двигает время.
function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  const retry: AtomicOptions['retry'] = {
    now: () => time,
    sleep: (ms) => {
      sleeps.push(ms);
      time += ms;
      return Promise.resolve();
    },
  };
  return { retry, sleeps };
}

// Переименование, отказывающее заданное число раз, затем настоящее.
function flakyRename(code: string, failures: number) {
  let attempts = 0;
  const rename: AtomicFs['rename'] = (from, to) => {
    attempts += 1;
    return attempts <= failures ? Promise.reject(fsError(code)) : nodeFs.rename(from, to);
  };
  return { rename, attempts: () => attempts };
}

describe('writeFileAtomic', () => {
  it('файл после записи побайтово равен источнику, временного файла не осталось', async () => {
    const root = await makeTempDataRoot();
    const data = Uint8Array.from({ length: 70_000 }, (_value, index) => index % 251);

    await writeFileAtomic(join(root, 'p01-s01-0001.jpg'), data);

    expect(new Uint8Array(await nodeFs.readFile(join(root, 'p01-s01-0001.jpg')))).toEqual(data);
    expect(await nodeFs.readdir(root)).toEqual(['p01-s01-0001.jpg']);
  });

  it('перезапись заменяет прежнее содержимое целиком', async () => {
    const root = await makeTempDataRoot();
    const path = join(root, 'session.json');

    await writeFileAtomic(path, bytes(1, 2, 3, 4, 5));
    await writeFileAtomic(path, bytes(9));

    expect(new Uint8Array(await nodeFs.readFile(path))).toEqual(bytes(9));
    expect(await nodeFs.readdir(root)).toEqual(['session.json']);
  });

  it('порядок вызовов: запись → fsync → закрытие → переименование', async () => {
    const root = await makeTempDataRoot();
    const { fs, calls } = recordingFs();

    await writeFileAtomic(join(root, 'a.bin'), bytes(1, 2, 3), { fs });

    expect(calls).toEqual(['open', 'write', 'sync', 'close', 'rename']);
  });

  it('сбой до переименования оставляет прежний файл нетронутым и убирает временный', async () => {
    const root = await makeTempDataRoot();
    const path = join(root, 'session.json');
    await nodeFs.writeFile(path, bytes(7, 7, 7));
    const { fs, calls } = recordingFs({
      open: async (tempPath, flags) => {
        const handle = await nodeFs.open(tempPath, flags);
        return {
          write: (buffer, offset, length) => handle.write(buffer, offset, length),
          sync: () => Promise.reject(fsError('EIO')),
          close: () => handle.close(),
        };
      },
    });

    await expect(writeFileAtomic(path, bytes(1), { fs })).rejects.toMatchObject({ code: 'EIO' });

    expect(new Uint8Array(await nodeFs.readFile(path))).toEqual(bytes(7, 7, 7));
    expect(await nodeFs.readdir(root)).toEqual(['session.json']);
    expect(calls).not.toContain('rename');
  });

  it('ENOSPC при записи отказывает сразу: ни повторов, ни переименования', async () => {
    const root = await makeTempDataRoot();
    const { retry, sleeps } = fakeClock();
    const { fs, calls } = recordingFs({
      open: async (tempPath, flags) => {
        const handle = await nodeFs.open(tempPath, flags);
        return {
          write: () => Promise.reject(fsError('ENOSPC')),
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    });

    await expect(
      writeFileAtomic(join(root, 'p01-s01-0001.jpg'), bytes(1), { fs, retry }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(sleeps).toEqual([]);
    expect(calls).not.toContain('rename');
    expect(await nodeFs.readdir(root)).toEqual([]);
  });

  it('запись, которая не продвигается, — отказ, а не вечный цикл', async () => {
    const root = await makeTempDataRoot();
    const { fs } = recordingFs({
      open: async (tempPath, flags) => {
        const handle = await nodeFs.open(tempPath, flags);
        return {
          write: () => Promise.resolve({ bytesWritten: 0 }),
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    });

    await expect(writeFileAtomic(join(root, 'a.bin'), bytes(1), { fs })).rejects.toMatchObject({
      code: 'EIO',
    });
    expect(await nodeFs.readdir(root)).toEqual([]);
  });

  it('частичная запись дописывается до конца', async () => {
    const root = await makeTempDataRoot();
    const { fs } = recordingFs({
      open: async (tempPath, flags) => {
        const handle = await nodeFs.open(tempPath, flags);
        return {
          write: (buffer, offset, length) => handle.write(buffer, offset, Math.min(length, 2)),
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    });
    const path = join(root, 'a.bin');

    await writeFileAtomic(path, bytes(1, 2, 3, 4, 5), { fs });

    expect(new Uint8Array(await nodeFs.readFile(path))).toEqual(bytes(1, 2, 3, 4, 5));
  });

  it('имена временных файлов двух одновременных записей различаются', async () => {
    const root = await makeTempDataRoot();
    const { fs, opened } = recordingFs();
    const path = join(root, 'session.json');

    await Promise.all([
      writeFileAtomic(path, bytes(1), { fs }),
      writeFileAtomic(path, bytes(2), { fs }),
    ]);

    expect(opened).toHaveLength(2);
    expect(opened[0]).not.toBe(opened[1]);
    expect(await nodeFs.readdir(root)).toEqual(['session.json']);
  });

  it('временный файл лежит рядом с конечным и отличим от страницы по имени', async () => {
    const root = await makeTempDataRoot();
    const { fs, opened } = recordingFs();

    await writeFileAtomic(join(root, 'p01-s01-0001.jpg'), bytes(1), { fs });

    const temp = opened[0] ?? '';
    expect(temp.startsWith(join(root, 'p01-s01-0001.jpg.'))).toBe(true);
    expect(isTempName(temp)).toBe(true);
    expect(PAGE_FILE.test(temp.slice(root.length + 1))).toBe(false);
    expect(isTempName('p01-s01-0001.jpg')).toBe(false);
    expect(isTempName('session.json')).toBe(false);
  });
});

describe('writeStreamAtomic', () => {
  it('поток записан целиком, возвращено число байт', async () => {
    const root = await makeTempDataRoot();
    const path = join(root, 'p01-s01-0001.jpg');

    const written = await writeStreamAtomic(path, chunks(bytes(1, 2), bytes(), bytes(3, 4, 5)));

    expect(written).toBe(5);
    expect(new Uint8Array(await nodeFs.readFile(path))).toEqual(bytes(1, 2, 3, 4, 5));
    expect(await nodeFs.readdir(root)).toEqual(['p01-s01-0001.jpg']);
  });

  it('поток, оборванный посередине, не даёт файла с конечным именем', async () => {
    const root = await makeTempDataRoot();
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield bytes(1, 2, 3);
      await Promise.resolve();
      throw fsError('ECONNRESET');
    }

    await expect(writeStreamAtomic(join(root, 'p01-s01-0002.jpg'), broken())).rejects.toMatchObject(
      { code: 'ECONNRESET' },
    );

    expect(await nodeFs.readdir(root)).toEqual([]);
  });

  it('обрыв потока не трогает уже записанные соседние страницы', async () => {
    const root = await makeTempDataRoot();
    await writeFileAtomic(join(root, 'p01-s01-0001.jpg'), bytes(1));
    async function* broken(): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      yield bytes(2);
      throw new Error('обрыв');
    }

    await expect(writeStreamAtomic(join(root, 'p01-s01-0002.jpg'), broken())).rejects.toThrow(
      'обрыв',
    );

    expect(await nodeFs.readdir(root)).toEqual(['p01-s01-0001.jpg']);
  });
});

describe('повторы переименования', () => {
  it.each(['EPERM', 'EBUSY', 'EACCES'])(
    'переименование, дважды отказавшее с %s, проходит с третьей попытки',
    async (code) => {
      const root = await makeTempDataRoot();
      const { retry, sleeps } = fakeClock();
      const flaky = flakyRename(code, 2);
      const { fs } = recordingFs({ rename: flaky.rename });
      const path = join(root, 'session.json');

      await writeFileAtomic(path, bytes(4, 2), { fs, retry });

      expect(flaky.attempts()).toBe(3);
      expect(sleeps).toHaveLength(2);
      expect(new Uint8Array(await nodeFs.readFile(path))).toEqual(bytes(4, 2));
      expect(await nodeFs.readdir(root)).toEqual(['session.json']);
    },
  );

  it('отказ сверх потолка возвращает ошибку записи; прежний файл цел, временного нет', async () => {
    const root = await makeTempDataRoot();
    const path = join(root, 'session.json');
    await nodeFs.writeFile(path, bytes(7));
    const { retry, sleeps } = fakeClock();
    const flaky = flakyRename('EPERM', Number.POSITIVE_INFINITY);
    const { fs } = recordingFs({ rename: flaky.rename });

    await expect(
      writeFileAtomic(path, bytes(1), { fs, retry: { ...retry, ceilingMs: 2000 } }),
    ).rejects.toMatchObject({ code: 'EPERM' });

    expect(flaky.attempts()).toBeGreaterThan(3);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(2000);
    expect(new Uint8Array(await nodeFs.readFile(path))).toEqual(bytes(7));
    expect(await nodeFs.readdir(root)).toEqual(['session.json']);
  });

  it('отступ между попытками растёт и ограничен сверху', async () => {
    const root = await makeTempDataRoot();
    const { retry, sleeps } = fakeClock();
    const { fs } = recordingFs({ rename: flakyRename('EBUSY', 8).rename });

    await writeFileAtomic(join(root, 'a.bin'), bytes(1), { fs, retry });

    expect(sleeps).toEqual([...sleeps].sort((a, b) => a - b));
    expect(sleeps[0]).toBeLessThan(sleeps.at(-1) ?? 0);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(250);
  });

  it('ENOSPC и посторонние ошибки переименования не повторяются', async () => {
    for (const code of ['ENOSPC', 'ENOENT', 'EIO']) {
      const root = await makeTempDataRoot();
      const { retry, sleeps } = fakeClock();
      const flaky = flakyRename(code, Number.POSITIVE_INFINITY);
      const { fs } = recordingFs({ rename: flaky.rename });

      await expect(
        writeFileAtomic(join(root, 'a.bin'), bytes(1), { fs, retry }),
      ).rejects.toMatchObject({ code });

      expect(flaky.attempts(), code).toBe(1);
      expect(sleeps, code).toEqual([]);
      expect(await nodeFs.readdir(root), code).toEqual([]);
    }
  });

  it('переименование каталога повторяется и проходит', async () => {
    const root = await makeTempDataRoot();
    await nodeFs.mkdir(join(root, 'session', 'pages'), { recursive: true });
    await nodeFs.writeFile(join(root, 'session', 'pages', 'p01-s01-0001.jpg'), bytes(1));
    const { retry } = fakeClock();
    const flaky = flakyRename('EPERM', 2);
    const { fs } = recordingFs({ rename: flaky.rename });

    await renameWithRetry(join(root, 'session'), join(root, 'session.closing-1'), { fs, retry });

    expect(flaky.attempts()).toBe(3);
    expect(await nodeFs.readdir(root)).toEqual(['session.closing-1']);
    expect(await nodeFs.readdir(join(root, 'session.closing-1', 'pages'))).toEqual([
      'p01-s01-0001.jpg',
    ]);
  });

  it('переименование каталога: отказ сверх потолка оставляет каталог целым', async () => {
    const root = await makeTempDataRoot();
    await nodeFs.mkdir(join(root, 'session', 'pages'), { recursive: true });
    await nodeFs.writeFile(join(root, 'session', 'pages', 'p01-s01-0001.jpg'), bytes(1));
    const { retry } = fakeClock();
    const { fs } = recordingFs({ rename: flakyRename('EBUSY', Number.POSITIVE_INFINITY).rename });

    await expect(
      renameWithRetry(join(root, 'session'), join(root, 'session.closing-1'), { fs, retry }),
    ).rejects.toMatchObject({ code: 'EBUSY' });

    expect(await nodeFs.readdir(root)).toEqual(['session']);
    expect(await nodeFs.readdir(join(root, 'session', 'pages'))).toEqual(['p01-s01-0001.jpg']);
  });
});

describe('removeByPrefix', () => {
  async function seed(root: string, names: readonly string[]): Promise<void> {
    for (const name of names) {
      await nodeFs.writeFile(join(root, name), bytes(1));
    }
  }

  it('удаляет файлы сегмента и возвращает их в отчёте', async () => {
    const root = await makeTempDataRoot();
    await seed(root, ['p01-s01-0001.jpg', 'p01-s01-0002.jpg', 'p01-s02-0001.jpg']);

    const report = await removeByPrefix(root, 'p01-s01-', PAGE_FILE);

    expect(report).toEqual({ removed: ['p01-s01-0001.jpg', 'p01-s01-0002.jpg'], failed: [] });
    expect(await nodeFs.readdir(root)).toEqual(['p01-s02-0001.jpg']);
  });

  it('не трогает файл с посторонним именем в том же каталоге', async () => {
    const root = await makeTempDataRoot();
    await seed(root, [
      'p01-s01-0001.jpg',
      'p01-s01-notes.txt',
      'p01-s01-0001.jpg.0a1b2c3d4e5f.tmp',
      'p01-s01-0002.jpeg',
      'thumbs.db',
    ]);

    const report = await removeByPrefix(root, 'p01-s01-', PAGE_FILE);

    expect(report.removed).toEqual(['p01-s01-0001.jpg']);
    expect(await nodeFs.readdir(root)).toEqual([
      'p01-s01-0001.jpg.0a1b2c3d4e5f.tmp',
      'p01-s01-0002.jpeg',
      'p01-s01-notes.txt',
      'thumbs.db',
    ]);
  });

  it('префикс p01-s01- не совпадает с p01-s011-', async () => {
    const root = await makeTempDataRoot();
    const wide = /^p\d+-s\d+-\d{4}\.jpg$/;
    await seed(root, ['p01-s01-0001.jpg', 'p01-s011-0001.jpg', 'p011-s01-0001.jpg']);

    const report = await removeByPrefix(root, 'p01-s01-', wide);

    expect(report.removed).toEqual(['p01-s01-0001.jpg']);
    expect(await nodeFs.readdir(root)).toEqual(['p01-s011-0001.jpg', 'p011-s01-0001.jpg']);
  });

  it('файл, который не удалось удалить, попадает в отчёт, остальные удаляются', async () => {
    const root = await makeTempDataRoot();
    await seed(root, ['p01-s01-0001.jpg', 'p01-s01-0002.jpg', 'p01-s01-0003.jpg']);
    const { fs } = recordingFs({
      unlink: (path) =>
        path.endsWith('0002.jpg') ? Promise.reject(fsError('EBUSY')) : nodeFs.unlink(path),
    });

    const report = await removeByPrefix(root, 'p01-s01-', PAGE_FILE, { fs });

    expect(report).toEqual({
      removed: ['p01-s01-0001.jpg', 'p01-s01-0003.jpg'],
      failed: [{ name: 'p01-s01-0002.jpg', code: 'EBUSY' }],
    });
    expect(await nodeFs.readdir(root)).toEqual(['p01-s01-0002.jpg']);
  });

  it('файл, исчезнувший между листингом и удалением, считается удалённым', async () => {
    const root = await makeTempDataRoot();
    await seed(root, ['p01-s01-0001.jpg']);
    const { fs } = recordingFs({ unlink: () => Promise.reject(fsError('ENOENT')) });

    expect(await removeByPrefix(root, 'p01-s01-', PAGE_FILE, { fs })).toEqual({
      removed: ['p01-s01-0001.jpg'],
      failed: [],
    });
  });

  it('каталога нет — удалять нечего; повторное удаление ничего не меняет', async () => {
    const root = await makeTempDataRoot();

    expect(await removeByPrefix(join(root, 'pages'), 'p01-s01-', PAGE_FILE)).toEqual({
      removed: [],
      failed: [],
    });

    await seed(root, ['p01-s01-0001.jpg']);
    await removeByPrefix(root, 'p01-s01-', PAGE_FILE);
    expect(await removeByPrefix(root, 'p01-s01-', PAGE_FILE)).toEqual({ removed: [], failed: [] });
  });

  it('пустой префикс — ошибка программы, а не удаление всего каталога', async () => {
    const root = await makeTempDataRoot();
    await seed(root, ['p01-s01-0001.jpg']);

    await expect(removeByPrefix(root, '', PAGE_FILE)).rejects.toThrow(/префикс/);
    expect(await nodeFs.readdir(root)).toEqual(['p01-s01-0001.jpg']);
  });

  it('шаблон с флагом g или y — ошибка программы: он пропускал бы файлы', async () => {
    const root = await makeTempDataRoot();
    await seed(root, ['p01-s01-0001.jpg', 'p01-s01-0002.jpg', 'p01-s01-0003.jpg']);

    for (const flags of ['g', 'y', 'gy']) {
      await expect(
        removeByPrefix(root, 'p01-s01-', new RegExp(PAGE_FILE.source, flags)),
      ).rejects.toThrow(/шаблон/);
    }
    expect(await nodeFs.readdir(root)).toHaveLength(3);
  });

  it('ошибка листинга, отличная от «каталога нет», не проглатывается', async () => {
    const root = await makeTempDataRoot();
    const { fs } = recordingFs({ readdir: () => Promise.reject(fsError('EACCES')) });

    await expect(removeByPrefix(root, 'p01-s01-', PAGE_FILE, { fs })).rejects.toMatchObject({
      code: 'EACCES',
    });
  });
});
