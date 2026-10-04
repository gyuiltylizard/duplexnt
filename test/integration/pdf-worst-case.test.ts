import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { assemblePdf, type PdfPageInput } from '../../src/core/pdf/assemble';

// Худший замеренный объём (план M2, KTD-12; журнал M1, KTD-36): страница 600 dpi в цвете —
// 3,4–3,5 МБ, двусторонняя пачка из 50 листов — ~350 МБ JPEG; `pdf-lib` держит документ в
// памяти и на `save()` создаёт вторую копию. Тест прогоняет синтетику того же суммарного
// объёма и меряет пик RSS и паузы цикла событий. Провал порогов — названный KTD-12 триггер
// решения о выделенном worker, а не «подкрутить порог».

const TARGET_TOTAL_BYTES = 350 * 1024 * 1024;
/** Пик сверх базы: сам объём + копия на save() + накладные. Выше — недопустимо (KTD-12). */
const RSS_CEILING_BYTES = 2_500 * 1024 * 1024;
/** Самая долгая пауза цикла событий за сборку. */
const STALL_CEILING_MS = 1_500;

// A4 при 600 dpi, цвет — как в замере M1.
const A4_600DPI = { width: 4960, height: 7016 };

describe('сборка PDF: худший объём (KTD-12)', () => {
  it(
    'пачка объёма ~350 МБ собирается без недопустимого пика памяти и блокировки цикла',
    { timeout: 180_000 },
    async () => {
      const jpeg = await sharp({
        create: {
          ...A4_600DPI,
          channels: 3,
          noise: { type: 'gaussian', mean: 128, sigma: 12 },
        },
      })
        .jpeg({ quality: 82 })
        .toBuffer();
      const pageCount = Math.max(10, Math.round(TARGET_TOTAL_BYTES / jpeg.byteLength));
      // База — до входных копий: пик покрывает весь путь «страницы в памяти → сборка → save».
      const rssBase = process.memoryUsage().rss;
      // Каждой странице — собственная копия байтов: в продукте страницы разные, и входной
      // объём живёт в памяти целиком, пока документ не собран.
      const pages: PdfPageInput[] = Array.from({ length: pageCount }, (_unused, index) => ({
        bytes: Uint8Array.from(jpeg),
        rotate180: index % 2 === 1,
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
          `[KTD-12] страниц: ${pageCount} × ${Math.round(jpeg.byteLength / 1024)} КБ; ` +
            `PDF: ${Math.round(pdfBytes / (1024 * 1024))} МБ; ` +
            `пик RSS сверх базы: ${peakOverBaseMb} МБ; ` +
            `макс. пауза цикла: ${Math.round(maxStallMs)} мс; время: ${Math.round(elapsedMs)} мс`,
        );
        expect(rssPeak - rssBase).toBeLessThan(RSS_CEILING_BYTES);
        expect(maxStallMs).toBeLessThan(STALL_CEILING_MS);
      } finally {
        clearInterval(probe);
      }
    },
  );
});
