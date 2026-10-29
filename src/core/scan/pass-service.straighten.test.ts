import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_EDITS,
  skewProfileOf,
  STRAIGHTEN_GEOMETRY_VERSION,
  type BlankMode,
  type SkewMeasure,
  type SkewOutcome,
  type StraightenMode,
} from '@shared';
import { pageFixture, pageFixtureNumberOf } from '../../../test/support/fixtures';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { stubWorker } from '../../../test/support/image-worker';
import { until } from '../../../test/support/until';
import type { BlankDetector } from '../detect/blank';
import { layoutOf } from '../storage/layout';
import { openPassService } from './pass-service';

// Измерение перекоса в службе прохода (план M6, U5; R6, KTD-4, KTD-12): исполнитель подставной —
// решает по номеру страницы-фикстуры, детектор пустоты тоже; страницы настоящие JPEG
// устройства. Настоящий детектор на сканах — `test/integration/skew-scores.test.ts`, проход с
// измерением по ходу — `test/integration/straighten.emulator.test.ts`.

const SESSION = 'a1b2c3d4e5f60718';
const F = (index: number): string => `p01-s01-${String(index).padStart(4, '0')}`;
const B = (index: number): string => `p02-s01-${String(index).padStart(4, '0')}`;
const A = (index: number): string => `p03-s01-${String(index).padStart(4, '0')}`;

interface Seed {
  readonly fronts: number;
  readonly backs?: number;
  /** Односторонний добавленный набор после первой лицевой. */
  readonly added?: number;
  readonly blankMode?: BlankMode;
  readonly straighten?: StraightenMode;
  readonly notBlank?: readonly string[];
  /** Ключи, чьи файлы не пишутся: потерянные страницы. */
  readonly lost?: readonly string[];
}

/** Сессия на диске (журнал v8): лица — фикстуры 1..n, обороты — 11.., добавленные — 21.. */
async function seedSession(root: string, seed: Seed): Promise<void> {
  const layout = layoutOf(root);
  await mkdir(layout.pagesDir, { recursive: true });
  const passes = [
    { number: 1, kind: 'fronts', pages: seed.fronts, from: 1, after: null },
    { number: 2, kind: 'backs', pages: seed.backs ?? 0, from: 11, after: null },
    { number: 3, kind: 'added', pages: seed.added ?? 0, from: 21, after: F(1) },
  ].filter((pass) => pass.pages > 0);
  await writeFile(
    layout.journalFile,
    JSON.stringify({
      version: 8,
      sessionId: SESSION,
      nextPass: 4,
      passes: passes.map((pass) => ({
        number: pass.number,
        accepted: false,
        origin: null,
        nextSegment: 2,
        segments: [{ number: 1, state: 'completed', pageCount: pass.pages }],
        rotate180: false,
        kind: pass.kind,
        after: pass.after,
        pair: null,
        backsDecision: null,
      })),
      deletions: [],
      backsDeclined: false,
      saved: false,
      edits: { ...EMPTY_EDITS, notBlank: seed.notBlank ?? [] },
      assembled: null,
      blankMode: seed.blankMode ?? 'hide',
      straighten: seed.straighten ?? 'auto',
    }),
  );
  for (const pass of passes) {
    for (let index = 1; index <= pass.pages; index += 1) {
      const key = `p${String(pass.number).padStart(2, '0')}-s01-${String(index).padStart(4, '0')}`;
      if (!(seed.lost ?? []).includes(key)) {
        await writeFile(join(layout.pagesDir, `${key}.jpg`), pageFixture(pass.from + index - 1));
      }
    }
  }
}

const measureOf = (outcome: SkewOutcome): SkewMeasure => ({
  outcome,
  geometryVersion: STRAIGHTEN_GEOMETRY_VERSION,
  profile:
    outcome === 'unmeasurable'
      ? null
      : skewProfileOf([
          { u: 0.2, theta: 0 },
          { u: 0.8, theta: 0.6 },
        ]),
  contrast: null,
  fanMm: null,
  bands: [],
  bandMm: 30,
  coverage: 1,
  shapeResidual: null,
  reason: null,
});

/**
 * Подставной исполнитель: фикстуры с номерами из `skewed` — «выправлять», остальные — «ровно»;
 * `gated` держит ответы до `release`; `calls` — номера измеренных фикстур.
 */
function workerOf(skewed: readonly number[], options: { gated?: boolean } = {}) {
  const stub = stubWorker({
    ...options,
    measure: (bytes) =>
      Promise.resolve(
        measureOf(skewed.includes(pageFixtureNumberOf(bytes)) ? 'willStraighten' : 'level'),
      ),
  });
  const calls = {
    get length(): number {
      return stub.calls.length;
    },
    toArray: (): number[] => stub.calls.map(pageFixtureNumberOf),
  };
  return { worker: stub.worker, calls, release: stub.release };
}

/** Детектор пустоты: фикстуры с номерами из `blank` — пусто. */
const blankDetectorOf =
  (blank: readonly number[]): BlankDetector =>
  (bytes) =>
    Promise.resolve(blank.includes(pageFixtureNumberOf(bytes)) ? 0 : 0.03);

const skewDir = (root: string): string => join(layoutOf(root).derivedDir, SESSION, 'skew');
const skewFiles = async (root: string): Promise<string[]> =>
  (await readdir(skewDir(root)).catch(() => [])).filter((name) => name.endsWith('.json')).sort();

describe('служба прохода: измерение перекоса (M6, U5)', () => {
  it('«выравнивать»: лица, добавленные и непустые обороты измеряются после открытия; скрытый пустой — нет; каждый исход — файл в skew/', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, { fronts: 2, backs: 2, added: 1 });
    const { worker, calls } = workerOf([1, 12]);
    const seen: number[] = [];
    const service = await openPassService(root, {
      imageWorker: worker,
      blankDetector: blankDetectorOf([11]),
      onChange: (seq) => seen.push(seq),
    });

    await until(() => calls.length === 4);
    await expect.poll(() => skewFiles(root)).toHaveLength(4);

    expect(calls.toArray().sort((p, q) => p - q)).toEqual([1, 2, 12, 21]);
    expect(await skewFiles(root)).toEqual(
      [`${F(1)}.json`, `${F(2)}.json`, `${B(2)}.json`, `${A(1)}.json`].sort(),
    );
    // Каждый новый вердикт — снимок.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(service.snapshot().assembly?.blank.hidden).toBe(1);
  });

  it('«Это не пустая страница» ставит скрытый оборот под измерение', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, { fronts: 1, backs: 1 });
    const { worker, calls } = workerOf([]);
    const service = await openPassService(root, {
      imageWorker: worker,
      blankDetector: blankDetectorOf([11]),
    });
    await until(() => service.snapshot().assembly?.blank.pending === 0);
    await until(() => calls.length === 1);
    expect(calls.toArray()).toEqual([1]);

    expect(await service.setEdits({ ...EMPTY_EDITS, notBlank: [B(1)] }, {})).toMatchObject({
      ok: true,
    });

    await until(() => calls.length === 2);
    expect(calls.toArray()).toEqual([1, 11]);
  });

  it('«не выравнивать»: исполнитель не вызывается, каталога skew/ нет; потерянная страница не измеряется', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, { fronts: 2, backs: 1, straighten: 'off' });
    const { worker, calls } = workerOf([1]);
    const service = await openPassService(root, {
      imageWorker: worker,
      blankDetector: blankDetectorOf([]),
    });
    await until(() => service.snapshot().assembly?.blank.pending === 0);
    expect(calls.toArray()).toEqual([]);
    expect(await skewFiles(root)).toEqual([]);

    const lostRoot = await makeTempDataRoot();
    await seedSession(lostRoot, { fronts: 2, lost: [F(2)] });
    const lost = workerOf([]);
    await openPassService(lostRoot, { imageWorker: lost.worker });
    await until(() => lost.calls.length === 1);
    expect(lost.calls.toArray()).toEqual([1]);
  });

  it('перезапуск с кэшем: исполнитель не вызывается, кэш прочитан при открытии', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, { fronts: 2, blankMode: 'keep' });
    const first = workerOf([1]);
    await openPassService(root, { imageWorker: first.worker });
    await expect.poll(() => skewFiles(root)).toHaveLength(2);

    const again = workerOf([1]);
    const service = await openPassService(root, { imageWorker: again.worker });
    await service.setEdits(EMPTY_EDITS, {});
    expect(again.calls.toArray()).toEqual([]);
  });

  it('«Новая пачка» посреди измерения отменяет его: производное удалено и не пересоздано, исполнитель отпущен позже', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, { fronts: 2, blankMode: 'keep' });
    const { worker, calls, release } = workerOf([1], { gated: true });
    const service = await openPassService(root, { imageWorker: worker });
    await until(() => calls.length === 2);

    expect(await service.closeSession()).toEqual({ ok: true, value: undefined });
    release();
    await service.settleDerived();

    expect(await readdir(layoutOf(root).derivedDir).catch(() => [])).toEqual([]);
    expect(service.snapshot().session).toBeNull();
  });
});
