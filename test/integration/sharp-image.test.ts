import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  abandonedImageRuns,
  ImageTimeoutError,
  isImageTimeout,
  processImage,
  type ImageInput,
} from '../../src/core/image/sharp-image';
import { scanFixture } from '../support/fixtures';

// Помощник обработки картинки со сроками (B-21, план 2026-11-01-001, U1) на настоящем `sharp`.
// Нагрузка — несепарабельная свёртка 121×121 на 3000×3000: без срока ~4 с (замер 2026-11-01,
// журнал 0032), со сроком 1 с прерывается около секунды. Размытие и медиана для этого не годятся —
// libvips считает их за доли секунды.

const SIDE = 3000;
const K = 121;
const KERNEL = Array.from({ length: K * K }, (_, i) => ((i * 7) % 5) - 2);
const PIXEL_LIMIT = SIDE * SIDE;

let noiseRaw: Uint8Array;
let noiseJpeg: Uint8Array;

beforeAll(async () => {
  noiseRaw = new Uint8Array(SIDE * SIDE * 3);
  for (let i = 0; i < noiseRaw.length; i += 1) {
    noiseRaw[i] = (i * 2654435761) >>> 24;
  }
  noiseJpeg = await sharp(noiseRaw, { raw: { width: SIDE, height: SIDE, channels: 3 } })
    .jpeg()
    .toBuffer();
});

const jpegInput = (): ImageInput => ({ kind: 'jpeg', bytes: noiseJpeg, pixelLimit: PIXEL_LIMIT });
const heavy = { width: K, height: K, kernel: KERNEL };

/** Отказ обработки и время до него. */
async function rejection(run: () => Promise<unknown>): Promise<{ error: unknown; ms: number }> {
  const started = performance.now();
  try {
    await run();
  } catch (error: unknown) {
    return { error, ms: performance.now() - started };
  }
  throw new Error('обработка не отказала');
}

describe('срок libvips прерывает обработку в каждой форме ядра (B-21, U1)', () => {
  const forms: readonly (readonly [string, () => Promise<unknown>])[] = [
    [
      'серый resize в сырой буфер (декод детекторов)',
      () =>
        processImage(
          jpegInput(),
          (image) =>
            image
              .greyscale()
              .resize({ width: SIDE, height: SIDE, fit: 'inside' })
              .convolve(heavy)
              .raw()
              .toBuffer(),
          { seconds: 1 },
        ),
    ],
    [
      'JPEG в сырой одноканальный буфер (декод выпрямления)',
      () =>
        processImage(
          jpegInput(),
          (image) => image.convolve(heavy).toColourspace('b-w').raw().toBuffer(),
          { seconds: 1 },
        ),
    ],
    [
      'сырой вход в JPEG (кодирование выпрямления)',
      () =>
        processImage(
          { kind: 'raw', bytes: noiseRaw, width: SIDE, height: SIDE, channels: 3 },
          (image) => image.convolve(heavy).jpeg().toBuffer(),
          { seconds: 1 },
        ),
    ],
  ];

  it.each(forms)('%s', async (_, run) => {
    const { error, ms } = await rejection(run);
    expect(isImageTimeout(error)).toBe(true);
    // Сработал именно libvips: в причине — его текст, а не запасной срок по часам.
    expect(String((error as ImageTimeoutError).cause)).toMatch(/timeout: \d+% complete/);
    expect(ms).toBeGreaterThanOrEqual(900);
    // Верх с запасом на нагруженный процессор: libvips проверяет срок между кусками вывода.
    expect(ms).toBeLessThan(8000);
  });
});

describe('запасной срок и распознавание (B-21, U1)', () => {
  it('обработка, которая не успевает к запасному сроку, — срок по запасным часам; брошенная учтена до своего конца', async () => {
    const { error, ms } = await rejection(() =>
      processImage(jpegInput(), () => delay(300), { deadlineMs: 50 }),
    );
    expect(error).toBeInstanceOf(ImageTimeoutError);
    expect((error as ImageTimeoutError).cause).toBeUndefined();
    expect(ms).toBeLessThan(250);
    expect(abandonedImageRuns()).toBe(1);
    await delay(400);
    expect(abandonedImageRuns()).toBe(0);
  });

  it('поздний отказ брошенной обработки не становится unhandled rejection', async () => {
    const { error } = await rejection(() =>
      processImage(
        jpegInput(),
        async () => {
          await delay(100);
          throw new Error('поздний сбой libvips');
        },
        { deadlineMs: 20 },
      ),
    );
    expect(isImageTimeout(error)).toBe(true);
    // Отказ приходит после гонки: unhandled vitest засчитал бы ошибкой прогона.
    await delay(200);
    expect(abandonedImageRuns()).toBe(0);
  });

  it('предохранитель: пока висят две брошенные, помощник сразу отвечает сроком и sharp не трогает', async () => {
    const hang = (): Promise<{ error: unknown; ms: number }> =>
      rejection(() => processImage(jpegInput(), () => delay(400), { deadlineMs: 20 }));
    const [first, second] = await Promise.all([hang(), hang()]);
    expect(isImageTimeout(first.error)).toBe(true);
    expect(isImageTimeout(second.error)).toBe(true);
    expect(abandonedImageRuns()).toBe(2);

    let touched = false;
    const { error, ms } = await rejection(() =>
      processImage(jpegInput(), (image) => {
        touched = true;
        return image.metadata();
      }),
    );
    expect(isImageTimeout(error)).toBe(true);
    expect(touched).toBe(false);
    expect(ms).toBeLessThan(50);

    // Брошенные кончились — помощник снова работает.
    await delay(500);
    expect(abandonedImageRuns()).toBe(0);
    expect((await processImage(jpegInput(), (image) => image.metadata())).format).toBe('jpeg');
  });

  it('распознаватель узнаёт срок и по имени ошибки (перенос через postMessage теряет прототип)', () => {
    const transferred = Object.assign(new Error('обработка не уложилась'), {
      name: 'ImageTimeoutError',
    });
    expect(isImageTimeout(transferred)).toBe(true);
  });

  it('текст срока не первой строкой сообщения — срок', async () => {
    const { error } = await rejection(() =>
      processImage(jpegInput(), () =>
        Promise.reject(new Error('VipsJpeg: premature end\ntimeout: 12% complete')),
      ),
    );
    expect(isImageTimeout(error)).toBe(true);
  });

  it('отказ без текста срока, но не раньше срока по часам — срок (текст стёрт соседней обработкой)', async () => {
    const { error } = await rejection(() =>
      processImage(
        jpegInput(),
        async () => {
          await delay(1050);
          throw new Error('Unknown error');
        },
        { seconds: 1 },
      ),
    );
    expect(isImageTimeout(error)).toBe(true);
  });

  it('битый JPEG до срока — обычный отказ sharp, не срок', async () => {
    const broken = noiseJpeg.slice(0, 2000);
    const { error } = await rejection(() =>
      processImage({ kind: 'jpeg', bytes: broken, pixelLimit: PIXEL_LIMIT }, (image) =>
        image.raw().toBuffer(),
      ),
    );
    expect(error).toBeInstanceOf(Error);
    expect(isImageTimeout(error)).toBe(false);
  });

  it('распознаватель не принимает посторонние значения за срок', () => {
    for (const value of [new Error('timeout'), 'timeout: 5% complete', null, undefined, {}]) {
      expect(isImageTimeout(value)).toBe(false);
    }
  });

  it('срок libvips — только целые секунды от 1: ноль выключил бы защиту', async () => {
    for (const seconds of [0, 1.5, -1, 3601]) {
      await expect(
        processImage(jpegInput(), (image) => image.metadata(), { seconds }),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('скан ET-3850 со сроками по умолчанию обрабатывается как раньше', async () => {
    const bytes = scanFixture('blank-gray-300');
    const meta = await processImage({ kind: 'jpeg', bytes, pixelLimit: PIXEL_LIMIT * 4 }, (image) =>
      image.metadata(),
    );
    expect(meta.format).toBe('jpeg');
    const thumb = await processImage(
      { kind: 'jpeg', bytes, pixelLimit: PIXEL_LIMIT * 4 },
      (image) => image.resize({ width: 320, height: 452, fit: 'inside' }).jpeg().toBuffer(),
    );
    expect((await sharp(thumb).metadata()).width).toBeLessThanOrEqual(320);
  });
});
