import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { fail, type SessionEdits, type Snapshot } from '@shared';
import { probeScanner, type ConnectedScanner } from '../../src/core/escl/connect';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import { openPassService, type PassServiceOptions } from '../../src/core/scan/pass-service';
import { layoutOf } from '../../src/core/storage/layout';
import { realStorageFs } from '../../src/core/storage/storage-fs';
import type { Scenario } from '../emulator/scenarios';
import { startTestEmulator } from '../support/emulator';
import { pageFixture } from '../support/fixtures';
import { fsError, interceptFs } from '../support/intercept-fs';
import { makeTempDataRoot } from '../support/temp-data-root';
import { unwrap } from '../support/result';
import { untilScored } from '../support/until';

// Правки и пакетное сохранение на настоящей цепочке (план M3, U10): эмулятор → клиент →
// хранилище → служба. Ядро проверяет то же на посеянной сессии; здесь — что страницы настоящих
// проходов, журнал v3 после перезапуска и запись PDF сходятся в одном пути.

const FAST: Partial<ScanJobLimits> = {
  retryDelayMs: 5,
  busyCeilingMs: 200,
  notReadyCeilingMs: 2000,
  pageIdleTimeoutMs: 300,
  pageDeadlineMs: 3000,
  deleteDeadlineMs: 300,
};

const OPTIONS = {
  jobLimits: FAST,
  minFreeBytes: 1,
  retry: { ceilingMs: 0 },
} satisfies PassServiceOptions;

async function connect(scenario: Partial<Scenario>) {
  const emulator = await startTestEmulator({ scenario });
  const connected: ConnectedScanner = unwrap(
    await probeScanner({ ...emulator, fingerprint: null }),
  );
  return { emulator, connected, root: await makeTempDataRoot() };
}

async function pdfAngles(path: string): Promise<number[]> {
  const document = await PDFDocument.load(await readFile(path));
  return document.getPages().map((page) => page.getRotation().angle);
}

describe('правки и сохранение через эмулятор (M3, U10)', () => {
  // Два прохода: лица 1–3, обороты обратным порядком — оборот третьего листа пришёл первым.
  const F1 = 'p01-s01-0001';
  const F2 = 'p01-s01-0002';
  const F3 = 'p01-s01-0003';
  const B3 = 'p02-s01-0001';
  const B2 = 'p02-s01-0002';
  const B1 = 'p02-s01-0003';
  const FIXTURES: Readonly<Record<string, number>> = {
    [F1]: 1,
    [F2]: 2,
    [F3]: 3,
    [B3]: 6,
    [B2]: 5,
    [B1]: 4,
  };
  const NAMES = ['Счёт', 'Акт', 'Договор', 'Накладная', 'Опись'];
  // Третий лист — в начало, оборот третьего удалён, повороты ручные; каждая страница — документ.
  const EDITS: SessionEdits = {
    order: [F3, F1, B1, F2, B2, B3],
    rotations: { [F1]: 90, [B1]: 90 },
    deleted: [B3],
    cuts: [1, 2, 3, 4],
    names: NAMES,
    divider: null,
    notBlank: [],
  };

  it('AE1, AE7: правки переживают перезапуск; пакет — занятое имя, сбой записи, повтор', async () => {
    const { connected, root } = await connect({
      trays: [
        [1, 2, 3],
        [6, 5, 4],
      ],
    });
    const first = await openPassService(root, OPTIONS);
    await first.useScanner(connected);
    expect(unwrap(await first.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    expect(unwrap(await first.startPass(null))).toMatchObject({ end: 'completed', pages: 3 });
    unwrap(await first.setEdits(EDITS, { 2: true }));

    const check = (snapshot: Snapshot): void => {
      expect(snapshot.session).toMatchObject({ saved: false, edits: EDITS });
      // Ручной угол складывается с 180° прохода оборотов.
      expect(snapshot.assembly?.order.map((page) => [page.key, page.angle])).toEqual([
        [F3, 0],
        [F1, 90],
        [B1, 270],
        [F2, 0],
        [B2, 180],
      ]);
      expect(snapshot.assembly?.documents.map((doc) => doc.name)).toEqual(NAMES);
      expect(snapshot.assembly).toMatchObject({ orderEdited: true, hasEdits: true, deleted: 1 });
    };
    check(first.snapshot());

    // Перезапуск: служба поднимается с журнала v3; запись «Накладной» падает, пока не починят.
    const folder = join(root, 'выход');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'Акт.pdf'), 'чужой документ');
    let failWrite = true;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (failWrite && call.op === 'rename' && call.to?.endsWith('Накладная.pdf') === true) {
        throw fsError('EIO');
      }
    });
    const service = await openPassService(root, { ...OPTIONS, fs });
    check(service.snapshot());

    const request = { mode: 'separate', names: NAMES, retry: false } as const;
    await untilScored(() => service.snapshot());
    expect(unwrap(await service.saveDocuments(folder, request))).toEqual({
      folder,
      written: [
        { index: 0, fileName: 'Счёт.pdf' },
        { index: 1, fileName: 'Акт (2).pdf' },
        { index: 2, fileName: 'Договор.pdf' },
        { index: 4, fileName: 'Опись.pdf' },
      ],
      failed: [
        {
          index: 3,
          fileName: 'Накладная.pdf',
          error: { code: 'saveWriteFailed', details: { reason: 'EIO' } },
        },
      ],
    });
    expect(service.snapshot().session?.saved).toBe(false);

    failWrite = false;
    const retry = unwrap(await service.saveDocuments(folder, { ...request, retry: true }));
    expect(retry.failed).toEqual([]);
    expect(retry.written).toHaveLength(5);
    expect(service.snapshot().session?.saved).toBe(true);

    expect(await readFile(join(folder, 'Акт.pdf'), 'utf8')).toBe('чужой документ');
    expect((await readdir(folder)).sort()).toEqual(
      ['Акт (2).pdf', 'Акт.pdf', 'Договор.pdf', 'Накладная.pdf', 'Опись.pdf', 'Счёт.pdf'].sort(),
    );
    const angles = await Promise.all(
      ['Счёт.pdf', 'Акт (2).pdf', 'Договор.pdf', 'Накладная.pdf', 'Опись.pdf'].map((name) =>
        pdfAngles(join(folder, name)),
      ),
    );
    expect(angles).toEqual([[0], [90], [270], [0], [180]]);

    // Исходники не тронуты, удалённая страница — пометка: файл жив до закрытия сессии.
    for (const [key, fixture] of Object.entries(FIXTURES)) {
      const source = await readFile(join(layoutOf(root).pagesDir, `${key}.jpg`));
      expect(source.equals(pageFixture(fixture)), key).toBe(true);
    }
  });

  it('досканирование при ручном порядке — новые страницы на своём месте по автопорядку, расстановка цела (M3.5, KTD-3; замена AE9 M3)', async () => {
    const { emulator, connected, root } = await connect({
      sheets: 4,
      fault: { sheet: 3, kind: 'gone' },
    });
    const service = await openPassService(root, OPTIONS);
    await service.useScanner(connected);
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'interrupted', pages: 2 });
    const manual: SessionEdits = {
      order: ['p01-s01-0002', 'p01-s01-0001'],
      rotations: {},
      deleted: [],
      cuts: [1],
      names: ['', 'Хвост'],
      divider: null,
      notBlank: [],
    };
    unwrap(await service.setEdits(manual, {}));

    emulator.clearJam();
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });

    // Предшественник досканированных страниц по автопорядку — p01-s01-0002, первая в ручном
    // порядке: они встают за ней; разрез остаётся перед той же страницей.
    const snapshot = service.snapshot();
    expect(snapshot.session?.edits).toEqual({
      ...manual,
      order: ['p01-s01-0002', 'p01-s02-0001', 'p01-s02-0002', 'p01-s01-0001'],
      cuts: [3],
    });
    expect(snapshot.assembly?.order.map((page) => page.key)).toEqual([
      'p01-s01-0002',
      'p01-s02-0001',
      'p01-s02-0002',
      'p01-s01-0001',
    ]);
    expect(snapshot.assembly?.documents.map((doc) => [doc.name, doc.count])).toEqual([
      ['', 3],
      ['Хвост', 1],
    ]);

    const folder = join(root, 'выход');
    await mkdir(folder, { recursive: true });
    await untilScored(() => service.snapshot());
    const saved = unwrap(
      await service.saveDocuments(folder, {
        mode: 'separate',
        names: ['Обложка', 'Хвост'],
        retry: false,
      }),
    );
    expect(saved.failed).toEqual([]);
    expect(await pdfAngles(join(folder, 'Обложка.pdf'))).toHaveLength(3);
    expect(await pdfAngles(join(folder, 'Хвост.pdf'))).toHaveLength(1);
  });
});

describe('пакетное сохранение через эмулятор (M3)', () => {
  it('незавершённый пакет не переживает «Новое сканирование»: повтор не пишет новую сессию в старую папку', async () => {
    const { connected, root } = await connect({ trays: [[1, 2], [3]] });
    const folder = join(root, 'выход');
    await mkdir(folder, { recursive: true });
    let failWrite = true;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (failWrite && call.op === 'rename' && call.to?.endsWith('Скан.pdf') === true) {
        throw fsError('EIO');
      }
    });
    const service = await openPassService(root, { ...OPTIONS, fs });
    await service.useScanner(connected);
    const request = { mode: 'single', names: ['Скан'], retry: false } as const;

    // Первая сессия: пакет упал на записи — незавершённый.
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });
    const first = service.sessionId();
    await untilScored(() => service.snapshot());
    expect(unwrap(await service.saveDocuments(folder, request)).failed).toHaveLength(1);

    // «Новое сканирование»: другая сессия в той же службе.
    unwrap(await service.closeSession());
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 1 });
    expect(service.sessionId()).not.toBe(first);

    failWrite = false;
    expect(await service.saveDocuments(folder, { ...request, retry: true })).toEqual(
      fail('sessionConflict', { reason: 'noFailedFiles' }),
    );
    expect(await readdir(folder)).toEqual([]);
  });
});
