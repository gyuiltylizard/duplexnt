import type { ProbeResult } from '@shared';
import { imagingProbe, type ImagingProbeResult } from './imaging-probe';
import { validateProbeRequest } from './validate-probe-request';

// Обработчик команды-пробы. Вход приходит с моста непроверенным — отсюда `unknown`. Операция
// над изображением передаётся аргументом: тест проверяет, что при мусоре на входе до `sharp`
// дело не доходит.
export async function handleProbe(
  rawRequest: unknown,
  runImagingProbe: () => Promise<ImagingProbeResult> = imagingProbe,
): Promise<ProbeResult> {
  const request = validateProbeRequest(rawRequest);
  const imaging = await runImagingProbe();

  // Версии Electron и Chromium берутся из `process.versions` — без импорта Electron. Под
  // обычным Node (тесты) их нет.
  const versions: Record<string, string | undefined> = process.versions;

  return {
    echo: request.token,
    versions: {
      electron: versions.electron ?? null,
      chrome: versions.chrome ?? null,
      node: process.versions.node,
      sharp: imaging.sharp,
      libvips: imaging.libvips,
    },
    image: imaging.image,
  };
}
