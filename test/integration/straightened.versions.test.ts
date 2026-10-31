import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SKEW_DETECTOR_VERSION } from '../../src/core/detect/skew';
import { STRAIGHTEN_ENCODING, type StraightenResult } from '../../src/core/image/straighten';
import type { PassOrigin } from '../../src/core/storage/journal';
import {
  layoutOf,
  straightFileName,
  straightRecordName,
  UNKNOWN_DETECTOR,
} from '../../src/core/storage/layout';
import { openSessionStore } from '../../src/core/storage/reconcile';
import {
  createStraightened,
  isCurrentStraightened,
  type Straightened,
} from '../../src/core/storage/straightened';
import { pageFixture } from '../support/fixtures';
import { unwrap } from '../support/result';
import { makeTempDataRoot } from '../support/temp-data-root';

// Версии выправленных пар (AE13; KTD-8, KTD-11; B-19) при текущей геометрии 2: пары прежних
// версий — геометрии, детектора или прежнего формата без детектора — действительны для показа,
// но не текущие; пересчёт пишет текущую пару рядом и убирает прочие, а пока снимок пакета держит
// прежние файлы (`hold`), удаление откладывается до отпускания — сборка PDF по снимку не теряет
// файл посреди записи (ревью сессий 3–4). Геометрия подменяется модулем: продуктовая константа
// — 1, и прежних версий у неё нет; детектор — настоящий.

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
const D = SKEW_DETECTOR_VERSION;
const CURRENT = { version: 2, detector: D };
/** Детектор прежних сборок: пары с ним — наши, но не текущие. */
const OLDER = D - 1;
const OLDEST = D - 2;
const current = (ext: 'jpg' | 'json'): string =>
  ext === 'jpg' ? straightFileName(F1, 2, D) : straightRecordName(F1, 2, D);

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

/**
 * Пара прежних версий на диске — как от прошлого приложения: детектор «неизвестен» — прежний
 * формат без поля и без `.d` в имени.
 */
async function pairOnDisk(
  dir: string,
  version: number,
  detector: number,
  fill = 1,
  bytes = 20,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const name = straightFileName(F1, version, detector);
  await writeFile(join(dir, name), Buffer.alloc(bytes, fill));
  await writeFile(
    join(dir, straightRecordName(F1, version, detector)),
    JSON.stringify({
      v: version,
      ...(detector === UNKNOWN_DETECTOR ? {} : { detector }),
      encoding: STRAIGHTEN_ENCODING,
      dpi: 300,
      file: { name, bytes },
    }),
  );
}

async function loaded(straightened: Straightened, dir: string, version: number, detector: number) {
  await pairOnDisk(dir, version, detector);
  await straightened.load([F1]);
  expect(straightened.resolve(F1)).toMatchObject({ version, detector });
}

describe('выправленные пары: версии геометрии и детектора (AE13, B-19)', () => {
  it('store пишет текущую пару с детектором в записи и имени; прежняя геометрия убрана; без удержания — сразу', async () => {
    const { dir, straightened } = await sessionWith();
    await loaded(straightened, dir, 1, UNKNOWN_DETECTOR);
    expect(await files(dir)).toEqual([`${F1}.v1.jpg`, `${F1}.v1.json`]);
    expect(isCurrentStraightened(straightened.resolve(F1) ?? CURRENT)).toBe(false);

    await straightened.store(F1, resultOf(2));

    const file = straightened.resolve(F1);
    expect(file).toMatchObject(CURRENT);
    expect(isCurrentStraightened(file ?? { version: 0, detector: 0 })).toBe(true);
    expect(await files(dir)).toEqual([current('jpg'), current('json')]);
    expect(JSON.parse(await readFile(join(dir, current('json')), 'utf8'))).toMatchObject({
      v: 2,
      detector: D,
      file: { name: current('jpg'), bytes: 64 },
    });
  });

  it('пара той же геометрии с чужим детектором — годна, не текущая; store пишет рядом и убирает её', async () => {
    const { dir, straightened } = await sessionWith();
    await loaded(straightened, dir, 2, OLDER);
    expect(isCurrentStraightened(straightened.resolve(F1) ?? CURRENT)).toBe(false);

    await straightened.store(F1, resultOf(2));

    expect(straightened.resolve(F1)).toMatchObject(CURRENT);
    expect(await files(dir)).toEqual([current('jpg'), current('json')]);
  });

  it('пара с детектором новее известного — не наша: не отдаётся, store пишет текущую рядом и её не трогает', async () => {
    const { dir, straightened } = await sessionWith();
    await pairOnDisk(dir, 2, D + 1);
    await straightened.load([F1]);
    expect(straightened.resolve(F1)).toBeNull();

    await straightened.store(F1, resultOf(2));

    expect(straightened.resolve(F1)).toMatchObject(CURRENT);
    expect(await files(dir)).toEqual(
      [
        current('jpg'),
        current('json'),
        straightFileName(F1, 2, D + 1),
        straightRecordName(F1, 2, D + 1),
      ].sort(),
    );
  });

  it('две пары ключа при открытии — отдаётся текущая, лишняя убирается; негодная запись — сирота', async () => {
    const { dir, straightened } = await sessionWith();
    await pairOnDisk(dir, 1, UNKNOWN_DETECTOR);
    await pairOnDisk(dir, 2, D, 2, 64);
    // Пары новее известных версий — геометрии или детектора — от будущего приложения: не
    // трогаются и не отдаются.
    await pairOnDisk(dir, 3, D);
    await pairOnDisk(dir, 2, D + 1);
    // Запись без файла нужного размера — негодна.
    await pairOnDisk(dir, 2, OLDEST);
    await writeFile(join(dir, straightFileName(F1, 2, OLDEST)), Buffer.alloc(5));

    await straightened.load([F1]);

    expect(straightened.resolve(F1)).toMatchObject({ ...CURRENT, bytes: 64 });
    expect(await files(dir)).toEqual(
      [
        current('jpg'),
        current('json'),
        straightFileName(F1, 2, D + 1),
        straightRecordName(F1, 2, D + 1),
        straightFileName(F1, 3, D),
        straightRecordName(F1, 3, D),
      ].sort(),
    );
  });

  it('discard убирает пару и запись из карты; под hold файлы живут до отпускания, resolve уже пуст', async () => {
    const { dir, straightened } = await sessionWith();
    await loaded(straightened, dir, 1, UNKNOWN_DETECTOR);

    await straightened.discard(F1);
    expect(straightened.resolve(F1)).toBeNull();
    expect(await files(dir)).toEqual([]);

    await loaded(straightened, dir, 2, OLDER);
    const release = straightened.hold();
    await straightened.discard(F1);
    expect(straightened.resolve(F1)).toBeNull();
    expect(await files(dir)).toHaveLength(2);
    release();
    await expect.poll(() => files(dir)).toEqual([]);
  });

  it('hold держит прежние файлы до отпускания; вложенные удержания считаются; повторное отпускание безвредно', async () => {
    const { dir, straightened } = await sessionWith();
    await loaded(straightened, dir, 1, UNKNOWN_DETECTOR);
    const outer = straightened.hold();
    const inner = straightened.hold();

    await straightened.store(F1, resultOf(2));
    expect(straightened.resolve(F1)).toMatchObject(CURRENT);
    // Новая пара записана, прежняя — на месте: снимок пакета читает её по пути.
    expect(await files(dir)).toEqual([
      `${F1}.v1.jpg`,
      `${F1}.v1.json`,
      current('jpg'),
      current('json'),
    ]);

    inner();
    inner();
    expect(await files(dir)).toHaveLength(4);
    outer();
    await expect.poll(() => files(dir)).toEqual([current('jpg'), current('json')]);
  });
});
