import { expect, it } from 'vitest';
import { parseCapabilities } from '../../src/core/escl/capabilities';
import { parseStatus } from '../../src/core/escl/status';
import { createTransport } from '../../src/core/escl/transport';
import { describeLive } from '../support/live-device';

// Живое устройство при закрытии вехи (план M1, U25, AE12): capabilities читаются и разбираются,
// автоподача найдена, статус отвечает. Запуск — только по явному согласию:
//
//   PowerShell:  $env:DUPLEXNT_SCANNER_HOST = '<адрес сканера>'
//                npx vitest run --project integration test/integration/live-device.test.ts
//
// Адрес в вывод не попадает: он идентифицирует сеть автора.

const BASE_PATH = '/eSCL';
const TIMEOUT_MS = 60_000;

describeLive('живое устройство: capabilities и статус', (host) => {
  it(
    'capabilities разбираются, автоподача найдена; статус отвечает разборчиво',
    async () => {
      const transport = createTransport({
        scheme: 'https',
        host,
        port: 443,
        basePath: BASE_PATH,
        fingerprint: null,
      });
      try {
        const capabilitiesResponse = await transport.request({
          method: 'GET',
          path: `${BASE_PATH}/ScannerCapabilities`,
        });
        if (!capabilitiesResponse.ok) {
          throw new Error(`capabilities не получены: ${capabilitiesResponse.error.code}`);
        }
        expect(capabilitiesResponse.value.status).toBe(200);

        const capabilities = parseCapabilities(capabilitiesResponse.value.body);
        if (!capabilities.ok) {
          throw new Error(`capabilities не разобраны: ${capabilities.error.code}`);
        }
        // AE12: автоподача найдена, варианты параметров не пустые — из них строится UI.
        expect(capabilities.value.adf.resolutions.length).toBeGreaterThan(0);
        expect(capabilities.value.adf.colorModes.length).toBeGreaterThan(0);
        expect(capabilities.value.adf.maxWidth).toBeGreaterThan(0);
        expect(capabilities.value.adf.documentFormats).toContain('image/jpeg');

        const statusResponse = await transport.request({
          method: 'GET',
          path: `${BASE_PATH}/ScannerStatus`,
        });
        if (!statusResponse.ok) {
          throw new Error(`статус не получен: ${statusResponse.error.code}`);
        }
        expect(statusResponse.value.status).toBe(200);
        const status = parseStatus(statusResponse.value.body);
        if (!status.ok) {
          throw new Error(`статус не разобран: ${status.error.code}`);
        }
      } finally {
        transport.close();
      }
    },
    TIMEOUT_MS,
  );
});
