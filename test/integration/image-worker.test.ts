import { describe, expect, it } from 'vitest';
import { measureSkewJpeg } from '../../src/core/detect/skew';
import { inlineImageWorker } from '../../src/core/image/image-worker';
import { straighten } from '../../src/core/image/straighten';
import { stepTheta, syntheticJpeg } from '../support/synthetic-page';

// Прямой исполнитель картинок (план M6, U3; KTD-10; ADR 0008): обе операции на синтетическом
// JPEG, побайтовое совпадение с прямым вызовом, отмена между чанками без утечки — следующая
// задача на том же исполнителе проходит.

const PIXEL_LIMIT = 5100 * 8400;

describe('прямой исполнитель картинок (M6, U3)', () => {
  it(
    'измерение и коррекция через исполнитель — то же, что прямой вызов, байт в байт',
    { timeout: 60_000 },
    async () => {
      const bytes = await syntheticJpeg({ dpi: 200, theta: stepTheta(0.2, -0.7, 0.55, 0.14) });
      const chunks: number[] = [];
      const worker = inlineImageWorker({
        onChunk: (ms) => {
          chunks.push(ms);
        },
      });

      const measure = await worker.measure(bytes, PIXEL_LIMIT, { prior: null });
      expect(measure).toEqual(await measureSkewJpeg(bytes, PIXEL_LIMIT));
      expect(measure?.outcome).toBe('willStraighten');
      const profile = measure?.profile;
      expect(profile).not.toBeNull();
      if (!profile) {
        return;
      }
      const chunksAfterMeasure = chunks.length;
      expect(chunksAfterMeasure).toBeGreaterThan(0);

      const job = { pixelLimit: PIXEL_LIMIT, dpi: 200 };
      const viaWorker = await worker.straighten(bytes, profile, job);
      const direct = await straighten(bytes, profile, job);
      expect(viaWorker).not.toBeNull();
      expect(chunks.length).toBeGreaterThan(chunksAfterMeasure);
      expect(Buffer.from(viaWorker?.jpeg ?? []).equals(Buffer.from(direct?.jpeg ?? []))).toBe(true);
      expect(viaWorker?.info).toEqual(direct?.info);
      expect(viaWorker?.dpi).toBe(200);
    },
  );

  it(
    'отмена посреди коррекции и измерения — промис отклонён причиной; следующая задача проходит',
    { timeout: 60_000 },
    async () => {
      const bytes = await syntheticJpeg({ dpi: 200, theta: stepTheta(0.2, -0.7, 0.55, 0.14) });
      let chunks = 0;
      const controller = new AbortController();
      const worker = inlineImageWorker({
        onChunk: () => {
          chunks += 1;
          if (chunks === 2) {
            controller.abort(new Error('отменено'));
          }
        },
      });

      await expect(
        worker.measure(bytes, PIXEL_LIMIT, { signal: controller.signal }),
      ).rejects.toThrow('отменено');
      expect(chunks).toBe(2);

      const measure = await worker.measure(bytes, PIXEL_LIMIT);
      expect(measure?.outcome).toBe('willStraighten');
      const profile = measure?.profile;
      if (!profile) {
        return;
      }

      const again = new AbortController();
      chunks = 0;
      const cancelling = inlineImageWorker({
        onChunk: () => {
          chunks += 1;
          if (chunks === 3) {
            again.abort(new Error('стоп'));
          }
        },
      });
      await expect(
        cancelling.straighten(bytes, profile, {
          pixelLimit: PIXEL_LIMIT,
          dpi: 200,
          signal: again.signal,
        }),
      ).rejects.toThrow('стоп');
      expect(chunks).toBe(3);
      const done = await cancelling.straighten(bytes, profile, {
        pixelLimit: PIXEL_LIMIT,
        dpi: 200,
      });
      expect(done).not.toBeNull();
    },
  );

  it('не JPEG — null в обеих операциях', async () => {
    const worker = inlineImageWorker();
    const junk = new TextEncoder().encode('<html>');
    expect(await worker.measure(junk, PIXEL_LIMIT)).toBeNull();
    expect(
      await worker.straighten(
        junk,
        { kind: 'knots', us: [0.5], thetas: [0.5] },
        { pixelLimit: PIXEL_LIMIT, dpi: null },
      ),
    ).toBeNull();
  });
});
