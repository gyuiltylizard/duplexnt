import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { blankRatio } from '../../src/core/detect/blank';
import { measureSkewJpeg } from '../../src/core/detect/skew';
import { isImageTimeout } from '../../src/core/image/sharp-image';
import { straighten } from '../../src/core/image/straighten';
import type { PageInfo } from '../../src/core/storage/session-store';
import { createThumbnails, type ThumbnailSource } from '../../src/core/storage/thumbnails';
import { stepTheta, syntheticJpeg } from '../support/synthetic-page';
import { makeTempDataRoot } from '../support/temp-data-root';

// Срок обработки по путям ядра (B-21, план 2026-11-01-001, U2–U3): помощник подменён так, что
// начиная с заданного вызова отвечает сроком или посторонним сбоем. Сам срок на настоящем `sharp`
// — `sharp-image.test.ts`; здесь — что каждый путь делает с ним: декод детекторов пробрасывает
// срок исключением (прочее — `null`), выпрямление сводит срок к `null`, миниатюра — к
// `thumbnailFailed` без кэша.

interface Control {
  calls: number;
  failFrom: number;
  kind: 'timeout' | 'other';
}

const control = vi.hoisted((): Control => ({
  calls: 0,
  failFrom: Number.POSITIVE_INFINITY,
  kind: 'timeout',
}));

vi.mock('../../src/core/image/sharp-image', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/image/sharp-image')>();
  const processImage: typeof actual.processImage = (input, work, deadlines) => {
    control.calls += 1;
    if (control.calls >= control.failFrom) {
      return Promise.reject(
        control.kind === 'timeout'
          ? new actual.ImageTimeoutError('тест: срок')
          : new Error('тест: сбой libvips'),
      );
    }
    return actual.processImage(input, work, deadlines);
  };
  return { ...actual, processImage };
});

/** Начиная с `offset`-го следующего вызова помощник отвечает отказом вида `kind`. */
function failFromNext(offset: number, kind: 'timeout' | 'other' = 'timeout'): void {
  control.failFrom = control.calls + offset;
  control.kind = kind;
}

beforeEach(() => {
  control.calls = 0;
  control.failFrom = Number.POSITIVE_INFINITY;
});

const PIXEL_LIMIT = 5100 * 8400;

describe('срок обработки по путям ядра (B-21)', () => {
  it('декод детекторов: срок — исключение у оценки пустоты и у измерения наклона; прочий сбой — null', async () => {
    const bytes = await syntheticJpeg({ dpi: 100, theta: stepTheta(0.2, -0.4, 0.5, 0.1) });

    failFromNext(1);
    const blank = await blankRatio(bytes, PIXEL_LIMIT).catch((error: unknown) => error);
    expect(isImageTimeout(blank)).toBe(true);
    const skew = await measureSkewJpeg(bytes, PIXEL_LIMIT).catch((error: unknown) => error);
    expect(isImageTimeout(skew)).toBe(true);

    failFromNext(1, 'other');
    expect(await blankRatio(bytes, PIXEL_LIMIT)).toBeNull();
    expect(await measureSkewJpeg(bytes, PIXEL_LIMIT)).toBeNull();
  });

  it('выпрямление: срок при декоде и при кодировании — null (очередь отложит страницу со сбоем)', async () => {
    const bytes = await syntheticJpeg({ dpi: 100, theta: stepTheta(0.2, -0.7, 0.55, 0.14) });
    const profile = (await measureSkewJpeg(bytes, PIXEL_LIMIT))?.profile;
    expect(profile).toBeTruthy();
    if (!profile) {
      return;
    }
    const job = { pixelLimit: PIXEL_LIMIT, dpi: 100 };

    failFromNext(1);
    expect(await straighten(bytes, profile, job)).toBeNull();
    // Декод проходит, кодирование — второй вызов помощника — получает срок.
    failFromNext(2);
    expect(await straighten(bytes, profile, job)).toBeNull();
    control.failFrom = Number.POSITIVE_INFINITY;
    expect(await straighten(bytes, profile, job)).not.toBeNull();
  });

  it('миниатюра: срок — thumbnailFailed / decode без кэша; следующий запрос строит заново', async () => {
    const bytes = await syntheticJpeg({ dpi: 100, theta: stepTheta(0, 0, 0.5, 0.1) });
    const info: PageInfo = { sessionId: 's-timeout', pixelLimit: PIXEL_LIMIT, dpi: 100 };
    const source: ThumbnailSource = {
      pageInfo: (key) => (key === 'p01-s01-0001' ? info : null),
      readPage: () => Promise.resolve({ ok: true, value: new Uint8Array(bytes) }),
    };
    const derivedDir = join(await makeTempDataRoot(), 'derived');
    const thumbnails = createThumbnails(derivedDir, source);

    failFromNext(1);
    const failed = await thumbnails.get('p01-s01-0001');
    expect(failed).toMatchObject({
      ok: false,
      error: { code: 'thumbnailFailed', details: { reason: 'decode' } },
    });
    expect(await readdir(join(derivedDir, info.sessionId)).catch(() => [])).toEqual([]);

    control.failFrom = Number.POSITIVE_INFINITY;
    const calls = control.calls;
    expect((await thumbnails.get('p01-s01-0001')).ok).toBe(true);
    expect(control.calls).toBe(calls + 1);
  });
});
