import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BLANK_DETECTOR_VERSION,
  blankRatio,
  type BlankDetector,
} from '../../src/core/detect/blank';
import type { PassOrigin } from '../../src/core/storage/journal';
import { layoutOf } from '../../src/core/storage/layout';
import { openSessionStore } from '../../src/core/storage/reconcile';
import {
  createBlankScores,
  type BlankScores,
  type BlankScoreSource,
} from '../../src/core/storage/blank-scores';
import type { SessionStore } from '../../src/core/storage/session-store';
import { realStorageFs } from '../../src/core/storage/storage-fs';
import { dirSnapshot } from '../support/dir-snapshot';
import { pageFixture, scanFixture } from '../support/fixtures';
import { unwrap } from '../support/result';
import { makeTempDataRoot } from '../support/temp-data-root';

// Оценки пустых страниц на настоящем `sharp`, настоящих сканах ET-3850 и настоящем хранилище
// сессии во временном корне данных (план M4, U4, KTD3) — по образцу `thumbnails.test.ts`.

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

const BLANK = () => scanFixture('blank-gray-300');
const TEXT = () => scanFixture('text-gray-300');
const B1 = 'p02-s01-0001';
const B2 = 'p02-s01-0002';

/** Сессия: лицевые из синтетических страниц, обороты — из заданных байтов; режим «Скрывать». */
async function sessionWith(backs: readonly Uint8Array[], root?: string) {
  const dataRoot = root ?? (await makeTempDataRoot());
  const layout = layoutOf(dataRoot);
  const { store } = await openSessionStore(dataRoot);
  if (store.snapshot() === null) {
    unwrap(await store.beginPass(ORIGIN, null, 'hide'));
    for (const index of backs.keys()) {
      await store.acceptPage(body(pageFixture(index + 1)));
    }
    unwrap(await store.endSegment('completed'));
    unwrap(await store.beginPass(ORIGIN, null));
    for (const page of backs) {
      await store.acceptPage(body(page));
    }
    unwrap(await store.endSegment('completed'));
  }
  const sessionId = store.snapshot()?.id ?? '';
  const blankDir = join(layout.derivedDir, sessionId, 'blank');
  return { root: dataRoot, layout, store, sessionId, blankDir };
}

/** Детектор, который считает вызовы. */
function counting(detector: BlankDetector = blankRatio) {
  const calls: number[] = [];
  const counted: BlankDetector = (bytes, limit) => {
    calls.push(bytes.byteLength);
    return detector(bytes, limit);
  };
  return { detector: counted, calls };
}

const verdictsOf = (scores: BlankScores) => Object.fromEntries(scores.verdicts());

describe('оценки пустых страниц: детектор, карта и кэш', () => {
  it('оборот-скан пустой — вердикт «пусто», с текстом — нет; кэш с версией и долей', async () => {
    const { store, layout, blankDir } = await sessionWith([BLANK(), TEXT()]);
    const { detector, calls } = counting();
    const scores = createBlankScores(layout.derivedDir, store, detector);
    const before = await dirSnapshot(layout.sessionDir);

    expect(await Promise.all([scores.ensure(B1), scores.ensure(B2)])).toEqual([true, true]);

    expect(verdictsOf(scores)).toEqual({ [B1]: true, [B2]: false });
    expect(calls).toHaveLength(2);
    expect((await readdir(blankDir)).sort()).toEqual([`${B1}.json`, `${B2}.json`]);
    const cached = JSON.parse(
      await readFile(join(blankDir, B1), 'utf8').catch(() => 'null'),
    ) as unknown;
    expect(cached).toBeNull();
    const blank = JSON.parse(await readFile(join(blankDir, `${B1}.json`), 'utf8')) as {
      v: number;
      ratio: number;
    };
    expect(blank.v).toBe(BLANK_DETECTOR_VERSION);
    expect(blank.ratio).toBeLessThan(0.0005);
    const text = JSON.parse(await readFile(join(blankDir, `${B2}.json`), 'utf8')) as {
      ratio: number;
    };
    expect(text.ratio).toBeGreaterThan(0.01);
    // В каталог сессии ничего не записано.
    expect(await dirSnapshot(layout.sessionDir)).toEqual(before);
  });

  it('повторный ensure и одновременные запросы — один вызов детектора; лицо не оценивается', async () => {
    const { store, layout } = await sessionWith([BLANK()]);
    const { detector, calls } = counting();
    const scores = createBlankScores(layout.derivedDir, store, detector);

    const results = await Promise.all([scores.ensure(B1), scores.ensure(B1), scores.ensure(B1)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await scores.ensure(B1)).toBe(false);
    expect(calls).toHaveLength(1);
    // Лицевая страница — тоже страница сессии: модуль не знает ролей, их знает служба.
    expect(await scores.ensure('p01-s01-0001')).toBe(true);
    expect(await scores.ensure('p09-s01-0001')).toBe(false);
  });

  it('перезапуск: load читает кэш без детектора; ensure после load — ничего нового', async () => {
    const { root, layout } = await sessionWith([BLANK(), TEXT()]);
    const first = createBlankScores(
      layout.derivedDir,
      (await openSessionStore(root)).store,
      blankRatio,
    );
    await Promise.all([first.ensure(B1), first.ensure(B2)]);

    const { store } = await openSessionStore(root);
    const { detector, calls } = counting();
    const scores = createBlankScores(layout.derivedDir, store, detector);
    await scores.load([B1, B2, 'p01-s01-0001', 'p09-s01-0001']);

    expect(verdictsOf(scores)).toEqual({ [B1]: true, [B2]: false });
    expect(await scores.ensure(B1)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('кэш другой версии и битый кэш пересчитываются и переписываются', async () => {
    const { store, layout, blankDir } = await sessionWith([BLANK(), TEXT()]);
    await mkdir(blankDir, { recursive: true });
    await writeFile(
      join(blankDir, `${B1}.json`),
      JSON.stringify({ v: BLANK_DETECTOR_VERSION + 1, ratio: 0.5 }),
    );
    await writeFile(join(blankDir, `${B2}.json`), '{ не json');
    const { detector, calls } = counting();
    const scores = createBlankScores(layout.derivedDir, store, detector);

    await scores.load([B1, B2]);
    expect(verdictsOf(scores)).toEqual({});
    expect(await Promise.all([scores.ensure(B1), scores.ensure(B2)])).toEqual([true, true]);

    expect(calls).toHaveLength(2);
    expect(verdictsOf(scores)).toEqual({ [B1]: true, [B2]: false });
    expect(JSON.parse(await readFile(join(blankDir, `${B1}.json`), 'utf8'))).toMatchObject({
      v: BLANK_DETECTOR_VERSION,
    });
  });

  it('стёртый кэш перестраивается; исходники не изменились', async () => {
    const { store, layout } = await sessionWith([BLANK()]);
    const scores = createBlankScores(layout.derivedDir, store, blankRatio);
    await scores.ensure(B1);
    const before = await dirSnapshot(layout.sessionDir);
    await rm(layout.derivedDir, { recursive: true });

    const again = createBlankScores(layout.derivedDir, store, blankRatio);
    expect(await again.ensure(B1)).toBe(true);

    expect(verdictsOf(again)).toEqual({ [B1]: true });
    expect(await dirSnapshot(layout.sessionDir)).toEqual(before);
  });

  it('не JPEG, предел ниже размера и потерянный файл — не пусто; сбой декодирования в кэше как null', async () => {
    const { store, layout, blankDir } = await sessionWith([
      new TextEncoder().encode('<html>'),
      BLANK(),
    ]);
    const scores = createBlankScores(layout.derivedDir, store, blankRatio);

    expect(await scores.ensure(B1)).toBe(true);
    expect(verdictsOf(scores)).toEqual({ [B1]: false });
    expect(JSON.parse(await readFile(join(blankDir, `${B1}.json`), 'utf8'))).toEqual({
      v: BLANK_DETECTOR_VERSION,
      ratio: null,
    });

    // Предел прохода ниже размера страницы — тоже сбой, не пусто.
    const tight: BlankScoreSource = {
      pageInfo: (key) => {
        const info = store.pageInfo(key);
        return info === null ? null : { ...info, pixelLimit: 10 * 10 };
      },
      readPage: (key) => store.readPage(key),
    };
    const limited = createBlankScores(layout.derivedDir, tight, blankRatio);
    await rm(blankDir, { recursive: true, force: true });
    expect(await limited.ensure(B2)).toBe(true);
    expect(verdictsOf(limited)).toEqual({ [B2]: false });

    // Потерянная страница: у источника её нет — вердикта нет и детектор не зовётся.
    const { detector, calls } = counting();
    const lost: BlankScoreSource = { pageInfo: () => null, readPage: (key) => store.readPage(key) };
    expect(await createBlankScores(layout.derivedDir, lost, detector).ensure(B2)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('временный сбой чтения страницы — вердикт «не пусто» до перезапуска, кэша нет: следующее открытие оценит заново', async () => {
    const { store, layout, blankDir } = await sessionWith([BLANK()]);
    const failing: BlankScoreSource = {
      pageInfo: (key) => store.pageInfo(key),
      readPage: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'storageFailed', details: { reason: 'EBUSY' } },
        }),
    };
    const { detector, calls } = counting();

    const scores = createBlankScores(layout.derivedDir, failing, detector);
    expect(await scores.ensure(B1)).toBe(true);

    expect(verdictsOf(scores)).toEqual({ [B1]: false });
    expect(calls).toEqual([]);
    expect(await readdir(blankDir).catch(() => [])).toEqual([]);
    // «Перезапуск»: чтение снова работает — страница оценивается по-настоящему.
    const again = createBlankScores(layout.derivedDir, store, detector);
    expect(await again.ensure(B1)).toBe(true);
    expect(verdictsOf(again)).toEqual({ [B1]: true });
    expect(calls).toHaveLength(1);
  });

  it('страница, отброшенная пока шла оценка, вердикта не получает и в кэше не остаётся', async () => {
    const { store, layout, blankDir } = await sessionWith([BLANK()]);
    let asked = 0;
    const source: BlankScoreSource = {
      // Первый вопрос — до оценки, дальше — после: к этому времени страницы уже нет.
      pageInfo: (key) => ((asked += 1) === 1 ? store.pageInfo(key) : null),
      readPage: (key) => store.readPage(key),
    };
    const scores = createBlankScores(layout.derivedDir, source, blankRatio);

    expect(await scores.ensure(B1)).toBe(false);

    expect(verdictsOf(scores)).toEqual({});
    expect(await readdir(blankDir).catch(() => [])).toEqual([]);
  });

  it('abort во время детектора — кэша нет, вердикта нет, settle разрешается; следующий ensure оценивает заново (B-18)', async () => {
    const { store, layout, blankDir } = await sessionWith([BLANK()]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const slow: BlankDetector = async (bytes, limit) => {
      calls += 1;
      await gate;
      return blankRatio(bytes, limit);
    };
    const scores = createBlankScores(layout.derivedDir, store, slow);

    const first = scores.ensure(B1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    scores.abort();
    release();
    await scores.settle();

    expect(await first).toBe(false);
    expect(verdictsOf(scores)).toEqual({});
    expect(await readdir(blankDir).catch(() => [])).toEqual([]);

    // После отмены — как обычно: страница оценивается заново и кэшируется.
    expect(await scores.ensure(B1)).toBe(true);
    expect(calls).toBe(2);
    expect(verdictsOf(scores)).toEqual({ [B1]: true });
    expect(await readdir(blankDir)).toEqual([`${B1}.json`]);
  });

  it('abort без идущих оценок — settle сразу; abort до старта задачи в лимитере — детектор не зовётся', async () => {
    const { store, layout, blankDir } = await sessionWith([BLANK(), TEXT()]);
    const { detector, calls } = counting();
    const scores = createBlankScores(layout.derivedDir, store, detector, { concurrency: 1 });
    scores.abort();
    await scores.settle();

    // Две оценки при одном слоте: вторая ждёт в лимитере, отмена снимает обе до записи.
    const both = Promise.all([scores.ensure(B1), scores.ensure(B2)]);
    scores.abort();
    await scores.settle();
    expect(await both).toEqual([false, false]);
    expect(calls.length).toBeLessThanOrEqual(1);
    expect(await readdir(blankDir).catch(() => [])).toEqual([]);
  });

  it('кэш прошлой сессии с тем же ключом не читается; prune после «Новой пачки» чистит карту', async () => {
    const { store, layout } = await sessionWith([BLANK()]);
    const stale = join(layout.derivedDir, 'ffffffffffffffff', 'blank');
    await mkdir(stale, { recursive: true });
    await writeFile(
      join(stale, `${B1}.json`),
      JSON.stringify({ v: BLANK_DETECTOR_VERSION, ratio: 0 }),
    );
    const { detector, calls } = counting();
    const scores = createBlankScores(layout.derivedDir, store, detector);
    await scores.load([B1]);
    expect(verdictsOf(scores)).toEqual({});
    expect(await scores.ensure(B1)).toBe(true);
    expect(calls).toHaveLength(1);

    unwrap(await store.closeSession());
    scores.prune();
    expect(verdictsOf(scores)).toEqual({});

    // Новая сессия с тем же ключом, но текстом на обороте: оценивается заново.
    unwrap(await store.beginPass(ORIGIN, null, 'hide'));
    await store.acceptPage(body(pageFixture(1)));
    unwrap(await store.endSegment('completed'));
    unwrap(await store.beginPass(ORIGIN, null));
    await store.acceptPage(body(TEXT()));
    unwrap(await store.endSegment('completed'));
    expect(await scores.ensure(B1)).toBe(true);
    expect(verdictsOf(scores)).toEqual({ [B1]: false });
    expect(calls).toHaveLength(2);
  });

  it('кэш не записался — вердикт всё равно действует', async () => {
    const { store, layout, blankDir } = await sessionWith([BLANK()]);
    const scores = createBlankScores(layout.derivedDir, store, blankRatio, {
      retry: { ceilingMs: 0 },
      fs: {
        ...realStorageFs,
        rename: () => Promise.reject(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })),
      },
    });

    expect(await scores.ensure(B1)).toBe(true);

    expect(verdictsOf(scores)).toEqual({ [B1]: true });
    expect(await readdir(blankDir).catch(() => [])).toEqual([]);
  });

  it('одновременных оценок — не больше заданного числа', async () => {
    const { store, layout } = await sessionWith([BLANK(), BLANK(), TEXT(), BLANK(), TEXT()]);
    let active = 0;
    let peak = 0;
    const detector: BlankDetector = async (bytes, limit) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await blankRatio(bytes, limit);
      } finally {
        active -= 1;
      }
    };
    const scores = createBlankScores(layout.derivedDir, store, detector, { concurrency: 2 });

    const keys = [1, 2, 3, 4, 5].map((index) => `p02-s01-000${index}`);
    expect(await Promise.all(keys.map((key) => scores.ensure(key)))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);

    expect(peak).toBe(2);
    expect(verdictsOf(scores)).toEqual({
      'p02-s01-0001': true,
      'p02-s01-0002': true,
      'p02-s01-0003': false,
      'p02-s01-0004': true,
      'p02-s01-0005': false,
    });
  });

  it('источник — хранилище сессии как есть: интерфейс совпадает', async () => {
    const { store, layout } = await sessionWith([BLANK()]);
    const source: BlankScoreSource = store satisfies SessionStore;

    expect(await createBlankScores(layout.derivedDir, source, blankRatio).ensure(B1)).toBe(true);
  });
});
