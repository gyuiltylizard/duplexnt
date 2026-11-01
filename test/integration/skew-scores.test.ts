import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STRAIGHTEN_GEOMETRY_VERSION } from '../../src/shared';
import { SKEW_DETECTOR_VERSION } from '../../src/core/detect/skew';
import type { PassOrigin } from '../../src/core/storage/journal';
import { ImageTimeoutError } from '../../src/core/image/sharp-image';
import { layoutOf } from '../../src/core/storage/layout';
import { limiterOf, type LimiterPriority } from '../../src/core/storage/limiter';
import { openSessionStore } from '../../src/core/storage/reconcile';
import {
  createSkewScores,
  type SkewMeasurer,
  type SkewScores,
  type SkewScoreSource,
} from '../../src/core/storage/skew-scores';
import { dirSnapshot } from '../support/dir-snapshot';
import { scanFixture } from '../support/fixtures';
import { unwrap } from '../support/result';
import { realMeasurer, stubWorker } from '../support/image-worker';
import { makeTempDataRoot } from '../support/temp-data-root';
import { until } from '../support/until';

// Оценки перекоса на настоящем детекторе, настоящих сканах ET-3850 и настоящем хранилище сессии
// во временном корне данных (план M6, U5; KTD-4, KTD-11, KTD-12) — по образцу
// `blank-scores.test.ts`. Табличная калибровка детектора — `skew-detector.test.ts`; здесь —
// карта, кэш, версии, отмена и жизненный цикл.

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

const FAN = () => scanFixture('fan-text-gray-300');
const PHOTO = () => scanFixture('photo-gray-300');
const F1 = 'p01-s01-0001';
const F2 = 'p01-s01-0002';

/** Сессия: один проход из заданных сканов; режим выравнивания «авто». */
async function sessionWith(pages: readonly Uint8Array[], root?: string) {
  const dataRoot = root ?? (await makeTempDataRoot());
  const layout = layoutOf(dataRoot);
  const { store } = await openSessionStore(dataRoot);
  if (store.snapshot() === null) {
    unwrap(await store.beginPass(ORIGIN, null, 'hide', 'auto'));
    for (const page of pages) {
      await store.acceptPage(body(page));
    }
    unwrap(await store.endSegment('completed'));
  }
  const sessionId = store.snapshot()?.id ?? '';
  const skewDir = join(layout.derivedDir, sessionId, 'skew');
  return { root: dataRoot, layout, store, sessionId, skewDir };
}

/** Измеритель, который считает вызовы. */
function counting(measurer: SkewMeasurer = realMeasurer) {
  const calls: number[] = [];
  const counted: SkewMeasurer = (bytes, limit, options) => {
    calls.push(bytes.byteLength);
    return measurer(bytes, limit, options);
  };
  return { measurer: counted, calls };
}

const outcomesOf = (scores: SkewScores) =>
  Object.fromEntries([...scores.verdicts()].map(([key, verdict]) => [key, verdict.outcome]));

const readCache = async (dir: string, key: string): Promise<unknown> =>
  JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8'));

describe('оценки перекоса: измерение, карта и кэш', () => {
  it('косой лист — «выправлять» с профилем, фото — «не померить»; кэш с версиями, профилем и размером исходника', async () => {
    const { store, layout, skewDir } = await sessionWith([FAN(), PHOTO()]);
    const { measurer, calls } = counting();
    const scores = createSkewScores(layout.derivedDir, store, measurer);
    const before = await dirSnapshot(layout.sessionDir);

    expect(await Promise.all([scores.ensure(F1), scores.ensure(F2)])).toEqual([true, true]);

    expect(outcomesOf(scores)).toEqual({ [F1]: 'willStraighten', [F2]: 'unmeasurable' });
    expect(scores.verdicts().get(F1)?.profile?.kind).toBe('knots');
    expect(scores.verdicts().get(F2)?.profile).toBeNull();
    expect(calls).toHaveLength(2);
    expect((await readdir(skewDir)).sort()).toEqual([`${F1}.json`, `${F2}.json`]);
    expect(await readCache(skewDir, F1)).toMatchObject({
      v: { geometry: STRAIGHTEN_GEOMETRY_VERSION, detector: SKEW_DETECTOR_VERSION },
      outcome: 'willStraighten',
      profile: { kind: 'knots' },
      source: { bytes: FAN().byteLength },
    });
    expect(await readCache(skewDir, F2)).toMatchObject({
      outcome: 'unmeasurable',
      profile: null,
      contrast: null,
    });
    // В каталог сессии ничего не записано.
    expect(await dirSnapshot(layout.sessionDir)).toEqual(before);
  });

  it('повторный ensure и одновременные запросы — одно измерение; чужой ключ — ничего', async () => {
    const { store, layout } = await sessionWith([FAN()]);
    const { measurer, calls } = counting();
    const scores = createSkewScores(layout.derivedDir, store, measurer);

    const results = await Promise.all([scores.ensure(F1), scores.ensure(F1), scores.ensure(F1)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await scores.ensure(F1)).toBe(false);
    expect(await scores.ensure('p09-s01-0001')).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('перезапуск: load читает кэш без измерения; ensure после load — ничего нового', async () => {
    const { root, layout } = await sessionWith([FAN(), PHOTO()]);
    const first = createSkewScores(
      layout.derivedDir,
      (await openSessionStore(root)).store,
      realMeasurer,
    );
    await Promise.all([first.ensure(F1), first.ensure(F2)]);

    const { store } = await openSessionStore(root);
    const { measurer, calls } = counting();
    const scores = createSkewScores(layout.derivedDir, store, measurer);
    await scores.load([F1, F2, 'p09-s01-0001']);

    expect(outcomesOf(scores)).toEqual({ [F1]: 'willStraighten', [F2]: 'unmeasurable' });
    expect(scores.verdicts().get(F1)?.profile).toEqual(first.verdicts().get(F1)?.profile);
    expect(await scores.ensure(F1)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('кэш другой версии геометрии или детектора и битый кэш пересчитываются и переписываются', async () => {
    const { store, layout, skewDir } = await sessionWith([FAN(), PHOTO(), PHOTO()]);
    const F3 = 'p01-s01-0003';
    await mkdir(skewDir, { recursive: true });
    const stale = (geometry: number, detector: number): string =>
      JSON.stringify({
        v: { geometry, detector },
        outcome: 'level',
        profile: null,
        contrast: null,
        fanMm: null,
        reason: null,
        source: { bytes: 1 },
      });
    await writeFile(join(skewDir, `${F1}.json`), stale(STRAIGHTEN_GEOMETRY_VERSION + 1, 1));
    await writeFile(join(skewDir, `${F2}.json`), stale(1, SKEW_DETECTOR_VERSION + 1));
    await writeFile(join(skewDir, `${F3}.json`), '{ не json');
    const { measurer, calls } = counting();
    const scores = createSkewScores(layout.derivedDir, store, measurer);

    await scores.load([F1, F2, F3]);
    expect(outcomesOf(scores)).toEqual({});
    expect(await Promise.all([scores.ensure(F1), scores.ensure(F2), scores.ensure(F3)])).toEqual([
      true,
      true,
      true,
    ]);

    expect(calls).toHaveLength(3);
    expect(outcomesOf(scores)).toEqual({
      [F1]: 'willStraighten',
      [F2]: 'unmeasurable',
      [F3]: 'unmeasurable',
    });
    expect(await readCache(skewDir, F1)).toMatchObject({
      v: { geometry: STRAIGHTEN_GEOMETRY_VERSION, detector: SKEW_DETECTOR_VERSION },
    });
  });

  it('не JPEG и исключение исполнителя — «не померить» с причиной в кэше; сбой чтения — без кэша до перезапуска', async () => {
    const { store, layout, skewDir } = await sessionWith([
      new TextEncoder().encode('<html>'),
      FAN(),
    ]);
    const scores = createSkewScores(layout.derivedDir, store, realMeasurer);
    expect(await scores.ensure(F1)).toBe(true);
    expect(outcomesOf(scores)).toEqual({ [F1]: 'unmeasurable' });
    expect(await readCache(skewDir, F1)).toMatchObject({ outcome: 'unmeasurable', profile: null });

    const throwing = createSkewScores(layout.derivedDir, store, () =>
      Promise.reject(new Error('libvips упал')),
    );
    expect(await throwing.ensure(F2)).toBe(true);
    expect(outcomesOf(throwing)).toEqual({ [F2]: 'unmeasurable' });
    expect(await readCache(skewDir, F2)).toMatchObject({
      outcome: 'unmeasurable',
      reason: expect.stringContaining('libvips') as string,
    });

    await rm(skewDir, { recursive: true, force: true });
    const failing: SkewScoreSource = {
      pageInfo: (key) => store.pageInfo(key),
      readPage: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'storageFailed', details: { reason: 'EBUSY' } },
        }),
    };
    const { measurer, calls } = counting();
    const unread = createSkewScores(layout.derivedDir, failing, measurer);
    expect(await unread.ensure(F2)).toBe(true);
    expect(outcomesOf(unread)).toEqual({ [F2]: 'unmeasurable' });
    expect(calls).toEqual([]);
    expect(await readdir(skewDir).catch(() => [])).toEqual([]);

    // Потерянная страница: у источника её нет — вердикта нет и измеритель не зовётся.
    const lost: SkewScoreSource = { pageInfo: () => null, readPage: (key) => store.readPage(key) };
    expect(await createSkewScores(layout.derivedDir, lost, measurer).ensure(F2)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('срок обработки (B-21) — «не померить» только в памяти, кэша нет; следующее открытие измерит заново', async () => {
    const { store, layout, skewDir } = await sessionWith([FAN()]);
    const { measurer: timingOut, calls: timedCalls } = counting(() =>
      Promise.reject(new ImageTimeoutError('тест: срок')),
    );

    const scores = createSkewScores(layout.derivedDir, store, timingOut);
    expect(await scores.ensure(F1)).toBe(true);
    await scores.settle();

    expect(outcomesOf(scores)).toEqual({ [F1]: 'unmeasurable' });
    expect(timedCalls).toHaveLength(1);
    expect(await readdir(skewDir).catch(() => [])).toEqual([]);

    // «Перезапуск»: кэша нет — страница измеряется по-настоящему и выправляется.
    const { measurer, calls } = counting();
    const again = createSkewScores(layout.derivedDir, store, measurer);
    await again.load([F1]);
    expect(outcomesOf(again)).toEqual({});
    expect(await again.ensure(F1)).toBe(true);
    expect(outcomesOf(again)).toEqual({ [F1]: 'willStraighten' });
    expect(calls).toHaveLength(1);
  });

  it('страница, отброшенная пока шло измерение, вердикта не получает; каталог не создаётся (KTD-12)', async () => {
    const { store, layout, skewDir } = await sessionWith([FAN()]);
    let asked = 0;
    const source: SkewScoreSource = {
      // Первый вопрос — до измерения, дальше — после: к этому времени страницы уже нет.
      pageInfo: (key) => ((asked += 1) === 1 ? store.pageInfo(key) : null),
      readPage: (key) => store.readPage(key),
    };
    const scores = createSkewScores(layout.derivedDir, source, realMeasurer);

    expect(await scores.ensure(F1)).toBe(false);

    expect(outcomesOf(scores)).toEqual({});
    expect(await readdir(skewDir).catch(() => 'нет')).toBe('нет');
  });

  it('abort отменяет идущее и ждущее измерение: вердикта и кэша нет, settle дожидается, следующий ensure измеряет', async () => {
    const { store, layout, skewDir } = await sessionWith([FAN(), PHOTO()]);
    const limiter = limiterOf(1);
    const slow = stubWorker({ gated: true, measure: () => Promise.resolve(null) });
    const scores = createSkewScores(layout.derivedDir, store, slow.measurer, { limiter });
    // Первое измерение держится, второе ждёт места в лимитере.
    const first = scores.ensure(F1);
    const second = scores.ensure(F2);
    await until(() => slow.started() === 1);

    scores.abort();
    let settled = false;
    const settle = scores.settle().then(() => {
      settled = true;
    });
    expect(await Promise.all([first, second])).toEqual([false, false]);
    await settle;
    expect(settled).toBe(true);
    // Ждавшее в очереди после отмены не начинало измерение.
    expect(slow.started()).toBe(1);
    expect(outcomesOf(scores)).toEqual({});
    expect(await readdir(skewDir).catch(() => 'нет')).toBe('нет');

    // Новый сигнал: следующий ensure работает как обычно.
    const again = createSkewScores(layout.derivedDir, store, realMeasurer, { limiter });
    expect(await again.ensure(F1)).toBe(true);
    expect(outcomesOf(again)).toEqual({ [F1]: 'willStraighten' });
  });

  it('измерение идёт в общем лимитере с низким приоритетом', async () => {
    const { store, layout } = await sessionWith([FAN()]);
    const priorities: LimiterPriority[] = [];
    const inner = limiterOf(2);
    const scores = createSkewScores(layout.derivedDir, store, realMeasurer, {
      limiter: (task, priority = 'normal') => {
        priorities.push(priority);
        return inner(task, priority);
      },
    });
    expect(await scores.ensure(F1)).toBe(true);
    expect(priorities).toEqual(['low']);
  });

  it('кэш прошлой сессии с тем же ключом не читается; prune после «Новой пачки» чистит карту', async () => {
    const { store, layout } = await sessionWith([FAN()]);
    const stale = join(layout.derivedDir, 'ffffffffffffffff', 'skew');
    await mkdir(stale, { recursive: true });
    await writeFile(
      join(stale, `${F1}.json`),
      JSON.stringify({
        v: { geometry: STRAIGHTEN_GEOMETRY_VERSION, detector: SKEW_DETECTOR_VERSION },
        outcome: 'level',
        profile: null,
        contrast: null,
        fanMm: null,
        reason: null,
        source: { bytes: 1 },
      }),
    );
    const { measurer, calls } = counting();
    const scores = createSkewScores(layout.derivedDir, store, measurer);
    await scores.load([F1]);
    expect(outcomesOf(scores)).toEqual({});
    expect(await scores.ensure(F1)).toBe(true);
    expect(calls).toHaveLength(1);

    unwrap(await store.closeSession());
    scores.prune();
    expect(outcomesOf(scores)).toEqual({});

    // Новая сессия с тем же ключом, но фото на странице: измеряется заново.
    unwrap(await store.beginPass(ORIGIN, null, 'hide', 'auto'));
    await store.acceptPage(body(PHOTO()));
    unwrap(await store.endSegment('completed'));
    expect(await scores.ensure(F1)).toBe(true);
    expect(outcomesOf(scores)).toEqual({ [F1]: 'unmeasurable' });
    expect(calls).toHaveLength(2);
  });
});
