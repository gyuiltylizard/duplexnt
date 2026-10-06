import { join } from 'node:path';
import { ok, type FailedFile, type Result, type SavedFile } from '@shared';
import { writeFileAtomic } from '../storage/atomic-file';
import { isMissing, saveFailure, type StorageIo } from '../storage/storage-fs';

// Пакетная запись PDF в папку (план M3, U4; KTD-5, KTD-11). Имена приходят из модалки и
// приводятся к правилам NTFS; занятое имя получает суффикс « (2)», « (3)» — существующий файл не
// перезаписывается никогда. Пакет best-effort: сбой одного файла не прерывает остальные (R12).
//
// Документы собираются и пишутся по одному: в памяти не больше одного PDF (риск памяти плана).
// Перед записью имя проверяется ещё раз: файл мог появиться, пока собирался PDF. Окно между
// этой проверкой и переименованием остаётся — переименование на Windows перезаписывает цель, а
// жёстких ссылок на FAT32 флешке нет; окно — миллисекунды против другой программы с тем же
// именем, это принято.

/** Предел основы имени в графемах: с суффиксом « (99).pdf» путь остаётся разумным. */
export const MAX_FILE_BASE_LENGTH = 150;

const PDF_EXTENSION = '.pdf';
// Запрещённые в именах Windows символы и управляющие коды.
// eslint-disable-next-line no-control-regex -- управляющие коды запрещены в именах NTFS
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;
// Зарезервированные устройства: имя запрещено с любым расширением («CON.pdf» — тоже).
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/;

const trimEnd = (value: string): string => value.trim().replace(TRAILING_DOTS_AND_SPACES, '');

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Видимые символы строки: то, что человек считает одним знаком. */
export const graphemesOf = (value: string): string[] =>
  Array.from(SEGMENTER.segment(value), (part) => part.segment);

/**
 * Основа имени файла по правилам Windows (KTD-11): запрещённые символы → «_», без хвостовых
 * точек и пробелов, без лишнего «.pdf», не длиннее предела, не имя устройства. Пустое — «_».
 */
export function sanitizeFileBase(name: string): string {
  let base = trimEnd(name.replace(FORBIDDEN, '_'));
  if (base.toLowerCase().endsWith(PDF_EXTENSION)) {
    base = trimEnd(base.slice(0, -PDF_EXTENSION.length));
  }
  // Длина — в графемах: ни суррогатная пара, ни составной эмодзи не режутся пополам.
  base = trimEnd(graphemesOf(base).slice(0, MAX_FILE_BASE_LENGTH).join(''));
  if (base === '') {
    return '_';
  }
  const [stem = '', ...rest] = base.split('.');
  return RESERVED.test(stem.trim()) ? [`${stem}_`, ...rest].join('.') : base;
}

/** Ключ сравнения имён: NTFS не различает регистр. */
const nameKey = (fileName: string): string => fileName.toLowerCase();

/** Первое свободное имя: «основа.pdf», затем «основа (2).pdf», «основа (3).pdf»… */
export function pickFileName(base: string, taken: ReadonlySet<string>): string {
  for (let attempt = 1; ; attempt += 1) {
    const fileName =
      attempt === 1 ? `${base}${PDF_EXTENSION}` : `${base} (${attempt})${PDF_EXTENSION}`;
    if (!taken.has(nameKey(fileName))) {
      return fileName;
    }
  }
}

export interface BatchItem {
  /** Номер документа в пакете, с нуля. */
  readonly index: number;
  /** Имя из модалки, как ввёл пользователь. */
  readonly name: string;
  /** Сборка PDF документа: только когда до него дошла очередь. */
  readonly build: () => Promise<Result<Uint8Array>>;
}

interface BatchOutcome {
  readonly written: readonly SavedFile[];
  readonly failed: readonly FailedFile[];
}

/**
 * Пишет документы в папку по одному. Папка не читается — отказ всего пакета: ни один файл не
 * записан. Дальше каждый документ — сам по себе: его сбой попадает в отчёт, остальные пишутся.
 */
export async function writeBatch(
  folder: string,
  items: readonly BatchItem[],
  io: StorageIo,
): Promise<Result<BatchOutcome>> {
  let existing: string[];
  try {
    existing = await io.fs.readdir(folder);
  } catch (error) {
    return { ok: false, error: saveFailure(error) };
  }
  const taken = new Set(existing.map(nameKey));
  const written: SavedFile[] = [];
  const failed: FailedFile[] = [];

  for (const item of items) {
    const base = sanitizeFileBase(item.name);
    let fileName = pickFileName(base, taken);
    // Имя занято и за неудавшимся документом: повтор и сводка называют его тем же именем.
    taken.add(nameKey(fileName));
    const pdf = await item.build();
    if (!pdf.ok) {
      failed.push({ index: item.index, fileName, error: pdf.error });
      continue;
    }

    // Файл мог появиться, пока собирался PDF: чужое не перезаписывается.
    let free: Result<boolean> = await isFree(join(folder, fileName), io);
    while (free.ok && !free.value) {
      fileName = pickFileName(base, taken);
      taken.add(nameKey(fileName));
      free = await isFree(join(folder, fileName), io);
    }
    if (!free.ok) {
      failed.push({ index: item.index, fileName, error: free.error });
      continue;
    }

    try {
      await writeFileAtomic(join(folder, fileName), pdf.value, io);
      written.push({ index: item.index, fileName });
    } catch (error) {
      failed.push({ index: item.index, fileName, error: saveFailure(error) });
    }
  }
  return ok({ written, failed });
}

/** Свободно ли имя; не удалось узнать — отказ, а не догадка «свободно». */
async function isFree(path: string, io: StorageIo): Promise<Result<boolean>> {
  try {
    await io.fs.size(path);
    return ok(false);
  } catch (error) {
    return isMissing(error) ? ok(true) : { ok: false, error: saveFailure(error) };
  }
}
