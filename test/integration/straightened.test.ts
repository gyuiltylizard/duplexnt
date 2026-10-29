import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STRAIGHTEN_GEOMETRY_VERSION } from '../../src/shared';
import { STRAIGHTEN_ENCODING, type StraightenResult } from '../../src/core/image/straighten';
import type { PassOrigin } from '../../src/core/storage/journal';
import { layoutOf } from '../../src/core/storage/layout';
import { openSessionStore } from '../../src/core/storage/reconcile';
import { realStorageFs } from '../../src/core/storage/storage-fs';
import { createStraightened, type StraightenedSource } from '../../src/core/storage/straightened';
import { dirSnapshot } from '../support/dir-snapshot';
import { pageFixture } from '../support/fixtures';
import { unwrap } from '../support/result';
import { makeTempDataRoot } from '../support/temp-data-root';

// Выправленные файлы как производное с одной истиной (план M6, U11; KTD-11, KTD-12) на
// настоящем хранилище сессии во временном корне: запись «JPEG, затем запись о коррекции», сверка
// размера, версии, сироты и временные файлы, отброшенная страница. Сам ресэмплер здесь не
// нужен — исход коррекции подставной.

const ORIGIN: PassOrigin = {
  scanner: {
    scheme: 'https',
    host: 'scanner.test',
    port: 443,
    basePath: '/eSCL',
    fingerprint: 'ab'.repeat(32),
    uuid: null,
    name: null,
  },
  params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
  pixelLimit: 5100 * 8400,
};

async function* body(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield bytes;
}

const F1 = 'p01-s01-0001';
const F2 = 'p01-s01-0002';
const V = STRAIGHTEN_GEOMETRY_VERSION;

const resultOf = (fill: number, bytes = 64): StraightenResult => ({
  jpeg: new Uint8Array(bytes).fill(fill),
  info: { width: 8, height: 8, channels: 1 },
  encoding: STRAIGHTEN_ENCODING,
  dpi: 300,
});

const recordOf = (key: string, version: number, bytes: number): string =>
  JSON.stringify({
    v: version,
    encoding: STRAIGHTEN_ENCODING,
    dpi: 300,
    file: { name: `${key}.v${version}.jpg`, bytes },
  });

async function sessionWith(pages: number, root?: string) {
  const dataRoot = root ?? (await makeTempDataRoot());
  const layout = layoutOf(dataRoot);
  const { store } = await openSessionStore(dataRoot);
  if (store.snapshot() === null) {
    unwrap(await store.beginPass(ORIGIN, null, 'hide', 'auto'));
    for (let index = 1; index <= pages; index += 1) {
      await store.acceptPage(body(pageFixture(index)));
    }
    unwrap(await store.endSegment('completed'));
  }
  const sessionId = store.snapshot()?.id ?? '';
  const dir = join(layout.derivedDir, sessionId, 'straight');
  return { root: dataRoot, layout, store, sessionId, dir };
}

describe('выправленные файлы: запись, запись о коррекции, версии', () => {
  it('store пишет JPEG и запись; resolve отдаёт путь, версию, размер; в каталог сессии ничего не записано', async () => {
    const { store, layout, dir } = await sessionWith(1);
    const straightened = createStraightened(layout.derivedDir, store);
    const before = await dirSnapshot(layout.sessionDir);
    expect(straightened.resolve(F1)).toBeNull();

    await straightened.store(F1, resultOf(7));

    expect(straightened.resolve(F1)).toEqual({
      path: join(dir, `${F1}.v${V}.jpg`),
      version: V,
      bytes: 64,
      encoding: STRAIGHTEN_ENCODING,
      dpi: 300,
    });
    expect((await readdir(dir)).sort()).toEqual([`${F1}.v${V}.jpg`, `${F1}.v${V}.json`]);
    expect(JSON.parse(await readFile(join(dir, `${F1}.v${V}.json`), 'utf8'))).toEqual({
      v: V,
      encoding: STRAIGHTEN_ENCODING,
      dpi: 300,
      file: { name: `${F1}.v${V}.jpg`, bytes: 64 },
    });
    expect(await readFile(join(dir, `${F1}.v${V}.jpg`))).toEqual(Buffer.alloc(64, 7));
    expect(await dirSnapshot(layout.sessionDir)).toEqual(before);
  });

  it('перезапуск: load читает записи; JPEG без записи — сирота, убирается; запись с другим размером — «оценки нет»', async () => {
    const { root, layout, dir } = await sessionWith(3);
    const first = createStraightened(layout.derivedDir, (await openSessionStore(root)).store);
    await first.store(F1, resultOf(1));
    // Сирота: JPEG второй страницы без записи; у третьей — запись, но файл другого размера.
    await writeFile(join(dir, `${F2}.v${V}.jpg`), Buffer.alloc(10, 2));
    const F3 = 'p01-s01-0003';
    await writeFile(join(dir, `${F3}.v${V}.jpg`), Buffer.alloc(10, 3));
    await writeFile(join(dir, `${F3}.v${V}.json`), recordOf(F3, V, 99));

    const { store } = await openSessionStore(root);
    const straightened = createStraightened(layout.derivedDir, store);
    await straightened.load([F1, F2, F3, 'p09-s01-0001']);

    expect(straightened.resolve(F1)?.bytes).toBe(64);
    expect(straightened.resolve(F2)).toBeNull();
    expect(straightened.resolve(F3)).toBeNull();
    expect((await readdir(dir)).sort()).toEqual([`${F1}.v${V}.jpg`, `${F1}.v${V}.json`]);
  });

  it('две записи разных версий — resolve отдаёт новейшую действительную; store новой версии удаляет старую после записи', async () => {
    const { store, layout, dir } = await sessionWith(1);
    await mkdir(dir, { recursive: true });
    const older = V - 1;
    // Прежняя версия действительна (известная), пока новой нет.
    if (older >= 1) {
      await writeFile(join(dir, `${F1}.v${older}.jpg`), Buffer.alloc(20, 1));
      await writeFile(join(dir, `${F1}.v${older}.json`), recordOf(F1, older, 20));
    }
    // Запись «из будущего» — новее известной версии: не отдаётся и не трогается.
    await writeFile(join(dir, `${F1}.v${V + 5}.jpg`), Buffer.alloc(30, 9));
    await writeFile(join(dir, `${F1}.v${V + 5}.json`), recordOf(F1, V + 5, 30));
    const straightened = createStraightened(layout.derivedDir, store);
    await straightened.load([F1]);
    expect(straightened.resolve(F1)?.version).toBe(older >= 1 ? older : undefined);

    await straightened.store(F1, resultOf(4));

    expect(straightened.resolve(F1)?.version).toBe(V);
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(
      [`${F1}.v${V}.jpg`, `${F1}.v${V}.json`, `${F1}.v${V + 5}.jpg`, `${F1}.v${V + 5}.json`].sort(),
    );
  });

  it('временный файл незаконченной записи не принимается и убирается при открытии', async () => {
    const { store, layout, dir } = await sessionWith(1);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${F1}.v${V}.jpg.0123456789ab.tmp`), Buffer.alloc(5));
    const straightened = createStraightened(layout.derivedDir, store);

    await straightened.load([F1]);

    expect(straightened.resolve(F1)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it('страница, отброшенная пока шла запись, файлов не оставляет; сбой записи — исключение, временного файла нет', async () => {
    const { store, layout, dir } = await sessionWith(1);
    let asked = 0;
    const source: StraightenedSource = {
      // Первый вопрос — до записи, дальше — после: к этому времени страницы уже нет.
      pageInfo: (key) => ((asked += 1) === 1 ? store.pageInfo(key) : null),
      readPage: (key) => store.readPage(key),
    };
    const straightened = createStraightened(layout.derivedDir, source);
    await straightened.store(F1, resultOf(1));
    expect(await readdir(dir)).toEqual([]);

    const failing = createStraightened(layout.derivedDir, store, {
      retry: { ceilingMs: 0 },
      fs: {
        ...realStorageFs,
        rename: () => Promise.reject(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })),
      },
    });
    await expect(failing.store(F1, resultOf(1))).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(failing.resolve(F1)).toBeNull();
    expect(await readdir(dir)).toEqual([]);

    // Сбой на второй записи — записи о коррекции: готовый JPEG не остаётся сиротой на полном
    // диске (ревью сессий 3–4).
    const recordFailing = createStraightened(layout.derivedDir, store, {
      retry: { ceilingMs: 0 },
      fs: {
        ...realStorageFs,
        rename: (from, to) =>
          to.endsWith('.json')
            ? Promise.reject(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }))
            : realStorageFs.rename(from, to),
      },
    });
    await expect(recordFailing.store(F1, resultOf(1))).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(recordFailing.resolve(F1)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it('prune забывает записи закрытой сессии; тот же ключ новой сессии — без выправленного вида', async () => {
    const { store, layout } = await sessionWith(1);
    const straightened = createStraightened(layout.derivedDir, store);
    await straightened.store(F1, resultOf(1));
    expect(straightened.resolve(F1)).not.toBeNull();

    unwrap(await store.closeSession());
    expect(straightened.resolve(F1)).toBeNull();
    straightened.prune();

    unwrap(await store.beginPass(ORIGIN, null, 'hide', 'auto'));
    await store.acceptPage(body(pageFixture(2)));
    unwrap(await store.endSegment('completed'));
    expect(straightened.resolve(F1)).toBeNull();
  });
});
