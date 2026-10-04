import { describe, expect, it } from 'vitest';
import { ET_3850, readFixture } from '../../../test/support/fixtures';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { parseCapabilities } from '../escl/capabilities';
import type { ConnectedScanner } from '../escl/connect';
import { scanOptionsOf } from '../escl/scan-settings';
import { StorageError } from '../storage/storage-fs';
import { interruptionError, openPassService } from './pass-service';

// Чистые части службы прохода (план M1, U17): перевод причины обрыва в код, снимок без сканера,
// проверка параметров против вариантов устройства. Сам проход идёт против эмулятора —
// test/integration/pass.emulator.test.ts.

function connected(): ConnectedScanner {
  const capabilities = parseCapabilities(readFixture(...ET_3850, 'ScannerCapabilities.xml'));
  if (!capabilities.ok) {
    throw new Error('фикстура capabilities не разобрана');
  }
  return {
    profile: {
      scheme: 'https',
      host: '127.0.0.1',
      port: 9443,
      basePath: '/eSCL',
      fingerprint: null,
    },
    capabilities: capabilities.value,
    options: scanOptionsOf(capabilities.value),
  };
}

describe('interruptionError: причина обрыва — кодом', () => {
  it('отказ устройства — как есть', () => {
    const error = { code: 'scanFeedFailed', details: { reason: 'gone' } } as const;
    expect(interruptionError({ kind: 'interrupted', reason: { source: 'device', error } })).toEqual(
      error,
    );
  });

  it('отказ приёмника — через перевод ошибок хранилища', () => {
    const storage = new StorageError({ code: 'storageFull' });
    expect(
      interruptionError({ kind: 'interrupted', reason: { source: 'sink', error: storage } }),
    ).toEqual({ code: 'storageFull' });
    expect(
      interruptionError({
        kind: 'interrupted',
        reason: { source: 'sink', error: Object.assign(new Error('x'), { code: 'EPERM' }) },
      }),
    ).toEqual({ code: 'storageFailed', details: { reason: 'EPERM' } });
  });

  it('у остальных исходов причины нет', () => {
    expect(interruptionError({ kind: 'completed' })).toBeNull();
    expect(interruptionError({ kind: 'empty' })).toBeNull();
    expect(interruptionError({ kind: 'canceled' })).toBeNull();
  });
});

describe('служба прохода без сканера', () => {
  it('снимок пустого корня: сканера нет, сессии нет, хранилище в порядке', async () => {
    const service = await openPassService(await makeTempDataRoot());

    expect(service.snapshot()).toEqual({
      seq: 0,
      scanner: { kind: 'none' },
      session: null,
      assembly: null,
      pass: null,
      canResume: false,
      canAccept: false,
      storage: { incompatible: false, unsaved: false },
      notices: [],
    });
  });

  it('без сканера проход, параметры и «Остановить» отклоняются кодом', async () => {
    const service = await openPassService(await makeTempDataRoot());

    expect(await service.startPass()).toEqual({
      ok: false,
      error: { code: 'scannerNotConnected' },
    });
    expect(
      await service.setParams({ colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' }),
    ).toEqual({ ok: false, error: { code: 'scannerNotConnected' } });
    expect(await service.stopPass()).toEqual({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'noRunningPass' } },
    });
    expect(await service.acceptPass()).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict' },
    });
    expect(await service.closeSession()).toEqual({ ok: true, value: undefined });
  });

  it('проверка запомненного сканера без запомненного — состояние «нет»', async () => {
    const seen: number[] = [];
    const service = await openPassService(await makeTempDataRoot(), {
      onChange: (seq) => seen.push(seq),
    });

    await service.checkRememberedScanner();

    expect(service.snapshot().scanner).toEqual({ kind: 'none' });
    expect(seen).toEqual([]);
  });
});

describe('служба прохода: сканер и параметры', () => {
  it('подключённый сканер виден в снимке с вариантами и параметрами по умолчанию', async () => {
    const seen: number[] = [];
    const service = await openPassService(await makeTempDataRoot(), {
      onChange: (seq) => seen.push(seq),
    });

    const scanner = connected();
    expect(await service.useScanner(scanner)).toEqual({ ok: true, value: undefined });

    expect(service.snapshot().scanner).toEqual({
      kind: 'ready',
      scanner: {
        name: scanner.capabilities.makeAndModel,
        scheme: 'https',
        host: '127.0.0.1',
        port: 9443,
      },
      options: {
        colorModes: ['Grayscale8', 'RGB24'],
        resolutions: [100, 200, 300, 600],
        paperSizes: ['A4', 'Letter'],
      },
      params: { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' },
    });
    expect(seen).toEqual([1]);
  });

  it('параметр, которого у устройства нет, отклоняется с именем поля', async () => {
    const service = await openPassService(await makeTempDataRoot());
    await service.useScanner(connected());

    expect(
      await service.setParams({ colorMode: 'RGB24', resolution: 600, paperSize: 'Letter' }),
    ).toEqual({ ok: true, value: undefined });
    expect(
      await service.setParams({ colorMode: 'BlackAndWhite1', resolution: 300, paperSize: 'A4' }),
    ).toEqual({
      ok: false,
      error: { code: 'scanParamsUnsupported', details: { field: 'colorMode' } },
    });
    expect(
      await service.setParams({ colorMode: 'RGB24', resolution: 1200, paperSize: 'A4' }),
    ).toEqual({
      ok: false,
      error: { code: 'scanParamsUnsupported', details: { field: 'resolution' } },
    });
    const { scanner } = service.snapshot();
    expect(scanner.kind === 'ready' ? scanner.params : null).toEqual({
      colorMode: 'RGB24',
      resolution: 600,
      paperSize: 'Letter',
    });
  });

  it('параметры и сканер переживают перезапуск: запомненное сверяется с вариантами', async () => {
    const root = await makeTempDataRoot();
    const service = await openPassService(root);
    await service.useScanner(connected());
    await service.setParams({ colorMode: 'RGB24', resolution: 600, paperSize: 'Letter' });

    const again = await openPassService(root);
    await again.useScanner(connected());

    const { scanner } = again.snapshot();
    expect(scanner.kind === 'ready' ? scanner.params : null).toEqual({
      colorMode: 'RGB24',
      resolution: 600,
      paperSize: 'Letter',
    });
  });
});
