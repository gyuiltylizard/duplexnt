import { ok, type ProbeResult, type Result } from '@shared';
import { parseInput, probeRequestSchema } from '../commands/schemas';
import { imagingProbe, type ImagingProbeResult } from './imaging-probe';

// Обработчик команды-пробы. Вход приходит с моста непроверенным — отсюда `unknown`. Операция
// над изображением передаётся аргументом: тест проверяет, что при мусоре на входе до `sharp`
// дело не доходит.
export async function handleProbe(
  rawRequest: unknown,
  runImagingProbe: () => Promise<ImagingProbeResult> = imagingProbe,
): Promise<Result<ProbeResult>> {
  const request = parseInput(probeRequestSchema, rawRequest);
  if (!request.ok) {
    return request;
  }
  const imaging = await runImagingProbe();

  // Версии Electron и Chromium берутся из `process.versions` — без импорта Electron. Под
  // обычным Node (тесты) их нет.
  const versions: Record<string, string | undefined> = process.versions;

  return ok({
    echo: request.value.token,
    versions: {
      electron: versions.electron ?? null,
      chrome: versions.chrome ?? null,
      node: process.versions.node,
      sharp: imaging.sharp,
      libvips: imaging.libvips,
    },
    image: imaging.image,
  });
}
