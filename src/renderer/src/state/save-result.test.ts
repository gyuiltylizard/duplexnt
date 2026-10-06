import { describe, expect, it } from 'vitest';
import type { SaveDocumentsReport } from '@shared';
import { asRequested, fileNoteOf, requestedNames, resultRows } from './save-result';

// Итог пакета в модалке `save` (план M3, U9; handoff M3, S16): какие имена ядро изменило и
// можно ли закрыть модалку сразу.

describe('пометка у записанного файла', () => {
  it.each([
    ['как просили', 'Акт', 'Акт.pdf', null],
    ['занято — добавлен номер', 'Акт', 'Акт (2).pdf', 'renamed'],
    ['номер двузначный', 'Акт', 'Акт (12).pdf', 'renamed'],
    ['санитизация', 'Акт: черновик', 'Акт_ черновик.pdf', 'changed'],
    ['санитизация и номер', 'Акт?', 'Акт_ (2).pdf', 'changed'],
    ['регистр — тоже изменение', 'акт', 'Акт.pdf', 'changed'],
    ['своё «(2)» в имени не путается с номером', 'Акт (2)', 'Акт (2).pdf', null],
  ] as const)('%s', (_name, requested, actual, expected) => {
    expect(fileNoteOf(requested, actual)).toBe(expected);
  });
});

describe('имена, которые уходят в пакет', () => {
  it('пустое и из пробелов — по умолчанию; края обрезаются', () => {
    expect(
      requestedNames([
        { value: '', placeholder: 'Документ 1' },
        { value: '   ', placeholder: 'Документ 2' },
        { value: '  Опись ', placeholder: 'Документ 3' },
      ]),
    ).toEqual(['Документ 1', 'Документ 2', 'Опись']);
  });
});

const report = (change: Partial<SaveDocumentsReport>): SaveDocumentsReport => ({
  folder: 'C:\\Сканы',
  written: [],
  failed: [],
  ...change,
});

describe('модалку можно закрыть сразу', () => {
  it('всё записано под запрошенными именами', () => {
    const done = report({
      written: [
        { index: 0, fileName: 'Акт.pdf' },
        { index: 1, fileName: 'Опись.pdf' },
      ],
    });

    expect(asRequested(done, ['Акт', 'Опись'])).toBe(true);
  });

  it('имя изменено ядром — нет: фактические имена надо показать', () => {
    const renamed = report({ written: [{ index: 0, fileName: 'Акт (2).pdf' }] });

    expect(asRequested(renamed, ['Акт'])).toBe(false);
  });

  it('есть неудавшиеся — нет', () => {
    const partial = report({
      written: [{ index: 0, fileName: 'Акт.pdf' }],
      failed: [{ index: 1, fileName: 'Опись.pdf', error: { code: 'saveWriteFailed' } }],
    });

    expect(asRequested(partial, ['Акт', 'Опись'])).toBe(false);
  });
});

describe('строки итога', () => {
  it('записанные и неудавшиеся — по номеру документа, с пометками', () => {
    const partial = report({
      written: [
        { index: 2, fileName: 'Документ 3.pdf' },
        { index: 0, fileName: 'Акт (2).pdf' },
      ],
      failed: [{ index: 1, fileName: 'Опись.pdf', error: { code: 'saveWriteFailed' } }],
    });

    expect(resultRows(partial, ['Акт', 'Опись', 'Документ 3'])).toEqual([
      { index: 0, fileName: 'Акт (2).pdf', note: 'renamed', error: null },
      { index: 1, fileName: 'Опись.pdf', note: null, error: { code: 'saveWriteFailed' } },
      { index: 2, fileName: 'Документ 3.pdf', note: null, error: null },
    ]);
  });
});
