import { monitorEventLoopDelay } from 'node:perf_hooks';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { SkewProfile } from '@shared';
import { measureSkewJpeg } from '../../src/core/detect/skew';
import { straighten } from '../../src/core/image/straighten';
import { stepTheta, syntheticJpeg } from '../support/synthetic-page';

// Худший объём коррекции (план M6, U3; Success Criteria; ADR 0008): одна страница 600 dpi
// в цвете — пик RSS сверх базы, паузы цикла событий и чанки; серия из двенадцати страниц
// 300 dpi серых и трёх 600 dpi цветных при параллельных измерениях и миниатюрах в main —
// память в конце не растёт сверх полутора пиков одной страницы. Провал порогов — триггер
// пересмотра ADR 0008 (воркер, warp in-place), а не «подкрутить порог».

const PIXEL_LIMIT = 5100 * 8400;
const RSS_CEILING_BYTES = 700 * 1024 * 1024;
const STALL_MAX_MS = 100;
const STALL_P95_MS = 30;

const THETA = stepTheta(0.3, -0.8, 0.56, 0.16);
const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0);
const percentile = (values: number[], p: number): number =>
  values.slice().sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * p))
  ] ?? 0;

async function profileOf(bytes: Uint8Array): Promise<SkewProfile> {
  const measure = await measureSkewJpeg(bytes, PIXEL_LIMIT);
  expect(measure?.outcome).toBe('willStraighten');
  if (!measure?.profile) {
    throw new Error('профиль не измерен');
  }
  return measure.profile;
}

describe('коррекция: худший объём (M6, U3)', () => {
  it(
    'одна страница 600 dpi цвет: RSS сверх базы < 700 МБ, пауза цикла max < 100 мс, p95 < 30 мс',
    { timeout: 300_000 },
    async () => {
      const bytes = await syntheticJpeg({ dpi: 600, channels: 3, theta: THETA, lateral: true });
      const profile = await profileOf(bytes);
      if (global.gc) {
        global.gc();
      }
      const rssBase = process.memoryUsage().rss;
      let rssPeak = rssBase;
      const probe = setInterval(() => {
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      }, 20);
      const delay = monitorEventLoopDelay({ resolution: 5 });
      delay.enable();
      const chunks: number[] = [];
      const started = performance.now();
      try {
        const out = await straighten(bytes, profile, {
          pixelLimit: PIXEL_LIMIT,
          dpi: 600,
          onChunk: (ms) => {
            chunks.push(ms);
          },
        });
        expect(out).not.toBeNull();
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
        const elapsed = performance.now() - started;
        delay.disable();
        const stallMax = delay.max / 1e6;
        const stallP95 = delay.percentile(95) / 1e6;
        console.info(
          `[U3 worst-case] 600 dpi цвет ${mb(bytes.byteLength)} → ${mb(out?.jpeg.byteLength ?? 0)} МБ за ${elapsed.toFixed(0)} мс; ` +
            `пик RSS сверх базы ${mb(rssPeak - rssBase)} МБ; паузы цикла max ${stallMax.toFixed(1)} мс, p95 ${stallP95.toFixed(1)} мс; ` +
            `чанки ${chunks.length}: p50 ${percentile(chunks, 0.5).toFixed(1)}, p95 ${percentile(chunks, 0.95).toFixed(1)}, max ${Math.max(...chunks).toFixed(1)} мс`,
        );
        expect(rssPeak - rssBase).toBeLessThan(RSS_CEILING_BYTES);
        expect(stallMax).toBeLessThan(STALL_MAX_MS);
        expect(stallP95).toBeLessThan(STALL_P95_MS);
        expect(percentile(chunks, 0.95)).toBeLessThanOrEqual(STALL_P95_MS);
      } finally {
        clearInterval(probe);
        delay.disable();
      }
    },
  );

  it(
    'серия 12 × 300 dpi серый и 3 × 600 dpi цвет при параллельных измерениях и миниатюрах: RSS в конце ≤ 1,5× пика одной страницы',
    { timeout: 600_000 },
    async () => {
      const gray300 = await syntheticJpeg({ dpi: 300, theta: THETA, lateral: true });
      const color600 = await syntheticJpeg({ dpi: 600, channels: 3, theta: THETA, lateral: true });
      const profiles = { gray300: await profileOf(gray300), color600: await profileOf(color600) };
      if (global.gc) {
        global.gc();
      }
      const rssBase = process.memoryUsage().rss;
      let rssPeak = rssBase;
      let pagePeak = rssBase;
      let singlePeak = 0;
      const probe = setInterval(() => {
        const rss = process.memoryUsage().rss;
        rssPeak = Math.max(rssPeak, rss);
        pagePeak = Math.max(pagePeak, rss);
      }, 20);
      const delay = monitorEventLoopDelay({ resolution: 5 });
      delay.enable();
      // Тяжёлые страницы — первыми: пик первой страницы (600 dpi цвет) — база для критерия
      // «в конце ≤ 1,5× пика одной страницы».
      const queue: { bytes: Uint8Array; profile: SkewProfile; dpi: number }[] = [
        ...Array.from({ length: 3 }, () => ({
          bytes: color600,
          profile: profiles.color600,
          dpi: 600,
        })),
        ...Array.from({ length: 12 }, () => ({
          bytes: gray300,
          profile: profiles.gray300,
          dpi: 300,
        })),
      ];
      try {
        const started = performance.now();
        for (const [index, page] of queue.entries()) {
          // Страница читается с диска свежим буфером; рядом в main — измерение другой страницы
          // и миниатюра, как при приёме следующего листа.
          const fresh = Uint8Array.from(page.bytes);
          const sideJobs = Promise.all([
            measureSkewJpeg(index % 2 === 0 ? gray300 : color600, PIXEL_LIMIT),
            sharp(page.bytes).resize({ width: 320, height: 452, fit: 'inside' }).jpeg().toBuffer(),
          ]);
          pagePeak = process.memoryUsage().rss;
          const out = await straighten(fresh, page.profile, {
            pixelLimit: PIXEL_LIMIT,
            dpi: page.dpi,
          });
          await sideJobs;
          expect(out, `страница ${index + 1}`).not.toBeNull();
          if (index === 0) {
            singlePeak = Math.max(pagePeak, process.memoryUsage().rss) - rssBase;
          }
        }
        const elapsed = performance.now() - started;
        if (global.gc) {
          global.gc();
        }
        const rssEnd = process.memoryUsage().rss;
        delay.disable();
        console.info(
          `[U3 worst-case] серия ${queue.length} страниц за ${elapsed.toFixed(0)} мс: пик RSS сверх базы ${mb(rssPeak - rssBase)} МБ, ` +
            `первая страница ${mb(singlePeak)} МБ, в конце ${mb(rssEnd - rssBase)} МБ; паузы цикла max ${(delay.max / 1e6).toFixed(1)} мс, p95 ${(delay.percentile(95) / 1e6).toFixed(1)} мс`,
        );
        expect(rssEnd - rssBase).toBeLessThanOrEqual(1.5 * singlePeak);
        expect(delay.max / 1e6).toBeLessThan(STALL_MAX_MS);
      } finally {
        clearInterval(probe);
        delay.disable();
      }
    },
  );
});
