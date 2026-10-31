import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  skewProfileOf,
  STRAIGHTEN_GEOMETRY_VERSION,
  type SkewOutcome,
  type SkewVerdict,
} from '@shared';
import { pageFixture } from '../../../test/support/fixtures';
import { unwrap } from '../../../test/support/result';
import { ORIGIN, body } from '../../../test/support/session-store';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { until } from '../../../test/support/until';
import type { ImageWorker } from '../image/image-worker';
import { STRAIGHT_SIZE_RATIO, STRAIGHTEN_ENCODING } from '../image/straighten';
import { SKEW_DETECTOR_VERSION } from '../detect/skew';
import {
  layoutOf,
  straightFileName,
  straightRecordName,
  UNKNOWN_DETECTOR,
} from '../storage/layout';
import { openSessionStore } from '../storage/reconcile';
import { realStorageFs } from '../storage/storage-fs';
import { createStraightened } from '../storage/straightened';
import { createStraightenQueue, type StraightenQueueDeps } from './straighten-flow';

// Очередь коррекции (план M6, U11; R27; KTD-12, KTD-13) на настоящем хранилище сессии и
// настоящих выправленных файлах; ресэмплер подставной — исход коррекции задаёт тест. Проводка в
// службе — `test/integration/straighten.emulator.test.ts`.

const K = (index: number): string => `p01-s01-${String(index).padStart(4, '0')}`;
const V = STRAIGHTEN_GEOMETRY_VERSION;
const D = SKEW_DETECTOR_VERSION;
/** Имена текущей пары страницы. */
const pairOf = (key: string, version = V, detector = D): string[] =>
  [straightFileName(key, version, detector), straightRecordName(key, version, detector)].sort();

/** Пара прежних версий на диске — как от прошлого приложения; `load` читает её как годную. */
async function stalePair(dir: string, key: string, detector: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  const name = straightFileName(key, V, detector);
  await writeFile(join(dir, name), new Uint8Array(30).fill(7));
  await writeFile(
    join(dir, straightRecordName(key, V, detector)),
    JSON.stringify({
      v: V,
      ...(detector === UNKNOWN_DETECTOR ? {} : { detector }),
      encoding: STRAIGHTEN_ENCODING,
      dpi: 300,
      file: { name, bytes: 30 },
    }),
  );
}
const PROFILE = skewProfileOf([
  { u: 0.2, theta: 0 },
  { u: 0.8, theta: 0.6 },
]);

const verdictOf = (outcome: SkewOutcome): SkewVerdict => ({
  outcome,
  cause: outcome === 'unmeasurable' ? 'content' : null,
  profile: outcome === 'unmeasurable' ? null : PROFILE,
});

/** Подставной ресэмплер: держит ответы при `gated`, слушает отмену; `fail` — страницы со сбоем. */
function straightenerOf(options: { gated?: boolean; fail?: readonly string[] } = {}) {
  const calls: number[] = [];
  let release = (): void => undefined;
  const gate =
    options.gated === true
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve();
  const worker: Pick<ImageWorker, 'straighten'> = {
    straighten: async (bytes, _profile, job) => {
      calls.push(bytes.byteLength);
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          reject(new Error('коррекция отменена'));
        };
        job.signal?.addEventListener('abort', abort, { once: true });
        void gate.then(() => {
          job.signal?.removeEventListener('abort', abort);
          resolve();
        });
      });
      // Сбой — по размеру входа: страница-фикстура узнаётся по байтам.
      if ((options.fail ?? []).some((key) => key === `bytes:${bytes.byteLength}`)) {
        return null;
      }
      return {
        jpeg: new Uint8Array(100).fill(1),
        info: { width: 8, height: 8, channels: 1 as const },
        encoding: STRAIGHTEN_ENCODING,
        dpi: 300,
      };
    },
  };
  return {
    worker,
    calls,
    release: (): void => {
      release();
    },
  };
}

async function setup(
  pages: number,
  verdicts: ReadonlyMap<string, SkewVerdict>,
  overrides: Partial<StraightenQueueDeps> = {},
  fs = realStorageFs,
) {
  const root = await makeTempDataRoot();
  const layout = layoutOf(root);
  const { store } = await openSessionStore(root, { fs });
  unwrap(await store.beginPass(ORIGIN, null, 'hide', 'auto'));
  for (let index = 1; index <= pages; index += 1) {
    await store.acceptPage(body(pageFixture(index)));
  }
  unwrap(await store.endSegment('completed'));
  const sessionId = store.snapshot()?.id ?? '';
  const straightened = createStraightened(layout.derivedDir, store, { fs });
  const changes: number[] = [];
  const straightener = straightenerOf();
  const queue = createStraightenQueue({
    source: store,
    skew: { verdicts: () => verdicts },
    straightened,
    worker: straightener.worker,
    freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    minFreeBytes: 1,
    onChange: () => {
      changes.push(changes.length + 1);
    },
    ...overrides,
  });
  const dir = join(layout.derivedDir, sessionId, 'straight');
  const files = async (): Promise<string[]> =>
    (await readdir(dir).catch(() => [])).filter((name) => !name.endsWith('.tmp')).sort();
  return { root, layout, store, straightened, queue, straightener, changes, dir, files };
}

const sizeOf = (index: number): number => pageFixture(index).byteLength;

describe('очередь коррекции', () => {
  it('принимает только «выправлять» без пары текущих версий; пишет JPEG и запись; снимок на каждый исход', async () => {
    const verdicts = new Map([
      [K(1), verdictOf('willStraighten')],
      [K(2), verdictOf('level')],
      [K(3), verdictOf('notImproved')],
      [K(4), verdictOf('unmeasurable')],
    ]);
    const { queue, straightened, straightener, changes, files } = await setup(4, verdicts);

    queue.ensureAll();
    expect(queue.state().queued).toEqual([K(1)]);
    await queue.settle();

    expect(await files()).toEqual(pairOf(K(1)));
    expect(straightened.resolve(K(1))).toMatchObject({ version: V, detector: D });
    expect(straightener.calls).toEqual([sizeOf(1)]);
    expect(changes).toHaveLength(1);
    // Повторный ensureAll: запись уже есть — ничего.
    queue.ensureAll();
    expect(queue.state().queued).toEqual([]);
    await queue.settle();
    expect(straightener.calls).toHaveLength(1);
  });

  it('одна задача за раз: вторая ждёт первую; abort отменяет текущую и очищает очередь — страницы без записи; settle дожидается', async () => {
    const verdicts = new Map([
      [K(1), verdictOf('willStraighten')],
      [K(2), verdictOf('willStraighten')],
    ]);
    const gated = straightenerOf({ gated: true });
    const { queue, straightener, files, dir } = await setup(2, verdicts, {
      worker: gated.worker,
    });

    queue.enqueue(K(1));
    queue.enqueue(K(2));
    await until(() => gated.calls.length === 1);
    expect(queue.state()).toMatchObject({ running: K(1), queued: [K(1), K(2)] });

    queue.abort();
    await queue.settle();
    gated.release();

    expect(queue.state()).toMatchObject({ running: null, queued: [] });
    expect(gated.calls).toHaveLength(1);
    expect(straightener.calls).toEqual([]);
    expect(await files()).toEqual([]);
    expect(await readdir(dir).catch(() => 'нет')).toBe('нет');

    // После отмены очередь принимает снова.
    const fresh = straightenerOf();
    const again = await setup(1, new Map([[K(1), verdictOf('willStraighten')]]), {
      worker: fresh.worker,
    });
    again.queue.enqueue(K(1));
    await again.queue.settle();
    expect(await again.files()).toHaveLength(2);
  });

  it('сбой коррекции — deferred «failed», очередь идёт дальше, повтора в сессии нет', async () => {
    const verdicts = new Map([
      [K(1), verdictOf('willStraighten')],
      [K(2), verdictOf('willStraighten')],
    ]);
    const failing = straightenerOf({ fail: [`bytes:${sizeOf(1)}`] });
    const { queue, files, changes } = await setup(2, verdicts, { worker: failing.worker });

    queue.ensureAll();
    await queue.settle();

    expect(await files()).toEqual(pairOf(K(2)));
    expect([...queue.state().deferred]).toEqual([[K(1), 'failed']]);
    expect(changes).toHaveLength(2);
    queue.ensureAll();
    await queue.settle();
    expect(failing.calls).toHaveLength(2);
  });

  it('мало места — deferred «noSpace» без постоянного вердикта: место появилось → ensureAll выправляет (AE15); неизвестно — идёт', async () => {
    const verdicts = new Map([[K(1), verdictOf('willStraighten')]]);
    let free = sizeOf(1) * STRAIGHT_SIZE_RATIO; // ровно на выход, резерва нет
    const { queue, files } = await setup(1, verdicts, {
      freeBytes: () => Promise.resolve(free),
      minFreeBytes: 1,
    });

    queue.ensureAll();
    await queue.settle();
    expect([...queue.state().deferred]).toEqual([[K(1), 'noSpace']]);
    expect(await files()).toEqual([]);

    // «Следующее открытие сессии» — прежняя причина забыта, место есть.
    free = Number.MAX_SAFE_INTEGER;
    const reopened = await setup(1, verdicts, { freeBytes: () => Promise.resolve(free) });
    reopened.queue.ensureAll();
    await reopened.queue.settle();
    expect(await reopened.files()).toHaveLength(2);

    const unknown = await setup(1, verdicts, { freeBytes: () => Promise.reject(new Error('?')) });
    unknown.queue.ensureAll();
    await unknown.queue.settle();
    expect(await unknown.files()).toHaveLength(2);
  });

  it('ENOSPC при записи — временный файл убран, deferred «noSpace», очередь продолжает остальные', async () => {
    const verdicts = new Map([
      [K(1), verdictOf('willStraighten')],
      [K(2), verdictOf('willStraighten')],
    ]);
    let failures = 0;
    const fs = {
      ...realStorageFs,
      rename: (from: string, to: string) => {
        if (from.includes('straight') && from.includes(K(1)) && failures === 0) {
          failures += 1;
          return Promise.reject(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
        }
        return realStorageFs.rename(from, to);
      },
    };
    const { queue, dir } = await setup(2, verdicts, {}, fs);

    queue.ensureAll();
    await queue.settle();

    expect([...queue.state().deferred]).toEqual([[K(1), 'noSpace']]);
    expect((await readdir(dir)).sort()).toEqual(pairOf(K(2)));
  });

  it('пара той же геометрии с чужим детектором или прежнего формата — пересчёт: новая пара рядом, прежняя убрана (B-19)', async () => {
    const verdicts = new Map([
      [K(1), verdictOf('willStraighten')],
      [K(2), verdictOf('willStraighten')],
    ]);
    const { queue, straightened, straightener, dir, files } = await setup(2, verdicts);
    await stalePair(dir, K(1), D + 1);
    await stalePair(dir, K(2), UNKNOWN_DETECTOR);
    await straightened.load([K(1), K(2)]);
    expect(straightened.resolve(K(2))).toMatchObject({ version: V, detector: UNKNOWN_DETECTOR });

    queue.ensureAll();
    expect(queue.state().queued).toEqual([K(1), K(2)]);
    await queue.settle();

    expect(straightener.calls).toHaveLength(2);
    expect(await files()).toEqual([...pairOf(K(1)), ...pairOf(K(2))]);
    expect(straightened.resolve(K(2))).toMatchObject({ version: V, detector: D });
  });

  it('вердикт не «выправлять» у страницы с парой прежних версий — пара убрана, снимок обновлён; под hold — после отпускания (B-19)', async () => {
    const verdicts = new Map([
      [K(1), verdictOf('level')],
      [K(2), verdictOf('unmeasurable')],
    ]);
    const { queue, straightened, straightener, dir, files, changes } = await setup(2, verdicts);
    await stalePair(dir, K(1), D + 1);
    await stalePair(dir, K(2), UNKNOWN_DETECTOR);
    await straightened.load([K(1), K(2)]);
    const release = straightened.hold();

    queue.ensureAll();
    expect(queue.state().queued).toEqual([]);
    await until(() => changes.length === 2);

    // Записи сняты сразу, файлы — после отпускания пакета.
    expect(straightened.resolve(K(1))).toBeNull();
    expect(straightened.resolve(K(2))).toBeNull();
    expect(await files()).toHaveLength(4);
    release();
    await expect.poll(files).toEqual([]);
    expect(straightener.calls).toEqual([]);
  });

  it('abort посреди пересчёта — новой пары нет, прежняя на месте', async () => {
    const verdicts = new Map([[K(1), verdictOf('willStraighten')]]);
    const gated = straightenerOf({ gated: true });
    const { queue, straightened, dir, files } = await setup(1, verdicts, { worker: gated.worker });
    await stalePair(dir, K(1), UNKNOWN_DETECTOR);
    await straightened.load([K(1)]);

    queue.enqueue(K(1));
    await until(() => gated.calls.length === 1);
    queue.abort();
    await queue.settle();
    gated.release();

    expect(await files()).toEqual(pairOf(K(1), V, UNKNOWN_DETECTOR));
    expect(straightened.resolve(K(1))).toMatchObject({ version: V, detector: UNKNOWN_DETECTOR });
  });

  it('prune забывает отложенные и ждущие страницы закрытой сессии', async () => {
    const verdicts = new Map([[K(1), verdictOf('willStraighten')]]);
    const failing = straightenerOf({ fail: [`bytes:${sizeOf(1)}`] });
    const { queue, store } = await setup(1, verdicts, { worker: failing.worker });
    queue.ensureAll();
    await queue.settle();
    expect(queue.state().deferred.size).toBe(1);

    unwrap(await store.closeSession());
    queue.prune();

    expect(queue.state().deferred.size).toBe(0);
  });
});
