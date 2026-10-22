import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { EMPTY_EDITS, fail, type BlankMode } from '@shared';
import { describe, expect, it } from 'vitest';
import { pageFixture, pageFixtureNumberOf } from '../../../test/support/fixtures';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { until } from '../../../test/support/until';
import { BLANK_DETECTOR_VERSION, type BlankDetector } from '../detect/blank';
import { layoutOf } from '../storage/layout';
import { openPassService } from './pass-service';

// Оценки пустых оборотов в службе прохода (план M4, U4; R6, R7, R10, R15, R16; KTD3, KTD4):
// детектор подставной — решает по номеру страницы-фикстуры, страницы настоящие JPEG устройства
// (для PDF). Настоящий детектор на сканах — `test/integration/blank-scores.test.ts`.

const SESSION = 'a1b2c3d4e5f60718';
const F = (index: number): string => `p01-s01-${String(index).padStart(4, '0')}`;
const B = (index: number): string => `p02-s01-${String(index).padStart(4, '0')}`;

/** Сессия на диске (журнал v6): лица — фикстуры 1..n, обороты — фикстуры 11..; режим задан. */
async function seedSession(
  root: string,
  fronts: number,
  backs: number,
  blankMode: BlankMode,
  edits = EMPTY_EDITS,
): Promise<void> {
  const layout = layoutOf(root);
  await mkdir(layout.pagesDir, { recursive: true });
  const passes = [
    { number: 1, kind: 'fronts', pages: fronts, from: 1 },
    { number: 2, kind: 'backs', pages: backs, from: 11 },
  ].filter((pass) => pass.pages > 0);
  await writeFile(
    layout.journalFile,
    JSON.stringify({
      version: 6,
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
      edits,
      assembled: null,
      blankMode,
    }),
  );
  for (const pass of passes) {
    for (let index = 1; index <= pass.pages; index += 1) {
      const name = `p${String(pass.number).padStart(2, '0')}-s01-${String(index).padStart(4, '0')}.jpg`;
      await writeFile(join(layout.pagesDir, name), pageFixture(pass.from + index - 1));
    }
  }
}

/**
 * Подставной детектор: фикстуры с номерами из `blank` — пусто (доля 0), остальные — текст;
 * `gate` держит ответы, пока тест не отпустит; `calls` — номера оценённых фикстур.
 */
function detectorOf(blank: readonly number[], options: { gated?: boolean } = {}) {
  const calls: number[] = [];
  let release = (): void => undefined;
  const gate = options.gated
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  const detector: BlankDetector = async (bytes) => {
    const number = pageFixtureNumberOf(bytes);
    calls.push(number);
    await gate;
    return blank.includes(number) ? 0 : 0.03;
  };
  return {
    detector,
    calls,
    release: (): void => {
      release();
    },
  };
}

async function folderIn(root: string): Promise<string> {
  const folder = join(root, 'выход');
  await mkdir(folder, { recursive: true });
  return folder;
}

const SINGLE = { mode: 'single', names: ['Документ'], retry: false } as const;

const blankDir = (root: string): string => join(layoutOf(root).derivedDir, SESSION, 'blank');

describe('служба прохода: оценки пустых оборотов (M4, U4)', () => {
  it('«Скрывать»: обороты без кэша оцениваются после открытия, лента до оценки ждёт, после — с флагами и снимком', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, 2, 2, 'hide');
    const { detector, calls, release } = detectorOf([11], { gated: true });
    const seen: number[] = [];
    const service = await openPassService(root, {
      blankDetector: detector,
      onChange: (seq) => seen.push(seq),
    });

    const before = service.snapshot().assembly;
    expect(before?.blank).toEqual({ mode: 'hide', found: 0, hidden: 0, pending: 2 });
    expect(before?.order.map((page) => page.blank)).toEqual([null, null, null, null]);
    release();
    await until(() => service.snapshot().assembly?.blank.pending === 0);

    // Оценивались только обороты (фикстуры 11, 12), лица — нет (KTD9).
    expect([...calls].sort()).toEqual([11, 12]);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const after = service.snapshot().assembly;
    expect(after?.blank).toEqual({ mode: 'hide', found: 1, hidden: 1, pending: 0 });
    // Пары: 1л (F1), 1о (B2), 2л (F2), 2о (B1); B1 — фикстура 11, пустая.
    expect(after?.order.map((page) => [page.key, page.blank])).toEqual([
      [F(1), null],
      [B(2), null],
      [F(2), null],
      [B(1), 'hidden'],
    ]);
    // Лента, документы и листы — полные: скрытие ничего не двигает (R10).
    expect(after?.documents).toEqual([{ name: '', start: 0, count: 4 }]);
    expect((await readdir(blankDir(root))).sort()).toEqual([`${B(1)}.json`, `${B(2)}.json`]);
    expect(JSON.parse(await readFile(join(blankDir(root), `${B(1)}.json`), 'utf8'))).toEqual({
      v: BLANK_DETECTOR_VERSION,
      ratio: 0,
    });
  });

  it('перезапуск с кэшем: первый снимок уже с флагами, детектор не вызван; кэш другой версии — пересчёт', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, 2, 2, 'hide');
    const first = detectorOf([11]);
    const service = await openPassService(root, { blankDetector: first.detector });
    await until(() => service.snapshot().assembly?.blank.pending === 0);

    const second = detectorOf([11]);
    const again = await openPassService(root, { blankDetector: second.detector });
    expect(again.snapshot().assembly?.blank).toEqual({
      mode: 'hide',
      found: 1,
      hidden: 1,
      pending: 0,
    });
    expect(second.calls).toEqual([]);

    await writeFile(
      join(blankDir(root), `${B(1)}.json`),
      JSON.stringify({ v: BLANK_DETECTOR_VERSION + 1, ratio: 0 }),
    );
    const third = detectorOf([]);
    const rebuilt = await openPassService(root, { blankDetector: third.detector });
    expect(rebuilt.snapshot().assembly?.blank.pending).toBe(1);
    await until(() => rebuilt.snapshot().assembly?.blank.pending === 0);
    expect(third.calls).toEqual([11]);
    expect(rebuilt.snapshot().assembly?.blank).toEqual({
      mode: 'hide',
      found: 0,
      hidden: 0,
      pending: 0,
    });
  });

  it('«Оставлять»: детектор не вызывается, кэша нет, флагов и ожидания нет', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, 2, 2, 'keep');
    const { detector, calls } = detectorOf([11, 12]);
    const service = await openPassService(root, { blankDetector: detector });

    expect(service.snapshot().assembly?.blank).toEqual({
      mode: 'keep',
      found: 0,
      hidden: 0,
      pending: 0,
    });
    expect(calls).toEqual([]);
    expect(await readdir(layoutOf(root).derivedDir).catch(() => [])).toEqual([]);
  });

  it('«Помечать»: пустые помечены, не скрыты; в PDF идут все страницы', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, 2, 2, 'mark');
    const service = await openPassService(root, { blankDetector: detectorOf([11, 12]).detector });
    await until(() => service.snapshot().assembly?.blank.pending === 0);

    expect(service.snapshot().assembly?.blank).toEqual({
      mode: 'mark',
      found: 2,
      hidden: 0,
      pending: 0,
    });
    expect(service.snapshot().assembly?.order.map((page) => page.blank)).toEqual([
      null,
      'marked',
      null,
      'marked',
    ]);
    expect(await service.saveDocuments(folder, SINGLE)).toMatchObject({ ok: true });
    const document = await PDFDocument.load(await readFile(join(folder, 'Документ.pdf')));
    expect(document.getPageCount()).toBe(4);
  });

  it('сбой детектора — не пусто, не ждёт; в кэше null', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, 1, 1, 'hide');
    const service = await openPassService(root, { blankDetector: () => Promise.resolve(null) });
    await until(() => service.snapshot().assembly?.blank.pending === 0);

    expect(service.snapshot().assembly?.blank).toEqual({
      mode: 'hide',
      found: 0,
      hidden: 0,
      pending: 0,
    });
    expect(JSON.parse(await readFile(join(blankDir(root), `${B(1)}.json`), 'utf8'))).toEqual({
      v: BLANK_DETECTOR_VERSION,
      ratio: null,
    });
  });

  it('детектор бросил исключение — сбой оценки: не пусто, не ждёт, в кэше null, снимок без необработанного отказа', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, 1, 1, 'hide');
    const service = await openPassService(root, {
      blankDetector: () => Promise.reject(new Error('детектор упал')),
    });
    await until(() => service.snapshot().assembly?.blank.pending === 0);

    expect(service.snapshot().assembly?.blank).toEqual({
      mode: 'hide',
      found: 0,
      hidden: 0,
      pending: 0,
    });
    expect(JSON.parse(await readFile(join(blankDir(root), `${B(1)}.json`), 'utf8'))).toEqual({
      v: BLANK_DETECTOR_VERSION,
      ratio: null,
    });
  });

  it('запись при незавершённых оценках — blankPending с числом, файлов нет; после — PDF без скрытых', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, 2, 2, 'hide');
    const { detector, release } = detectorOf([11], { gated: true });
    const service = await openPassService(root, { blankDetector: detector });

    expect(await service.saveDocuments(folder, SINGLE)).toEqual(
      fail('sessionConflict', { pending: 2, reason: 'blankPending' }),
    );
    expect(await readdir(folder)).toEqual([]);
    release();
    await until(() => service.snapshot().assembly?.blank.pending === 0);

    expect(await service.saveDocuments(folder, SINGLE)).toMatchObject({
      ok: true,
      value: { written: [{ index: 0, fileName: 'Документ.pdf' }], failed: [] },
    });
    const document = await PDFDocument.load(await readFile(join(folder, 'Документ.pdf')));
    expect(document.getPageCount()).toBe(3);
    expect(service.snapshot().session?.saved).toBe(true);
  });

  it('документ из одних скрытых — documentBlank с номерами; все скрыты — nothingToSave', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    // Пары: F1 B2 F2 B1 F3 B3 → разрезы [1, 4]: документы [F1], [B2 F2 B1], [F3 B3].
    await seedSession(root, 3, 3, 'hide', {
      ...EMPTY_EDITS,
      cuts: [1, 4],
      names: ['Первый', 'Второй', 'Третий'],
    });
    const service = await openPassService(root, {
      blankDetector: detectorOf([11, 12, 13]).detector,
    });
    await until(() => service.snapshot().assembly?.blank.pending === 0);
    const names = ['Первый', 'Второй', 'Третий'];

    // Третий документ целиком: F3, B3 — B3 скрыт, F3 остаётся; второй — остаётся F2. Переносим
    // лица в первый документ: разрезы [3, 4] → [F1 B2 F2], [B1], [F3 B3].
    expect(
      await service.setEdits({ ...EMPTY_EDITS, cuts: [3, 4], names, order: [] }, false),
    ).toMatchObject({ ok: true });
    expect(await service.saveDocuments(folder, { mode: 'separate', names, retry: false })).toEqual(
      fail('sessionConflict', { documents: '2', reason: 'documentBlank' }),
    );
    expect(await readdir(folder)).toEqual([]);

    // Все лица удалены — остались одни скрытые обороты.
    expect(
      await service.setEdits({ ...EMPTY_EDITS, deleted: [F(1), F(2), F(3)] }, false),
    ).toMatchObject({ ok: true });
    expect(await service.saveDocuments(folder, SINGLE)).toEqual(
      fail('sessionConflict', { reason: 'nothingToSave' }),
    );
  });

  it('пометка «не пустая» возвращает страницу в файл, считается правкой; «Вернуть» снимает', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, 2, 2, 'hide');
    const service = await openPassService(root, { blankDetector: detectorOf([11]).detector });
    await until(() => service.snapshot().assembly?.blank.pending === 0);
    expect(service.snapshot().assembly?.hasEdits).toBe(false);

    expect(
      await service.setEdits({ ...EMPTY_EDITS, notBlank: [B(1), 'p09-s01-0001'] }, false),
    ).toMatchObject({ ok: true });

    const marked = service.snapshot();
    expect(marked.session?.edits.notBlank).toEqual([B(1)]);
    expect(marked.assembly?.hasEdits).toBe(true);
    expect(marked.assembly?.blank).toEqual({ mode: 'hide', found: 0, hidden: 0, pending: 0 });
    expect(await service.saveDocuments(folder, SINGLE)).toMatchObject({ ok: true });
    const document = await PDFDocument.load(await readFile(join(folder, 'Документ.pdf')));
    expect(document.getPageCount()).toBe(4);

    // Пометка переживает перезапуск; «Вернуть» (пустые правки) её снимает.
    const again = await openPassService(root, { blankDetector: detectorOf([11]).detector });
    expect(again.snapshot().assembly?.blank.hidden).toBe(0);
    expect(await again.setEdits(EMPTY_EDITS, false)).toMatchObject({ ok: true });
    expect(again.snapshot().assembly?.blank.hidden).toBe(1);
    expect(again.snapshot().assembly?.hasEdits).toBe(false);
  });

  it('«Новая пачка» уносит кэш оценок вместе с производным', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, 1, 1, 'hide');
    const service = await openPassService(root, { blankDetector: detectorOf([11]).detector });
    await until(() => service.snapshot().assembly?.blank.pending === 0);
    expect(await readdir(blankDir(root))).toEqual([`${B(1)}.json`]);

    expect(await service.closeSession()).toEqual({ ok: true, value: undefined });

    expect(await readdir(layoutOf(root).derivedDir).catch(() => [])).toEqual([]);
    expect(service.snapshot().assembly).toBeNull();
  });
});
