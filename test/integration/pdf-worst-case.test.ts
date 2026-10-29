import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { measureSkewJpeg } from '../../src/core/detect/skew';
import { straighten } from '../../src/core/image/straighten';
import { assemblePdf, type PdfPageInput } from '../../src/core/pdf/assemble';
import { stepTheta, syntheticJpeg } from '../support/synthetic-page';

// Худший замеренный объём (план M2, KTD-12; журнал M1, KTD-36): страница 600 dpi в цвете —
// 3,4–3,5 МБ, двусторонняя пачка из 50 листов — ~350 МБ JPEG; `pdf-lib` держит документ в
// памяти и на `save()` создаёт вторую копию. Тест прогоняет синтетику того же суммарного
// объёма и меряет пик RSS и паузы цикла событий. Провал порогов — названный KTD-12 триггер
// решения о выделенном worker, а не «подкрутить порог».

const TARGET_TOTAL_BYTES = 350 * 1024 * 1024;
/** Выправленных страниц 600 dpi цвет в пачке (план M6, U6): объём после перекодирования q92 4:4:4. */
const STRAIGHTENED_PAGES = 50;
const PIXEL_LIMIT = 5100 * 8400;
/** Пик сверх базы: сам объём + копия на save() + накладные. Выше — недопустимо (KTD-12). */
const RSS_CEILING_BYTES = 2_500 * 1024 * 1024;
/** Самая долгая пауза цикла событий за сборку. */
const STALL_CEILING_MS = 1_500;

// A4 при 600 dpi, цвет — как в замере M1.
const A4_600DPI = { width: 4960, height: 7016 };

/** Прогон сборки `pageCount` копий `jpeg` с замером пика RSS и пауз цикла; пороги — KTD-12. */
async function assembleWorstCase(jpeg: Buffer, pageCount: number, label: string): Promise<void> {
  // База — до входных копий: пик покрывает весь путь «страницы в памяти → сборка → save».
  const rssBase = process.memoryUsage().rss;
  // Каждой странице — собственная копия байтов: в продукте страницы разные, и входной
  // объём живёт в памяти целиком, пока документ не собран.
  const pages: PdfPageInput[] = Array.from({ length: pageCount }, (_unused, index) => ({
    bytes: Uint8Array.from(jpeg),
    angle: index % 2 === 1 ? 180 : 0,
    dpi: 600,
    pixelLimit: null,
  }));
  let rssPeak = rssBase;
  let maxStallMs = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    maxStallMs = Math.max(maxStallMs, now - last - 25);
    last = now;
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 25);

  try {
    const started = performance.now();
    const result = await assemblePdf(pages);
    const elapsedMs = performance.now() - started;
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);

    expect(result.ok).toBe(true);
    const pdfBytes = result.ok ? result.value.byteLength : 0;
    // Потоки вложены как есть: документ не меньше суммы страниц.
    expect(pdfBytes).toBeGreaterThan(jpeg.byteLength * pageCount);

    const peakOverBaseMb = Math.round((rssPeak - rssBase) / (1024 * 1024));
    console.info(
      `[KTD-12${label}] страниц: ${pageCount} × ${Math.round(jpeg.byteLength / 1024)} КБ; ` +
        `PDF: ${Math.round(pdfBytes / (1024 * 1024))} МБ; ` +
        `пик RSS сверх базы: ${peakOverBaseMb} МБ; ` +
        `макс. пауза цикла: ${Math.round(maxStallMs)} мс; время: ${Math.round(elapsedMs)} мс`,
    );
    expect(rssPeak - rssBase).toBeLessThan(RSS_CEILING_BYTES);
    expect(maxStallMs).toBeLessThan(STALL_CEILING_MS);
  } finally {
    clearInterval(probe);
  }
}

const noisyPage = (quality: number): Promise<Buffer> =>
  sharp({
    create: {
      ...A4_600DPI,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
      noise: { type: 'gaussian', mean: 128, sigma: 12 },
    },
  })
    .jpeg({ quality })
    .toBuffer();

/** Выправленная синтетическая страница 600 dpi цвет — тем же конвейером, что в продукте (U3). */
async function straightenedPage(): Promise<Buffer> {
  const bytes = await syntheticJpeg({
    dpi: 600,
    channels: 3,
    theta: stepTheta(0.3, -0.8, 0.56, 0.16),
    lateral: true,
  });
  const measure = await measureSkewJpeg(bytes, PIXEL_LIMIT);
  if (measure?.profile === null || measure?.profile === undefined) {
    throw new Error('синтетика не измерилась');
  }
  const out = await straighten(bytes, measure.profile, { pixelLimit: PIXEL_LIMIT, dpi: 600 });
  if (out === null) {
    throw new Error('коррекция не удалась');
  }
  return Buffer.from(out.jpeg);
}

describe('сборка PDF: худший объём (KTD-12)', () => {
  it(
    'пачка объёма ~350 МБ собирается без недопустимого пика памяти и блокировки цикла',
    { timeout: 180_000 },
    async () => {
      const jpeg = await noisyPage(82);
      await assembleWorstCase(
        jpeg,
        Math.max(10, Math.round(TARGET_TOTAL_BYTES / jpeg.byteLength)),
        '',
      );
    },
  );

  it(
    '50 выправленных страниц 600 dpi цвет (q92 4:4:4) — те же пороги (M6, U6; KTD-8)',
    { timeout: 180_000 },
    async () => {
      await assembleWorstCase(await straightenedPage(), STRAIGHTENED_PAGES, ', выправленные');
    },
  );
});
