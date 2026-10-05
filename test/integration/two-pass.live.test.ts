import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { expect, it } from 'vitest';
import { probeScanner } from '../../src/core/escl/connect';
import { openPassService } from '../../src/core/scan/pass-service';
import { describeLive } from '../support/live-device';
import { makeTempDataRoot } from '../support/temp-data-root';
import { unwrap } from '../support/result';

// Двухпроходный прогон на живом устройстве (план M2, U10; AE2 — выход вехи): двусторонняя
// пачка пронумерованных листов (spikes/make-twopass-pdf.mjs, 12 листов) → два прохода через
// службу → тумблер 180° → PDF. Запуск — только по явному согласию:
//
//   PowerShell:  $env:DUPLEXNT_SCANNER_HOST = '<адрес сканера>'
//                npx vitest run --project integration test/integration/two-pass.live.test.ts
//
// Перед запуском пачка лежит в лотке ЛИЦОМ ВВЕРХ, лист 1 сверху. После первого прохода тест
// ждёт: разверни пачку на 180° в плоскости (не переворачивая листы) и положи обратно — второй
// проход стартует сам, как только лоток перестанет быть пустым. Итоговый PDF кладётся в
// temp/duplexnt-live-two-pass.pdf — порядок страниц сверяется глазами по номерам (AE2).
// Адрес сканера в вывод не попадает: он идентифицирует сеть автора.

const BASE_PATH = '/eSCL';
// Страница при 300 dpi идёт до 26 с (журнал M1, U1): два прохода по 12 листов + окно на
// разворот пачки.
const TIMEOUT_MS = 20 * 60_000;
/** Сколько ждать разворота пачки: попытки второго прохода идут, пока лоток пуст. */
const FLIP_DEADLINE_MS = 5 * 60_000;
const FLIP_RETRY_DELAY_MS = 5_000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describeLive('два прохода на живом сканере (AE2)', (host) => {
  it(
    'пачка → два прохода → тумблер 180° → PDF в собранном порядке',
    async () => {
      const probed = await probeScanner({
        scheme: 'https',
        host,
        port: 443,
        basePath: BASE_PATH,
        fingerprint: null,
      });
      if (!probed.ok) {
        throw new Error(`сканер не подключился: ${probed.error.code}`);
      }

      const root = await makeTempDataRoot();
      const service = await openPassService(root);
      await service.useScanner(probed.value);

      console.info('[live] проход 1: лицевые стороны — пачка лицом вверх, лист 1 сверху');
      const fronts = unwrap(await service.startPass());
      expect(fronts.end).toBe('completed');
      expect(fronts.pages).toBeGreaterThanOrEqual(2);
      console.info(
        `[live] лицевые готовы: ${fronts.pages} листов. ` +
          'Разверни пачку на 180° в плоскости (не переворачивая листы) и положи в лоток — ' +
          'второй проход стартует сам.',
      );

      // Второй проход: пока лоток пуст, устройство отвечает «нет бумаги» — ждём разворота.
      const deadline = Date.now() + FLIP_DEADLINE_MS;
      let backs = await service.startPass();
      while (!backs.ok && backs.error.code === 'scanNoPaper' && Date.now() < deadline) {
        await sleep(FLIP_RETRY_DELAY_MS);
        backs = await service.startPass();
      }
      const backsReport = unwrap(backs);
      expect(backsReport.end).toBe('completed');
      expect(backsReport.pages).toBe(fronts.pages);

      const report = service.snapshot().assembly?.report;
      expect(report).toMatchObject({
        fronts: fronts.pages,
        backs: fronts.pages,
        pairs: fronts.pages,
        mismatch: false,
      });

      // Пачка сканировалась с разворотом — обороты пришли вверх ногами (AE8).
      unwrap(await service.setRotateBacks(true));

      await mkdir(resolve('temp'), { recursive: true });
      const target = resolve('temp', 'duplexnt-live-two-pass.pdf');
      const saved = unwrap(await service.savePdf(() => Promise.resolve(target)));
      expect(saved).toMatchObject({ canceled: false });

      const document = await PDFDocument.load(await readFile(target));
      expect(document.getPageCount()).toBe(fronts.pages * 2);
      // /Rotate 180 — только на оборотах (каждая вторая страница собранного порядка).
      document.getPages().forEach((page, index) => {
        expect(page.getRotation().angle, `страница ${index + 1}`).toBe(index % 2 === 1 ? 180 : 0);
      });
      expect(service.snapshot().session?.saved).toBe(true);

      // Исходники целы: каждый ключ порядка лежит JPEG'ом на диске.
      const order = service.snapshot().assembly?.order ?? [];
      expect(order).toHaveLength(fronts.pages * 2);

      console.info(
        `[live] PDF сохранён: ${target} (${fronts.pages * 2} страниц). ` +
          'Открой его и сверь порядок по номерам: 1 FRONT, 1 BACK, 2 FRONT, 2 BACK, … — ' +
          'и что обороты не вверх ногами (тумблер 180° применён).',
      );
    },
    TIMEOUT_MS,
  );
});
