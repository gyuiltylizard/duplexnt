import { mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { parseCapabilities } from '../../src/core/escl/capabilities';
import type { PassOrigin } from '../../src/core/storage/journal';
import { layoutOf } from '../../src/core/storage/layout';
import { openSessionStore } from '../../src/core/storage/reconcile';
import type { SessionStore } from '../../src/core/storage/session-store';
import { realStorageFs } from '../../src/core/storage/storage-fs';
import {
  createThumbnails,
  decodePixelLimit,
  FALLBACK_PIXEL_LIMIT,
  MAX_PAGE_PIXELS,
  pagePixelLimit,
  THUMBNAIL_BOX,
  type ThumbnailSource,
} from '../../src/core/storage/thumbnails';
import { STRAIGHTEN_ENCODING, type StraightenResult } from '../../src/core/image/straighten';
import { SKEW_DETECTOR_VERSION } from '../../src/core/detect/skew';
import { straightFileName } from '../../src/core/storage/layout';
import { createStraightened } from '../../src/core/storage/straightened';
import { dirSnapshot } from '../support/dir-snapshot';
import { ET_3850, pageFixture, readFixture } from '../support/fixtures';
import { makeTempDataRoot } from '../support/temp-data-root';

// Миниатюры на настоящем `sharp` и настоящем хранилище сессии во временном корне данных.

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

const valueOf = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) {
    throw new Error(`ожидался успех: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

/** Сессия с завершённым проходом из заданных страниц. */
async function sessionWith(pages: readonly Uint8Array[], origin: PassOrigin = ORIGIN) {
  const root = await makeTempDataRoot();
  const layout = layoutOf(root);
  const { store } = await openSessionStore(root);
  valueOf(await store.beginPass(origin, null));
  for (const page of pages) {
    await store.acceptPage(body(page));
  }
  valueOf(await store.endSegment('completed'));
  return { root, layout, store, thumbnails: createThumbnails(layout.derivedDir, store) };
}

/** Источник, который считает чтения исходников. */
function counting(store: SessionStore) {
  const reads: string[] = [];
  const source: ThumbnailSource = {
    pageInfo: (key) => store.pageInfo(key),
    readPage: (key) => {
      reads.push(key);
      return store.readPage(key);
    },
  };
  return { source, reads };
}

const KEY = 'p01-s01-0001';
const failure = (reason: string) => ({
  ok: false,
  error: { code: 'thumbnailFailed', details: { reason } },
});
const UNAVAILABLE = { ok: false, error: { code: 'pageUnavailable' } };

describe('миниатюры', () => {
  it('миниатюра строится из страницы-фикстуры и берётся из кэша при втором запросе', async () => {
    const { store, layout } = await sessionWith([pageFixture(1), pageFixture(2)]);
    const { source, reads } = counting(store);
    const thumbnails = createThumbnails(layout.derivedDir, source);

    const first = valueOf(await thumbnails.get(KEY));
    const second = valueOf(await thumbnails.get(KEY));

    const metadata = await sharp(first).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBeLessThanOrEqual(THUMBNAIL_BOX.width);
    expect(metadata.height).toBe(THUMBNAIL_BOX.height);
    expect(second).toEqual(first);
    expect(reads).toEqual([KEY]);
    const sessionId = store.snapshot()?.id ?? '';
    expect(await readdir(join(layout.derivedDir, sessionId, 'thumbs'))).toEqual([`${KEY}.jpg`]);
  });

  it('стёртый кэш перестраивается, исходники не изменились (AE11)', async () => {
    const { layout, thumbnails } = await sessionWith([pageFixture(1), pageFixture(2)]);
    const first = valueOf(await thumbnails.get(KEY));
    const before = await dirSnapshot(layout.sessionDir);
    await rm(layout.derivedDir, { recursive: true });

    const rebuilt = valueOf(await thumbnails.get(KEY));

    expect(rebuilt).toEqual(first);
    expect(await dirSnapshot(layout.sessionDir)).toEqual(before);
  });

  it('после построения миниатюр в каталоге сессии не появилось новых файлов', async () => {
    const { layout, thumbnails } = await sessionWith([
      pageFixture(1),
      pageFixture(2),
      pageFixture(3),
    ]);
    const before = await dirSnapshot(layout.sessionDir);

    for (const key of ['p01-s01-0001', 'p01-s01-0002', 'p01-s01-0003']) {
      valueOf(await thumbnails.get(key));
    }

    expect(await dirSnapshot(layout.sessionDir)).toEqual(before);
    expect(Object.keys(before)).toHaveLength(5);
  });

  it('потерянная страница даёт отказ, а не пустое изображение, даже при тёплом кэше', async () => {
    const { root, layout, thumbnails } = await sessionWith([pageFixture(1), pageFixture(2)]);
    valueOf(await thumbnails.get(KEY));
    await unlink(join(layout.pagesDir, `${KEY}.jpg`));

    // Перезапуск: сверка находит запись без файла.
    const { store } = await openSessionStore(root);
    const afterRestart = createThumbnails(layout.derivedDir, store);

    expect(store.snapshot()?.passes[0]?.pages[0]).toMatchObject({ key: KEY, lost: true });
    const sessionId = store.snapshot()?.id ?? '';
    expect(await readdir(join(layout.derivedDir, sessionId, 'thumbs'))).toEqual([`${KEY}.jpg`]);
    expect(await afterRestart.get(KEY)).toMatchObject(UNAVAILABLE);
    expect(await afterRestart.get('p01-s01-0002')).toMatchObject({ ok: true });
  });

  it('ключ не из текущей сессии и мусор вместо ключа — отказ', async () => {
    const { thumbnails } = await sessionWith([pageFixture(1)]);

    for (const key of ['p01-s01-0002', 'p02-s01-0001', '../../settings', `${KEY}.jpg`, '']) {
      expect(await thumbnails.get(key)).toMatchObject(UNAVAILABLE);
    }
  });

  it('SVG, PNG и TIFF под видом страницы отклоняются до декодирования', async () => {
    const pixel = sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
    const png = await pixel.clone().png().toBuffer();
    const tiff = await pixel.clone().tiff().toBuffer();
    const { thumbnails, layout, store } = await sessionWith([svg, png, tiff]);

    for (const key of ['p01-s01-0001', 'p01-s01-0002', 'p01-s01-0003']) {
      expect(await thumbnails.get(key)).toEqual(failure('notJpeg'));
    }
    expect(await readdir(layout.derivedDir).catch(() => [])).toEqual([]);
    // Исходники при этом на месте: отказ миниатюры страницу не трогает.
    expect(store.snapshot()?.passes[0]?.pages.every((page) => !page.lost)).toBe(true);
  });

  it('JPEG с хвостом после маркера конца отклоняется по маркерам, хотя декодер его прочёл бы', async () => {
    const withTail = Buffer.concat([pageFixture(1), Buffer.from('хвост')]);
    const { thumbnails } = await sessionWith([withTail]);

    // Декодер такой файл читает: отказ даёт именно проверка маркеров, до декодирования.
    expect((await sharp(withTail).metadata()).format).toBe('jpeg');
    expect(await thumbnails.get(KEY)).toEqual(failure('notJpeg'));
  });

  it('PNG, обёрнутый в маркеры JPEG, не декодируется', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const disguised = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      png,
      Buffer.from([0xff, 0xd9]),
    ]);
    const { thumbnails } = await sessionWith([disguised]);

    expect(await thumbnails.get(KEY)).toEqual(failure('decode'));
  });

  it('изображение больше предела пикселей отклоняется', async () => {
    // Страница-фикстура — 1240 × 1754; предел прохода на один пиксель меньше.
    const { thumbnails } = await sessionWith([pageFixture(1)], {
      ...ORIGIN,
      pixelLimit: 1240 * 1754 - 1,
    });

    expect(await thumbnails.get(KEY)).toEqual(failure('tooLarge'));
  });

  it('предел ровно в размер страницы её пропускает', async () => {
    const { thumbnails } = await sessionWith([pageFixture(1)], {
      ...ORIGIN,
      pixelLimit: 1240 * 1754,
    });

    expect(await thumbnails.get(KEY)).toMatchObject({ ok: true });
  });

  it('миниатюра прошлой сессии с тем же ключом не отдаётся', async () => {
    const { store, layout, thumbnails } = await sessionWith([pageFixture(1)]);
    const stale = join(layout.derivedDir, 'ffffffffffffffff', 'thumbs');
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, `${KEY}.jpg`), pageFixture(7));
    const fromFirstSession = valueOf(await thumbnails.get(KEY));

    // Новая пачка: тот же ключ, другая страница.
    valueOf(await store.closeSession());
    valueOf(await store.beginPass(ORIGIN, null));
    await store.acceptPage(body(pageFixture(2)));
    valueOf(await store.endSegment('completed'));
    const fromSecondSession = valueOf(await thumbnails.get(KEY));

    expect(fromSecondSession).not.toEqual(fromFirstSession);
    expect(fromSecondSession).not.toEqual(new Uint8Array(pageFixture(7)));
    expect(fromFirstSession).not.toEqual(new Uint8Array(pageFixture(7)));
  });

  it('сканер не отвечает, кэш стёрт — миниатюры строятся по пределу из журнала', async () => {
    const { root, layout } = await sessionWith([pageFixture(1)], {
      ...ORIGIN,
      pixelLimit: 1240 * 1754 - 1,
    });
    await rm(layout.derivedDir, { recursive: true, force: true });

    // Перезапуск без сети: предел берётся из записи прохода, а не из capabilities.
    const { store } = await openSessionStore(root);

    expect(store.pageInfo(KEY)?.pixelLimit).toBe(1240 * 1754 - 1);
    expect(await createThumbnails(layout.derivedDir, store).get(KEY)).toEqual(failure('tooLarge'));
  });

  it('пересобранный журнал — действует фиксированный потолок', async () => {
    const { root, layout } = await sessionWith([pageFixture(1)], { ...ORIGIN, pixelLimit: 1 });
    await unlink(layout.journalFile);

    const { store, notices } = await openSessionStore(root);

    expect(notices).toContain('journalRebuilt');
    expect(store.pageInfo(KEY)?.pixelLimit).toBeNull();
    expect(await createThumbnails(layout.derivedDir, store).get(KEY)).toMatchObject({ ok: true });
    expect(FALLBACK_PIXEL_LIMIT).toBe(10_200 * 16_800);
  });

  it('страница, отброшенная, пока миниатюра строилась, не отдаётся и в кэше не остаётся', async () => {
    const { store, layout } = await sessionWith([pageFixture(1)]);
    let asked = 0;
    const source: ThumbnailSource = {
      // Первый вопрос — до построения, второй — после: к этому времени страницы уже нет.
      pageInfo: (key) => ((asked += 1) === 1 ? store.pageInfo(key) : null),
      readPage: (key) => store.readPage(key),
    };

    expect(await createThumbnails(layout.derivedDir, source).get(KEY)).toMatchObject(UNAVAILABLE);

    const sessionId = store.snapshot()?.id ?? '';
    expect(await readdir(join(layout.derivedDir, sessionId, 'thumbs'))).toEqual([]);
  });

  it('одновременные запросы одной страницы строят её один раз', async () => {
    const { store, layout } = await sessionWith([pageFixture(1)]);
    const { source, reads } = counting(store);
    const thumbnails = createThumbnails(layout.derivedDir, source);

    const results = await Promise.all([
      thumbnails.get(KEY),
      thumbnails.get(KEY),
      thumbnails.get(KEY),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(reads).toEqual([KEY]);
  });

  it('одновременных построений — не больше заданного числа', async () => {
    const { store, layout } = await sessionWith([1, 2, 3, 4, 5].map(pageFixture));
    // Построение идёт от чтения исходника до записи миниатюры в кэш.
    let active = 0;
    let peak = 0;
    const source: ThumbnailSource = {
      pageInfo: (key) => store.pageInfo(key),
      readPage: (key) => {
        active += 1;
        peak = Math.max(peak, active);
        return store.readPage(key);
      },
    };
    const thumbnails = createThumbnails(layout.derivedDir, source, {
      concurrency: 2,
      fs: {
        ...realStorageFs,
        rename: (from, to) => {
          active -= 1;
          return realStorageFs.rename(from, to);
        },
      },
    });

    const keys = [1, 2, 3, 4, 5].map((index) => `p01-s01-000${index}`);
    const results = await Promise.all(keys.map((key) => thumbnails.get(key)));

    expect(results.every((result) => result.ok)).toBe(true);
    expect(peak).toBe(2);
    const sessionId = store.snapshot()?.id ?? '';
    expect(await readdir(join(layout.derivedDir, sessionId, 'thumbs'))).toHaveLength(5);
  });
});

describe('миниатюры выправленных страниц (M6, U6; KTD-7)', () => {
  /** Имя текущей пары — и выправленного JPEG, и его миниатюры (B-19). */
  const CURRENT_THUMB = straightFileName(KEY, 1, SKEW_DETECTOR_VERSION);
  /** Исход коррекции — другая страница-фикстура: миниатюра из неё отличима от оригинала. */
  const resultOf = (fixture: number): StraightenResult => ({
    jpeg: new Uint8Array(pageFixture(fixture)),
    info: { width: 1240, height: 1754, channels: 1 },
    encoding: STRAIGHTEN_ENCODING,
    dpi: 300,
  });

  it('вариант straight строится из файла по записи о коррекции в straight-thumbs/ с версией; без записи — отказ; обычная миниатюра не трогается', async () => {
    const { store, layout } = await sessionWith([pageFixture(1), pageFixture(2)]);
    const straightened = createStraightened(layout.derivedDir, store);
    const thumbnails = createThumbnails(layout.derivedDir, store, { straightened });
    const sessionId = store.snapshot()?.id ?? '';
    const straightThumbs = join(layout.derivedDir, sessionId, 'straight-thumbs');

    expect(await thumbnails.getStraight(KEY)).toEqual({
      ok: false,
      error: { code: 'pageUnavailable', details: { reason: 'notStraightened' } },
    });
    expect(await readdir(straightThumbs).catch(() => 'нет')).toBe('нет');

    await straightened.store(KEY, resultOf(2));
    const straight = valueOf(await thumbnails.getStraight(KEY));
    const plain = valueOf(await thumbnails.get(KEY));
    const metadata = await sharp(straight).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.height).toBe(THUMBNAIL_BOX.height);
    // Миниатюра выправленной — из другого файла: отличается от обычной той же страницы.
    expect(Buffer.from(straight).equals(Buffer.from(plain))).toBe(false);
    expect(await readdir(straightThumbs)).toEqual([CURRENT_THUMB]);
    expect(await readdir(join(layout.derivedDir, sessionId, 'thumbs'))).toEqual([`${KEY}.jpg`]);
    // Повтор — из кэша, байт в байт.
    expect(valueOf(await thumbnails.getStraight(KEY))).toEqual(straight);
  });

  it('миниатюра версии новее известной и чужой ключ не трогаются; запись без файла нужного размера — отказ', async () => {
    const { store, layout } = await sessionWith([pageFixture(1)]);
    const straightened = createStraightened(layout.derivedDir, store);
    const thumbnails = createThumbnails(layout.derivedDir, store, { straightened });
    const sessionId = store.snapshot()?.id ?? '';
    const straightThumbs = join(layout.derivedDir, sessionId, 'straight-thumbs');
    await mkdir(straightThumbs, { recursive: true });
    await writeFile(join(straightThumbs, `${KEY}.v7.jpg`), Buffer.alloc(3, 1));
    await writeFile(join(straightThumbs, `p01-s01-0002.v7.jpg`), Buffer.alloc(3, 1));

    await straightened.store(KEY, resultOf(2));
    valueOf(await thumbnails.getStraight(KEY));
    // Прежние версии (у версии 1 их нет) убираются; новее известной — от будущего приложения,
    // не наша; чужой ключ не трогается.
    expect((await readdir(straightThumbs)).sort()).toEqual([
      CURRENT_THUMB,
      `${KEY}.v7.jpg`,
      `p01-s01-0002.v7.jpg`,
    ]);

    // Файл выправленной подменён другим размером: запись негодна — миниатюра не строится и не
    // отдаётся из кэша другой записи (кэш той же версии стёрт вместе с производным).
    await rm(straightThumbs, { recursive: true });
    await writeFile(join(layout.derivedDir, sessionId, 'straight', CURRENT_THUMB), Buffer.alloc(9));
    expect(await thumbnails.getStraight(KEY)).toMatchObject({
      ok: false,
      error: { code: 'pageUnavailable' },
    });
  });

  it('страница, отброшенная, пока строилась миниатюра выправленной, не отдаётся и в кэше не остаётся', async () => {
    const { store, layout } = await sessionWith([pageFixture(1)]);
    const straightened = createStraightened(layout.derivedDir, store);
    await straightened.store(KEY, resultOf(2));
    let asked = 0;
    const source: ThumbnailSource = {
      // Первый вопрос — до построения, второй — после: к этому времени страницы уже нет.
      pageInfo: (key) => ((asked += 1) === 1 ? store.pageInfo(key) : null),
      readPage: (key) => store.readPage(key),
    };
    const thumbnails = createThumbnails(layout.derivedDir, source, { straightened });

    expect(await thumbnails.getStraight(KEY)).toMatchObject(UNAVAILABLE);
    const sessionId = store.snapshot()?.id ?? '';
    expect(await readdir(join(layout.derivedDir, sessionId, 'straight-thumbs'))).toEqual([]);
  });
});

describe('миниатюры: кэш — по возможности', () => {
  it('кэш не записался — миниатюра всё равно отдаётся', async () => {
    const { store, layout } = await sessionWith([pageFixture(1)]);
    const thumbnails = createThumbnails(layout.derivedDir, store, {
      retry: { ceilingMs: 0 },
      fs: {
        ...realStorageFs,
        rename: () => Promise.reject(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })),
      },
    });

    const thumbnail = valueOf(await thumbnails.get(KEY));

    expect((await sharp(thumbnail).metadata()).format).toBe('jpeg');
    const sessionId = store.snapshot()?.id ?? '';
    expect(await readdir(join(layout.derivedDir, sessionId, 'thumbs'))).toEqual([]);
  });

  it('файл кэша нулевой длины не отдаётся: миниатюра строится заново', async () => {
    const { store, layout, thumbnails } = await sessionWith([pageFixture(1)]);
    const sessionId = store.snapshot()?.id ?? '';
    const thumbs = join(layout.derivedDir, sessionId, 'thumbs');
    await mkdir(thumbs, { recursive: true });
    await writeFile(join(thumbs, `${KEY}.jpg`), new Uint8Array(0));

    const thumbnail = valueOf(await thumbnails.get(KEY));

    expect(thumbnail.byteLength).toBeGreaterThan(0);
    expect((await sharp(thumbnail).metadata()).format).toBe('jpeg');
  });
});

describe('предел пикселей страницы', () => {
  it('ET-3850: наибольший регион автоподачи при наибольшем разрешении — 5100 × 8400', () => {
    const capabilities = parseCapabilities(readFixture(...ET_3850, 'ScannerCapabilities.xml'));
    if (!capabilities.ok) {
      throw new Error('фикстура capabilities не разобрана');
    }

    expect(pagePixelLimit(capabilities.value.adf)).toBe(5100 * 8400);
  });

  it('доли пикселя округляются вверх', () => {
    const adf = {
      minWidth: 1,
      minHeight: 1,
      maxWidth: 2551,
      maxHeight: 4201,
      colorModes: ['RGB24' as const],
      documentFormats: ['image/jpeg' as const],
      resolutions: [100, 200],
    };

    expect(pagePixelLimit(adf)).toBe(1701 * 2801);
  });
  it('предел не выше потолка в коде, что бы ни заявило устройство', () => {
    const adf = {
      minWidth: 1,
      minHeight: 1,
      maxWidth: 30_000,
      maxHeight: 30_000,
      colorModes: ['RGB24' as const],
      documentFormats: ['image/jpeg' as const],
      resolutions: [9600],
    };

    expect(pagePixelLimit(adf)).toBe(MAX_PAGE_PIXELS);
    // Потолок — встроенный предел sharp: предел из capabilities его только понижает.
    expect(MAX_PAGE_PIXELS).toBe(0x3fff * 0x3fff);
  });

  it('предел из журнала выше потолка не действует; неизвестный — фиксированный', () => {
    expect(decodePixelLimit(9e11)).toBe(MAX_PAGE_PIXELS);
    expect(decodePixelLimit(5100 * 8400)).toBe(5100 * 8400);
    expect(decodePixelLimit(null)).toBe(FALLBACK_PIXEL_LIMIT);
  });
});
