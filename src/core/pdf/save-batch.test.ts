import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, ok, type Result } from '@shared';
import { describe, expect, it } from 'vitest';
import { fsError, interceptFs } from '../../../test/support/intercept-fs';
import { makeTempDataRoot } from '../../../test/support/temp-data-root';
import { ioOf, realStorageFs } from '../storage/storage-fs';
import {
  graphemesOf,
  MAX_FILE_BASE_LENGTH,
  pickFileName,
  sanitizeFileBase,
  writeBatch,
  type BatchItem,
} from './save-batch';

// Пакетная запись (план M3, U4; KTD-11) — обязательная зона тест-политики: здесь решается, не
// перезапишет ли сохранение чужой файл и не потеряется ли документ молча.

describe('имя файла: правила Windows (KTD-11)', () => {
  it.each([
    ['обычное имя не меняется', 'Договор аренды', 'Договор аренды'],
    ['запрещённые символы → «_»', 'Счёт 1/2: «итог»?*', 'Счёт 1_2_ «итог»__'],
    ['кавычки, угловые скобки, черта', 'a"b<c>d|e\\f', 'a_b_c_d_e_f'],
    ['управляющие коды → «_»', 'a\u0000b\u001fc', 'a_b_c'],
    ['хвостовые точки и пробелы срезаны', 'Акт. . ', 'Акт'],
    ['пробелы по краям срезаны', '  Акт  ', 'Акт'],
    ['лишний «.pdf» срезан без учёта регистра', 'Акт.PDF', 'Акт'],
    ['имя устройства с любым регистром', 'con', 'con_'],
    ['имя устройства с расширением', 'COM1.v2', 'COM1_.v2'],
    ['похожее на устройство — не трогается', 'console', 'console'],
    ['пустое → «_»', '', '_'],
    ['одни точки и пробелы → «_»', ' ... ', '_'],
  ])('%s', (_name, given, expected) => {
    expect(sanitizeFileBase(given)).toBe(expected);
  });

  it('длина — в графемах: составной эмодзи не режется', () => {
    const family = '👨‍👩‍👧';
    const long = `${'я'.repeat(MAX_FILE_BASE_LENGTH - 1)}${family}${family}`;

    const base = sanitizeFileBase(long);
    expect(graphemesOf(base)).toHaveLength(MAX_FILE_BASE_LENGTH);
    expect(base.endsWith(family)).toBe(true);
  });
});

describe('имя файла: занятость без учёта регистра', () => {
  it.each([
    ['свободно', [], 'Акт.pdf'],
    ['занято тем же регистром', ['акт.pdf'], 'Акт (2).pdf'],
    ['занято другим регистром и суффиксы тоже', ['акт.pdf', 'акт (2).pdf'], 'Акт (3).pdf'],
  ])('%s', (_name, taken, expected) => {
    expect(pickFileName('Акт', new Set(taken))).toBe(expected);
  });
});

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const item = (index: number, name: string, build?: () => Promise<Result<Uint8Array>>) =>
  ({
    index,
    name,
    build: build ?? (() => Promise.resolve(ok(bytesOf(`pdf ${index}`)))),
  }) satisfies BatchItem;

async function folderWith(files: Record<string, string> = {}): Promise<string> {
  const folder = join(await makeTempDataRoot(), 'Сканы');
  await mkdir(folder, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(folder, name), content);
  }
  return folder;
}

describe('пакетная запись (R12, R14)', () => {
  it('занятое имя — суффикс, чужой файл байт-в-байт цел', async () => {
    const folder = await folderWith({ 'Акт.pdf': 'чужой документ' });

    const outcome = await writeBatch(folder, [item(0, 'Счёт'), item(1, 'Акт')], ioOf({}));

    expect(outcome).toEqual(
      ok({
        written: [
          { index: 0, fileName: 'Счёт.pdf' },
          { index: 1, fileName: 'Акт (2).pdf' },
        ],
        failed: [],
      }),
    );
    expect(await readFile(join(folder, 'Акт.pdf'), 'utf8')).toBe('чужой документ');
    expect(await readFile(join(folder, 'Акт (2).pdf'), 'utf8')).toBe('pdf 1');
  });

  it('одинаковые имена в пакете, в том числе разным регистром, не затирают друг друга', async () => {
    const folder = await folderWith();

    const outcome = await writeBatch(
      folder,
      [item(0, 'Документ'), item(1, 'документ'), item(2, 'ДОКУМЕНТ.pdf')],
      ioOf({}),
    );

    expect(outcome.ok && outcome.value.written.map((file) => file.fileName)).toEqual([
      'Документ.pdf',
      'документ (2).pdf',
      'ДОКУМЕНТ (3).pdf',
    ]);
    expect((await readdir(folder)).sort()).toHaveLength(3);
  });

  it('сбой сборки одного документа не прерывает остальные; имя за ним остаётся', async () => {
    const folder = await folderWith();
    const broken = () => Promise.resolve(fail('pageUnavailable', { reason: 'lost' }));

    const outcome = await writeBatch(
      folder,
      [item(0, 'А'), item(1, 'Б', broken), item(2, 'Б')],
      ioOf({}),
    );

    expect(outcome).toEqual(
      ok({
        written: [
          { index: 0, fileName: 'А.pdf' },
          { index: 2, fileName: 'Б (2).pdf' },
        ],
        failed: [
          {
            index: 1,
            fileName: 'Б.pdf',
            error: { code: 'pageUnavailable', details: { reason: 'lost' } },
          },
        ],
      }),
    );
  });

  it('сбой записи одного файла — остальные записаны, отчёт называет неудавшийся', async () => {
    const folder = await folderWith();
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (call.op === 'rename' && call.to?.endsWith('Третий.pdf') === true) {
        throw fsError('EIO');
      }
    });

    const outcome = await writeBatch(
      folder,
      [item(0, 'Первый'), item(1, 'Второй'), item(2, 'Третий'), item(3, 'Четвёртый')],
      ioOf({ fs, retry: { ceilingMs: 0 } }),
    );

    expect(outcome).toEqual(
      ok({
        written: [
          { index: 0, fileName: 'Первый.pdf' },
          { index: 1, fileName: 'Второй.pdf' },
          { index: 3, fileName: 'Четвёртый.pdf' },
        ],
        failed: [
          {
            index: 2,
            fileName: 'Третий.pdf',
            error: { code: 'saveWriteFailed', details: { reason: 'EIO' } },
          },
        ],
      }),
    );
    // Временные файлы не остаются.
    expect((await readdir(folder)).sort()).toEqual(['Второй.pdf', 'Первый.pdf', 'Четвёртый.pdf']);
  });

  it('нет места — storageFull у файла, а не общий отказ', async () => {
    const folder = await folderWith();
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (call.op === 'write') {
        throw fsError('ENOSPC');
      }
    });

    const outcome = await writeBatch(folder, [item(0, 'А')], ioOf({ fs }));

    expect(outcome).toEqual(
      ok({
        written: [],
        failed: [{ index: 0, fileName: 'А.pdf', error: { code: 'storageFull' } }],
      }),
    );
  });

  it('файл появился, пока собирался PDF, — не перезаписан, имя сдвинулось', async () => {
    const folder = await folderWith();
    const racing = async (): Promise<Result<Uint8Array>> => {
      await writeFile(join(folder, 'Акт.pdf'), 'появился только что');
      return ok(bytesOf('наш'));
    };

    const outcome = await writeBatch(folder, [item(0, 'Акт', racing)], ioOf({}));

    expect(outcome).toEqual(ok({ written: [{ index: 0, fileName: 'Акт (2).pdf' }], failed: [] }));
    expect(await readFile(join(folder, 'Акт.pdf'), 'utf8')).toBe('появился только что');
  });

  it('папка не читается — отказ всего пакета, ни один документ не собирается', async () => {
    let built = 0;
    const counted = () => {
      built += 1;
      return Promise.resolve(ok(bytesOf('pdf')));
    };

    const outcome = await writeBatch(
      join(await makeTempDataRoot(), 'нет такой'),
      [item(0, 'А', counted)],
      ioOf({}),
    );

    expect(outcome).toEqual(fail('saveWriteFailed', { reason: 'ENOENT' }));
    expect(built).toBe(0);
  });

  it('занятость не узнать (сбой stat) — документ не записан, остальные записаны', async () => {
    const folder = await folderWith();
    const { fs } = interceptFs(realStorageFs, (call) => {
      if (call.op === 'size' && call.path.endsWith('Акт.pdf')) {
        throw fsError('EACCES');
      }
    });

    const outcome = await writeBatch(folder, [item(0, 'Акт'), item(1, 'Счёт')], ioOf({ fs }));

    expect(outcome).toEqual(
      ok({
        written: [{ index: 1, fileName: 'Счёт.pdf' }],
        failed: [
          {
            index: 0,
            fileName: 'Акт.pdf',
            error: { code: 'saveWriteFailed', details: { reason: 'EACCES' } },
          },
        ],
      }),
    );
    expect(await readdir(folder)).toEqual(['Счёт.pdf']);
  });

  it('несколько файлов появились во время сборки — имя сдвигается дальше, чужие целы', async () => {
    const folder = await folderWith();
    const racing = async (): Promise<Result<Uint8Array>> => {
      await writeFile(join(folder, 'Акт.pdf'), 'первый чужой');
      await writeFile(join(folder, 'Акт (2).pdf'), 'второй чужой');
      return ok(bytesOf('наш'));
    };

    const outcome = await writeBatch(folder, [item(0, 'Акт', racing)], ioOf({}));

    expect(outcome).toEqual(ok({ written: [{ index: 0, fileName: 'Акт (3).pdf' }], failed: [] }));
    expect(await readFile(join(folder, 'Акт.pdf'), 'utf8')).toBe('первый чужой');
    expect(await readFile(join(folder, 'Акт (2).pdf'), 'utf8')).toBe('второй чужой');
  });

  it('исключение сборки — сбой этого документа, пакет идёт дальше', async () => {
    const folder = await folderWith();
    const throwing = (): Promise<Result<Uint8Array>> => Promise.reject(new Error('pdf-lib упал'));

    const outcome = await writeBatch(folder, [item(0, 'А', throwing), item(1, 'Б')], ioOf({}));

    expect(outcome).toEqual(
      ok({
        written: [{ index: 1, fileName: 'Б.pdf' }],
        failed: [
          {
            index: 0,
            fileName: 'А.pdf',
            error: { code: 'saveWriteFailed', details: { reason: 'UNKNOWN' } },
          },
        ],
      }),
    );
  });
});
