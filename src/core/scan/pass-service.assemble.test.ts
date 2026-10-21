import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EMPTY_EDITS, fail } from '@shared';
import { describe, expect, it } from 'vitest';
import { ET_3850, readFixture } from '../../../test/support/fixtures';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { layoutOf } from '../storage/layout';
import { realStorageFs } from '../storage/storage-fs';
import { openPassService } from './pass-service';

// «Собрать документ» и запрет сохранения несобранного (план M3.6, U3; R12–R16; KTD5, KTD6) —
// на сессиях, посеянных на диск. Гарды хранилища — в `session-store.assemble.test.ts`;
// полный путь с эмулятором — U7.

const SESSION = 'a1b2c3d4e5f60718';
const F = (index: number): string => `p01-s01-${String(index).padStart(4, '0')}`;
const B = (index: number): string => `p02-s01-${String(index).padStart(4, '0')}`;

/** Сессия на диске: лица `fronts` страниц, обороты `backs` (журнал v5, `origin: null`). */
async function seedSession(root: string, fronts: number, backs: number): Promise<void> {
  const layout = layoutOf(root);
  await mkdir(layout.pagesDir, { recursive: true });
  const passes = [
    { number: 1, kind: 'fronts', pages: fronts },
    { number: 2, kind: 'backs', pages: backs },
  ].filter((pass) => pass.pages > 0);
  await writeFile(
    layout.journalFile,
    JSON.stringify({
      version: 5,
      sessionId: SESSION,
      nextPass: 3,
      passes: passes.map((pass) => ({
        number: pass.number,
        accepted: false,
        origin: null,
        nextSegment: 2,
        segments: [{ number: 1, state: 'completed', pageCount: pass.pages }],
        rotate180: false,
        kind: pass.kind,
        after: null,
      })),
      deletions: [],
      backsDeclined: false,
      saved: false,
      edits: EMPTY_EDITS,
      assembled: null,
    }),
  );
  for (const pass of passes) {
    for (let index = 1; index <= pass.pages; index += 1) {
      const name = `p${String(pass.number).padStart(2, '0')}-s01-${String(index).padStart(4, '0')}.jpg`;
      const fixture = readFixture(...ET_3850, 'pages', `page-0${String(index)}.jpg`);
      await writeFile(join(layout.pagesDir, name), fixture);
    }
  }
}

async function folderIn(root: string): Promise<string> {
  const folder = join(root, 'выход');
  await mkdir(folder, { recursive: true });
  return folder;
}

const SINGLE = { mode: 'single', names: ['Документ'], retry: false } as const;

describe('служба прохода: «Собрать документ» (M3.6, U3)', () => {
  it('AE7: до сборки — раздельные наборы; после — «собрано», запись переживает перезапуск службы', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, 3, 2);
    const seen: number[] = [];
    const service = await openPassService(root, { onChange: (seq) => seen.push(seq) });

    expect(service.snapshot().assembly?.report).toMatchObject({ mode: 'sets', mismatch: true });
    // Уравнять удалением лица: 2/2.
    expect(await service.setEdits({ ...EMPTY_EDITS, deleted: [F(2)] }, false)).toMatchObject({
      ok: true,
    });
    const before = seen.length;

    expect(await service.assemble()).toEqual({ ok: true, value: undefined });

    expect(seen.length).toBeGreaterThan(before);
    expect(service.snapshot().session?.assembled).toEqual([F(1), F(2), B(2), F(3), B(1)]);
    expect(service.snapshot().assembly?.report).toMatchObject({
      mode: 'assembled',
      mismatch: false,
    });
    expect(service.snapshot().assembly?.order.map((page) => page.key)).toEqual([
      F(1),
      B(2),
      F(3),
      B(1),
    ]);

    const again = await openPassService(root);
    expect(again.snapshot().session?.assembled).toEqual([F(1), F(2), B(2), F(3), B(1)]);
    expect(again.snapshot().assembly?.report.mode).toBe('assembled');
  });

  it('отказ хранилища доходит кодом; снимок при отказе всё равно шлётся', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, 3, 2);
    const seen: number[] = [];
    const service = await openPassService(root, { onChange: (seq) => seen.push(seq) });

    expect(await service.assemble()).toEqual(fail('sessionConflict', { reason: 'setsUnequal' }));
    expect(seen.length).toBeGreaterThan(0);
  });

  it('AE15: сохранение в режиме наборов отказывает notAssembled — файлов нет; после сборки пишет', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, 2, 1);
    const service = await openPassService(root);

    expect(await service.saveDocuments(folder, SINGLE)).toEqual(
      fail('sessionConflict', { reason: 'notAssembled' }),
    );
    expect(await readdir(folder)).toEqual([]);

    expect(await service.setEdits({ ...EMPTY_EDITS, deleted: [F(2)] }, false)).toMatchObject({
      ok: true,
    });
    expect(await service.assemble()).toMatchObject({ ok: true });
    expect(await service.saveDocuments(folder, SINGLE)).toMatchObject({
      ok: true,
      value: { failed: [] },
    });
    expect(await readdir(folder)).toEqual(['Документ.pdf']);
    expect(service.snapshot().session?.saved).toBe(true);
  });

  it('в режиме пар сохранение — как прежде; сборка — notSeparate', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, 2, 2);
    const service = await openPassService(root);

    expect(await service.assemble()).toEqual(fail('sessionConflict', { reason: 'notSeparate' }));
    expect(await service.saveDocuments(folder, SINGLE)).toMatchObject({ ok: true });
    expect(await readdir(folder)).toEqual(['Документ.pdf']);
  });

  it('пока пишется пакет, сборка отклоняется конфликтом saving (KTD-9)', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, 1, 0);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowFs = {
      ...realStorageFs,
      readdir: async (path: string) => {
        if (path === folder) {
          await gate;
        }
        return realStorageFs.readdir(path);
      },
    };
    const service = await openPassService(root, { fs: slowFs });

    const saving = service.saveDocuments(folder, SINGLE);
    expect(await service.assemble()).toEqual(fail('sessionConflict', { reason: 'saving' }));
    release();
    expect(await saving).toMatchObject({ ok: true });
  });
});
