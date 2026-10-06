import type { DomainError, SaveDocumentsReport } from '@shared';

// Итог пакета в модалке `save` (план M3, U9; handoff M3, S16): имена, которые уходят в пакет, и
// что ядро с ними сделало. Санитизацию и суффиксы считает ядро (KTD-11); здесь — только
// сравнение запрошенного с фактическим, чтобы ИТОГ назвал причину.

/** Пометка записанного файла: занято — « (N)», иначе имя поправила санитизация. */
export type FileNote = 'renamed' | 'changed';

export interface ResultRow {
  /** Номер документа в пакете, с нуля. */
  readonly index: number;
  readonly fileName: string;
  /** Только у записанных; `null` — имя как просили. */
  readonly note: FileNote | null;
  /** Только у неудавшихся. */
  readonly error: DomainError | null;
}

const PDF = '.pdf';
const SUFFIX = / \(\d+\)$/u;

export function fileNoteOf(requested: string, actual: string): FileNote | null {
  const base = actual.endsWith(PDF) ? actual.slice(0, -PDF.length) : actual;
  if (base === requested) {
    return null;
  }
  return base.replace(SUFFIX, '') === requested ? 'renamed' : 'changed';
}

/** Набранное расширение: ядро его снимает (KTD-11), здесь — чтобы имя не считалось изменённым. */
const TYPED_PDF = /\.pdf$/iu;

/** Имя строки модалки: края обрезаются, набранное «.pdf» снимается; пустое — по умолчанию. */
export function requestedNames(
  rows: readonly { readonly value: string; readonly placeholder: string }[],
): string[] {
  return rows.map((row) => row.value.trim().replace(TYPED_PDF, '').trimEnd() || row.placeholder);
}

/** Всё записано под запрошенными именами — модалка закрывается сразу (handoff M3, S16). */
export function asRequested(report: SaveDocumentsReport, requested: readonly string[]): boolean {
  return (
    report.failed.length === 0 &&
    report.written.every((file) => fileNoteOf(requested[file.index] ?? '', file.fileName) === null)
  );
}

/** Строки ИТОГА по номеру документа: записанные — с пометкой, неудавшиеся — с ошибкой. */
export function resultRows(report: SaveDocumentsReport, requested: readonly string[]): ResultRow[] {
  const written = report.written.map((file) => ({
    index: file.index,
    fileName: file.fileName,
    note: fileNoteOf(requested[file.index] ?? '', file.fileName),
    error: null,
  }));
  const failed = report.failed.map((file) => ({
    index: file.index,
    fileName: file.fileName,
    note: null,
    error: file.error,
  }));
  return [...written, ...failed].sort((left, right) => left.index - right.index);
}
