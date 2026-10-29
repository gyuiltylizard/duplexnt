import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { EMPTY_EDITS, fail } from '@shared';
import { describe, expect, it } from 'vitest';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import { seedSession } from '../../../test/support/pass-service-seed';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { layoutOf } from '../storage/layout';
import { realStorageFs } from '../storage/storage-fs';
import { openPassService } from './pass-service';

// Пакетное сохранение в службе прохода (план M3, U4; R13; AE7, AE10, AE12): PDF по разрезам
// ленты на сессиях, посеянных на диск с настоящими JPEG устройства, сбои файлов и повтор,
// конфликты с правками. Выделено из `pass-service.test.ts` по правилу размера тестового файла;
// общие хелперы — test/support/pass-service-seed.ts.

describe('служба прохода: пакетное сохранение (M3, U4)', () => {
  /** Пять страниц — пять документов по разрезам; настоящие JPEG устройства. */
  async function fiveDocuments(root: string, extra: Record<string, unknown> = {}) {
    await seedSession(root, [{ number: 1, pages: 5, fixtures: [1, 2, 3, 4, 5] }], extra);
    const service = await openPassService(root);
    await service.setEdits({ ...EMPTY_EDITS, cuts: [1, 2, 3, 4], names: ['', '', '', '', ''] }, {});
    return service;
  }

  async function folderIn(root: string): Promise<string> {
    const folder = join(root, 'выход');
    await mkdir(folder, { recursive: true });
    return folder;
  }

  const NAMES = ['Счёт', 'Акт', 'Договор', 'Накладная', 'Опись'];

  /** Двусторонняя сессия 2+2 с настоящими JPEG устройства; обороты с флагом поворота. */
  async function duplex(root: string) {
    await seedSession(root, [
      { number: 1, pages: 2, fixtures: [1, 2] },
      { number: 2, pages: 2, rotate180: true, fixtures: [6, 5] },
    ]);
  }

  it('PDF в собранном порядке, /Rotate на оборотах, отметка в журнале durable, сессия цела', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await duplex(root);
    const service = await openPassService(root);

    expect(
      await service.saveDocuments(folder, { mode: 'single', names: ['скан'], retry: false }),
    ).toEqual({
      ok: true,
      value: { folder, written: [{ index: 0, fileName: 'скан.pdf' }], failed: [] },
    });
    // Папка пакета — для «Открыть папку» (M3.5, KTD-9); до пакета её нет.
    expect(service.lastBatchFolder()).toBe(folder);
    const document = await PDFDocument.load(await readFile(join(folder, 'скан.pdf')));
    // Порядок: 1л, 1о, 2л, 2о; обороты повёрнуты.
    expect(document.getPageCount()).toBe(4);
    expect(document.getPages().map((page) => page.getRotation().angle)).toEqual([0, 180, 0, 180]);

    // Отметка о сохранении — durable; сессия не удалена (R12).
    expect(service.snapshot().session?.saved).toBe(true);
    const again = await openPassService(root);
    expect(again.snapshot().session?.saved).toBe(true);
    expect(again.snapshot().session?.passes).toHaveLength(2);

    // Правка после сохранения снимает отметку (KTD-7, AE12).
    expect(await again.setEdits(EMPTY_EDITS, {})).toMatchObject({ ok: true });
    expect(again.snapshot().session?.saved).toBe(false);
  });

  it('потерянная страница — сбой файла кодом, а не PDF без неё; отметки нет', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await duplex(root);
    await rm(join(layoutOf(root).pagesDir, 'p01-s01-0002.jpg'));
    const service = await openPassService(root);
    expect(service.lastBatchFolder()).toBeNull();

    expect(
      await service.saveDocuments(folder, { mode: 'single', names: ['скан'], retry: false }),
    ).toMatchObject({
      ok: true,
      value: {
        written: [],
        failed: [
          {
            index: 0,
            fileName: 'скан.pdf',
            error: { code: 'pageUnavailable', details: { reason: 'lost' } },
          },
        ],
      },
    });
    expect(await readdir(folder)).toEqual([]);
    expect(service.snapshot().session?.saved).toBe(false);
    // Пакет без единого записанного файла папку не помнит: открывать там нечего.
    expect(service.lastBatchFolder()).toBeNull();
  });

  it('без сессии — noSession; в папку ничего не пишется', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    const service = await openPassService(root);

    expect(
      await service.saveDocuments(folder, { mode: 'single', names: ['скан'], retry: false }),
    ).toEqual(fail('sessionConflict', { reason: 'noSession' }));
    expect(await readdir(folder)).toEqual([]);
  });

  it('AE7: занятое имя — суффикс, сбой четвёртого — итог «4 из 5», повтор дописывает и ставит «сохранено»', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await writeFile(join(folder, 'акт.pdf'), 'чужой документ');
    await seedSession(root, [{ number: 1, pages: 5, fixtures: [1, 2, 3, 4, 5] }]);
    let failFourth = true;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (failFourth && call.op === 'rename' && call.to?.endsWith('Накладная.pdf') === true) {
        throw fsError('EIO');
      }
    });
    const service = await openPassService(root, { fs, retry: { ceilingMs: 0 } });
    await service.setEdits({ ...EMPTY_EDITS, cuts: [1, 2, 3, 4], names: ['', '', '', '', ''] }, {});

    const first = await service.saveDocuments(folder, {
      mode: 'separate',
      names: NAMES,
      retry: false,
    });

    expect(first).toEqual({
      ok: true,
      value: {
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
      },
    });
    expect(await readFile(join(folder, 'акт.pdf'), 'utf8')).toBe('чужой документ');
    expect(service.snapshot().session?.saved).toBe(false);

    failFourth = false;
    const retry = await service.saveDocuments(join(root, 'другая папка'), {
      mode: 'separate',
      names: NAMES,
      retry: true,
    });

    // Повтор пишет только неудавшийся — и в папку пакета, не в новую.
    expect(retry).toMatchObject({ ok: true, value: { folder, failed: [] } });
    expect(retry.ok && retry.value.written.map((file) => file.fileName)).toEqual([
      'Счёт.pdf',
      'Акт (2).pdf',
      'Договор.pdf',
      'Накладная.pdf',
      'Опись.pdf',
    ]);
    expect((await readdir(folder)).sort()).toHaveLength(6);
    const document = await PDFDocument.load(await readFile(join(folder, 'Накладная.pdf')));
    expect(document.getPageCount()).toBe(1);
    expect(service.snapshot().session?.saved).toBe(true);
  });

  it('документы — отрезки ленты с правками: порядок, углы, без удалённых', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, [{ number: 1, pages: 3, fixtures: [1, 2, 3] }]);
    const service = await openPassService(root);
    await service.setEdits(
      {
        order: ['p01-s01-0003', 'p01-s01-0001', 'p01-s01-0002'],
        rotations: { 'p01-s01-0001': 90 },
        deleted: ['p01-s01-0002'],
        cuts: [1],
        names: ['', ''],
        divider: null,
        notBlank: [],
        keepOriginal: [],
      },
      {},
    );

    const saved = await service.saveDocuments(folder, {
      mode: 'separate',
      names: ['Первый', 'Второй'],
      retry: false,
    });

    expect(saved).toMatchObject({ ok: true, value: { failed: [] } });
    const second = await PDFDocument.load(await readFile(join(folder, 'Второй.pdf')));
    expect(second.getPages().map((page) => page.getRotation().angle)).toEqual([90]);
    const first = await PDFDocument.load(await readFile(join(folder, 'Первый.pdf')));
    expect(first.getPageCount()).toBe(1);
  });

  it('AE12: «один файл» при границах — один PDF со всеми страницами; разрезы и имена в журнале целы', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    const service = await fiveDocuments(root);
    const edits = service.snapshot().session?.edits;

    const saved = await service.saveDocuments(folder, {
      mode: 'single',
      names: ['Всё'],
      retry: false,
    });

    expect(saved).toEqual({
      ok: true,
      value: { folder, written: [{ index: 0, fileName: 'Всё.pdf' }], failed: [] },
    });
    const document = await PDFDocument.load(await readFile(join(folder, 'Всё.pdf')));
    expect(document.getPageCount()).toBe(5);
    expect(service.snapshot().session).toMatchObject({ saved: true, edits });
  });

  it('число имён не равно числу документов — invalidInput; ничего не записано', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    const service = await fiveDocuments(root);

    expect(
      await service.saveDocuments(folder, { mode: 'separate', names: ['Один'], retry: false }),
    ).toEqual(fail('invalidInput', { field: 'names', problem: 'count' }));
    expect(await readdir(folder)).toEqual([]);
  });

  it('все страницы удалены — nothingToSave (AE10)', async () => {
    const root = await makeTempDataRoot();
    await seedSession(root, [{ number: 1, pages: 2 }]);
    const service = await openPassService(root);
    await service.setEdits({ ...EMPTY_EDITS, deleted: ['p01-s01-0001', 'p01-s01-0002'] }, {});

    expect(
      await service.saveDocuments(await folderIn(root), {
        mode: 'single',
        names: ['А'],
        retry: false,
      }),
    ).toEqual(fail('sessionConflict', { reason: 'nothingToSave' }));
  });

  it('повторять нечего — noFailedFiles', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    const service = await fiveDocuments(root);
    const request = { mode: 'separate', names: NAMES, retry: true } as const;

    expect(await service.saveDocuments(folder, request)).toEqual(
      fail('sessionConflict', { reason: 'noFailedFiles' }),
    );
    await service.saveDocuments(folder, { ...request, retry: false });
    expect(await service.saveDocuments(folder, request)).toEqual(
      fail('sessionConflict', { reason: 'noFailedFiles' }),
    );
  });

  it('правка между попыткой и повтором — повтор отклонён batchStale: пакет пишется заново (R13)', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, [{ number: 1, pages: 2, fixtures: [1, 2] }]);
    let failWrite = true;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (failWrite && call.op === 'rename' && call.to?.endsWith('Б.pdf') === true) {
        throw fsError('EIO');
      }
    });
    const service = await openPassService(root, { fs, retry: { ceilingMs: 0 } });
    await service.setEdits({ ...EMPTY_EDITS, cuts: [1], names: ['', ''] }, {});
    const request = { mode: 'separate', names: ['А', 'Б'], retry: false } as const;
    expect(await service.saveDocuments(folder, request)).toMatchObject({
      ok: true,
      value: { failed: [{ index: 1 }] },
    });

    // Между попытками — правка: поворот первого документа.
    await service.setEdits(
      { ...EMPTY_EDITS, rotations: { 'p01-s01-0001': 180 }, cuts: [1], names: ['', ''] },
      {},
    );
    failWrite = false;
    expect(await service.saveDocuments(folder, { ...request, retry: true })).toEqual(
      fail('sessionConflict', { reason: 'batchStale' }),
    );
    // Дописано ничего не было: смешанного пакета на диске нет; отметки «сохранено» нет.
    expect((await readdir(folder)).sort()).toEqual(['А.pdf']);
    expect(service.snapshot().session?.saved).toBe(false);
    // Пакет забыт: следующий повтор — нечего повторять, новый пакет — по текущей ленте.
    expect(await service.saveDocuments(folder, { ...request, retry: true })).toEqual(
      fail('sessionConflict', { reason: 'noFailedFiles' }),
    );
    expect(await service.saveDocuments(folder, request)).toMatchObject({
      ok: true,
      value: { failed: [], written: [{ fileName: 'А (2).pdf' }, { fileName: 'Б.pdf' }] },
    });
    expect(service.snapshot().session?.saved).toBe(true);
  });

  it('новый пакет забывает прежний незавершённый, даже если сам упал на папке', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, [{ number: 1, pages: 1, fixtures: [1] }]);
    let failWrite = true;
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (failWrite && call.op === 'rename' && call.to?.endsWith('А.pdf') === true) {
        throw fsError('EIO');
      }
    });
    const service = await openPassService(root, { fs, retry: { ceilingMs: 0 } });
    const request = { mode: 'single', names: ['А'], retry: false } as const;
    expect(await service.saveDocuments(folder, request)).toMatchObject({
      ok: true,
      value: { failed: [{ index: 0 }] },
    });

    expect(await service.saveDocuments(join(root, 'нет такой'), request)).toMatchObject({
      ok: false,
      error: { code: 'saveWriteFailed' },
    });
    failWrite = false;
    expect(await service.saveDocuments(folder, { ...request, retry: true })).toEqual(
      fail('sessionConflict', { reason: 'noFailedFiles' }),
    );
    expect(await readdir(folder)).toEqual([]);
  });

  it('пока пишется пакет, правка отклоняется конфликтом saving (KTD-9)', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, [{ number: 1, pages: 1, fixtures: [1] }]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Задержка — только на папке пакета: сверка при открытии тоже читает каталоги.
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

    const request = { mode: 'single', names: ['А'], retry: false } as const;
    const saving = service.saveDocuments(folder, request);
    const busy = fail('sessionConflict', { reason: 'saving' });
    expect(await service.setEdits({ ...EMPTY_EDITS, deleted: ['p01-s01-0001'] }, {})).toEqual(busy);
    // Второй пакет (двойной клик), закрытие сессии и новый проход — тоже ждут конца записи.
    expect(await service.saveDocuments(folder, request)).toEqual(busy);
    expect(await service.closeSession()).toEqual(busy);
    expect(await service.startPass(null)).toEqual(busy);
    release();
    expect(await saving).toMatchObject({ ok: true, value: { failed: [] } });
    expect(await readdir(folder)).toEqual(['А.pdf']);
    // Запись кончилась — флаг снят.
    expect(await service.saveDocuments(folder, request)).toMatchObject({ ok: true });
  });

  it('id сессии без снимка; после «Нового сканирования» повтор пакета закрытой сессии не идёт', async () => {
    const root = await makeTempDataRoot();
    const folder = await folderIn(root);
    await seedSession(root, [{ number: 1, pages: 1, fixtures: [1] }]);
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (call.op === 'rename' && call.to?.endsWith('А.pdf') === true) {
        throw fsError('EIO');
      }
    });
    const service = await openPassService(root, { fs, retry: { ceilingMs: 0 } });
    const request = { mode: 'single', names: ['А'], retry: false } as const;
    expect(await service.saveDocuments(folder, request)).toMatchObject({
      ok: true,
      value: { failed: [{ index: 0 }] },
    });
    const closedId = service.sessionId();
    expect(closedId).toBe(service.snapshot().session?.id);

    expect(await service.closeSession()).toMatchObject({ ok: true });
    expect(await service.saveDocuments(folder, { ...request, retry: true })).toEqual(
      fail('sessionConflict', { reason: 'noSession' }),
    );
    expect(service.sessionId()).toBeNull();
  });
});
