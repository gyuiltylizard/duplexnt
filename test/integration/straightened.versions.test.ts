import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { STRAIGHTEN_ENCODING, type StraightenResult } from '../../src/core/image/straighten';
import type { PassOrigin } from '../../src/core/storage/journal';
import { layoutOf } from '../../src/core/storage/layout';
import { openSessionStore } from '../../src/core/storage/reconcile';
import { createStraightened } from '../../src/core/storage/straightened';
import { pageFixture } from '../support/fixtures';
import { unwrap } from '../support/result';
import { makeTempDataRoot } from '../support/temp-data-root';

// Смена версии геометрии (AE13; KTD-8, KTD-11) на выправленных файлах при текущей версии 2:
// записи прежней версии действительны, пересчёт пишет новую и удаляет прежнюю, а пока снимок
// пакета держит прежние файлы (`hold`), удаление откладывается до отпускания — сборка PDF по
// снимку не теряет файл посреди записи (ревью сессий 3–4). Версия подменяется модулем:
// продуктовая константа — 1, и прежних версий у неё нет.

vi.mock('../../src/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared')>()),
  STRAIGHTEN_GEOMETRY_VERSION: 2,
}));

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

const resultOf = (fill: number, bytes = 64): StraightenResult => ({
  jpeg: new Uint8Array(bytes).fill(fill),
  info: { width: 8, height: 8, channels: 1 },
  encoding: STRAIGHTEN_ENCODING,
  dpi: 300,
});

async function sessionWith() {
  const root = await makeTempDataRoot();
  const layout = layoutOf(root);
  const { store } = await openSessionStore(root);
  unwrap(await store.beginPass(ORIGIN, null, 'hide', 'auto'));
  await store.acceptPage(body(pageFixture(1)));
  unwrap(await store.endSegment('completed'));
  const dir = join(layout.derivedDir, store.snapshot()?.id ?? '', 'straight');
  const straightened = createStraightened(layout.derivedDir, store);
  return { store, layout, dir, straightened };
}

const files = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();

describe('выправленные файлы: версия геометрии 2 (AE13)', () => {
  it('store пишет текущую версию и удаляет прежнюю; без удержания — сразу', async () => {
    const { dir, straightened } = await sessionWith();
    // Прежняя версия — как от прошлого приложения.
    await straightenedV1(straightened, dir);
    expect(await files(dir)).toEqual([`${F1}.v1.jpg`, `${F1}.v1.json`]);

    await straightened.store(F1, resultOf(2));

    expect(straightened.resolve(F1)?.version).toBe(2);
    expect(await files(dir)).toEqual([`${F1}.v2.jpg`, `${F1}.v2.json`]);
  });

  it('hold держит прежние файлы до отпускания; вложенные удержания считаются; повторное отпускание безвредно', async () => {
    const { dir, straightened } = await sessionWith();
    await straightenedV1(straightened, dir);
    const outer = straightened.hold();
    const inner = straightened.hold();

    await straightened.store(F1, resultOf(2));
    expect(straightened.resolve(F1)?.version).toBe(2);
    // Новая версия записана, прежняя — на месте: снимок пакета читает её по пути.
    expect(await files(dir)).toEqual([
      `${F1}.v1.jpg`,
      `${F1}.v1.json`,
      `${F1}.v2.jpg`,
      `${F1}.v2.json`,
    ]);

    inner();
    inner();
    expect(await files(dir)).toHaveLength(4);
    outer();
    await expect.poll(() => files(dir)).toEqual([`${F1}.v2.jpg`, `${F1}.v2.json`]);
  });
});

/** Комплект прежней версии 1 на диске: пишется тем же модулем с версией 1 и читается как действительный. */
async function straightenedV1(
  straightened: ReturnType<typeof createStraightened>,
  dir: string,
): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${F1}.v1.jpg`), Buffer.alloc(20, 1));
  await writeFile(
    join(dir, `${F1}.v1.json`),
    JSON.stringify({
      v: 1,
      encoding: STRAIGHTEN_ENCODING,
      dpi: 300,
      file: { name: `${F1}.v1.jpg`, bytes: 20 },
    }),
  );
  await straightened.load([F1]);
  expect(straightened.resolve(F1)?.version).toBe(1);
}
