import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { parseCapabilities } from '../../src/core/escl/capabilities';
import { runScanJob } from '../../src/core/escl/scan-job';
import { buildScanSettings } from '../../src/core/escl/scan-settings';
import { createTransport } from '../../src/core/escl/transport';
import { writeStreamAtomic } from '../../src/core/storage/atomic-file';
import { describeLive } from '../support/live-device';
import { makeTempDataRoot } from '../support/temp-data-root';

// Задание на живом устройстве (план M1, U10, KTD-30): в лотке — один или несколько листов,
// продуктовый код проводит `POST` → страницы → `404` → `DELETE`. Запуск — только по явному
// согласию:
//
//   PowerShell:  $env:DUPLEXNT_SCANNER_HOST = '<адрес сканера>'
//                npx vitest run --project integration test/integration/scan-job.live.test.ts
//
// Адрес в вывод не попадает: он идентифицирует сеть автора.

const BASE_PATH = '/eSCL';
// Страница при 300 dpi идёт до 26 с, первая — после 16 с ожидания заголовков (журнал M1, U1).
const TIMEOUT_MS = 5 * 60_000;

describeLive('задание на живом сканере', (host) => {
  it(
    'лист в лотке: POST → страницы → 404 → DELETE, страницы — JPEG на диске',
    async () => {
      // Первое подключение: отпечаток неизвестен, его называет устройство.
      const probe = createTransport({
        scheme: 'https',
        host,
        port: 443,
        basePath: BASE_PATH,
        fingerprint: null,
      });
      const response = await probe.request({
        method: 'GET',
        path: `${BASE_PATH}/ScannerCapabilities`,
      });
      probe.close();
      if (!response.ok) {
        throw new Error(`capabilities не получены: ${response.error.code}`);
      }
      expect(response.value.status).toBe(200);
      const { fingerprint } = response.value;
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

      const capabilities = parseCapabilities(response.value.body);
      if (!capabilities.ok) {
        throw new Error(`capabilities не разобраны: ${capabilities.error.code}`);
      }
      const settings = buildScanSettings(
        { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
        capabilities.value,
      );
      if (!settings.ok) {
        throw new Error(`параметры не собраны: ${settings.error.code}`);
      }

      // Дальше — с запомненным отпечатком: каждое соединение задания проходит сверку, в том
      // числе на возобновлённой сессии TLS.
      const transport = createTransport({
        scheme: 'https',
        host,
        port: 443,
        basePath: BASE_PATH,
        fingerprint,
      });
      onTestFinished(() => {
        transport.close();
      });
      const directory = await makeTempDataRoot();
      const phases: string[] = [];

      const result = await runScanJob({
        transport,
        basePath: BASE_PATH,
        settings: settings.value,
        onPhase: (phase) => phases.push(phase),
        sink: async ({ index, body }) => {
          await writeStreamAtomic(join(directory, `page-${index}.jpg`), body);
        },
      });

      if (!result.ok) {
        throw new Error(`задание не создано: ${result.error.code}`);
      }
      const report = result.value;
      console.info(
        `[live] исход: ${report.end.kind}, страниц: ${report.pages}, ` +
          `задание закрыто: ${report.job?.closed === true}, фазы: ${phases.join(' → ')}`,
      );
      if (report.end.kind === 'empty') {
        throw new Error('лоток пуст: положи в автоподатчик хотя бы один лист и повтори');
      }
      expect(report.end).toEqual({ kind: 'completed' });
      expect(report.pages).toBeGreaterThanOrEqual(1);
      expect(report.job?.closed).toBe(true);

      for (let index = 1; index <= report.pages; index += 1) {
        const page = await readFile(join(directory, `page-${index}.jpg`));
        console.info(`[live] страница ${index}: ${page.byteLength} байт`);
        expect(page.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))).toBe(true);
        expect(page.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
      }
    },
    TIMEOUT_MS,
  );
});
