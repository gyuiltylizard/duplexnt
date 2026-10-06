import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fail } from '@shared';
import { probeScanner } from '../../src/core/escl/connect';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import { openPassService } from '../../src/core/scan/pass-service';
import { realStorageFs } from '../../src/core/storage/storage-fs';
import { startTestEmulator } from '../support/emulator';
import { fsError, interceptFs } from '../support/intercept-fs';
import { makeTempDataRoot } from '../support/temp-data-root';
import { unwrap } from '../support/result';

// Правки и пакетное сохранение на настоящей цепочке (план M3, U10): эмулятор → клиент →
// хранилище → служба. Здесь — то, что нельзя честно проверить на посеянной сессии: новая сессия
// в той же службе после «Нового сканирования».

const FAST: Partial<ScanJobLimits> = {
  retryDelayMs: 5,
  busyCeilingMs: 200,
  notReadyCeilingMs: 2000,
  pageIdleTimeoutMs: 300,
  pageDeadlineMs: 3000,
  deleteDeadlineMs: 300,
};

describe('пакетное сохранение через эмулятор (M3)', () => {
  it('незавершённый пакет не переживает «Новое сканирование»: повтор не пишет новую сессию в старую папку', async () => {
    const emulator = await startTestEmulator({ scenario: { trays: [[1, 2], [3]] } });
    const connected = unwrap(await probeScanner({ ...emulator, fingerprint: null }));
    const root = await makeTempDataRoot();
    const folder = join(root, 'выход');
    await mkdir(folder, { recursive: true });
    let failWrite = true;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (failWrite && call.op === 'rename' && call.to?.endsWith('Скан.pdf') === true) {
        throw fsError('EIO');
      }
    });
    const service = await openPassService(root, {
      fs,
      jobLimits: FAST,
      minFreeBytes: 1,
      retry: { ceilingMs: 0 },
    });
    await service.useScanner(connected);
    const request = { mode: 'single', names: ['Скан'], retry: false } as const;

    // Первая сессия: пакет упал на записи — незавершённый.
    expect(unwrap(await service.startPass())).toMatchObject({ end: 'completed', pages: 2 });
    const first = service.sessionId();
    expect(unwrap(await service.saveDocuments(folder, request)).failed).toHaveLength(1);

    // «Новое сканирование»: другая сессия в той же службе.
    unwrap(await service.closeSession());
    expect(unwrap(await service.startPass())).toMatchObject({ end: 'completed', pages: 1 });
    expect(service.sessionId()).not.toBe(first);

    failWrite = false;
    expect(await service.saveDocuments(folder, { ...request, retry: true })).toEqual(
      fail('sessionConflict', { reason: 'noFailedFiles' }),
    );
    expect(await readdir(folder)).toEqual([]);
  });
});
