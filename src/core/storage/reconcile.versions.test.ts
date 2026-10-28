import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS } from '@shared';
import { dirSnapshot } from '../../../test/support/dir-snapshot';
import {
  journalOnDisk,
  journalV1Of,
  journalV2Of,
  journalV3Of,
  journalV4Of,
  journalV6Of,
  journalV7Of,
  omit,
  pageName,
  pagesOfFirstSegment,
  pass,
  reconciled,
  seed,
  segment,
} from '../../../test/support/reconcile';
import { rolesOf } from '../../../test/support/session-store';
import { JOURNAL_VERSION } from './journal';
import { isSetAsideName } from './versioned-file';

// Журналы прежних версий при сверке (M2 R13; M3 R2; M3.5 R1; M3.6 R1; M4 R8; M6 R15; ADR 0004):
// каждый читается цепочкой дефолтов и переписывается текущей версией; повторная сверка ничего
// не меняет. Выделено из `reconcile.test.ts` по правилу размера тестового файла; сборщики
// версий — test/support/reconcile.ts.

describe('сверка при запуске: журналы прежних версий', () => {
  it('журнал версии 1 читается и переписывается текущей версией; флаги — дефолты (M2, R13)', async () => {
    const { root, layout } = await seed(
      journalV1Of([pass(1, [segment(1, 'completed', 2)])]),
      pagesOfFirstSegment(2),
    );

    const { session, notices } = await reconciled(root);

    expect(notices).toEqual([]);
    expect(session).toMatchObject({ backsDeclined: false, saved: false });
    expect(session?.passes[0]).toMatchObject({ rotate180: false, kind: 'fronts', after: null });
    const journal = await journalOnDisk(layout);
    expect(journal.version).toBe(JOURNAL_VERSION);
    expect(journal).toMatchObject({
      backsDeclined: false,
      saved: false,
      edits: EMPTY_EDITS,
      assembled: null,
    });
    expect(journal.passes[0]).toMatchObject({ rotate180: false, kind: 'fronts', after: null });

    // Повторный прогон уже ничего не меняет: сверка идемпотентна.
    const before = await dirSnapshot(root);
    await reconciled(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('журнал версии 2 переписывается текущей версией: правок нет, флаги целы (M3, R2)', async () => {
    const { root, layout } = await seed(
      journalV2Of([pass(1, [segment(1, 'completed', 2)])], { saved: true }),
      pagesOfFirstSegment(2),
    );

    const { session } = await reconciled(root);

    expect(session).toMatchObject({ saved: true, edits: EMPTY_EDITS });
    const journal = await journalOnDisk(layout);
    expect(journal).toMatchObject({ version: JOURNAL_VERSION, saved: true, edits: EMPTY_EDITS });

    const before = await dirSnapshot(root);
    await reconciled(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('журнал версии 4 переписывается текущей версией: сборки нет, граница авто (M3.6, R1)', async () => {
    const { root, layout } = await seed(
      journalV4Of([pass(1, [segment(1, 'completed', 2)])], { saved: true }),
      pagesOfFirstSegment(2),
    );

    const { session } = await reconciled(root);

    expect(session).toMatchObject({ saved: true, edits: EMPTY_EDITS, assembled: null });
    const journal = await journalOnDisk(layout);
    expect(journal).toMatchObject({
      version: JOURNAL_VERSION,
      saved: true,
      edits: EMPTY_EDITS,
      assembled: null,
    });

    const before = await dirSnapshot(root);
    await reconciled(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });

  it('журнал версии 3 переписывается текущей версией: роль — по позиции, якоря `null`, флаг поворота цел (M3.5, R1)', async () => {
    const { root, layout } = await seed(
      journalV3Of([
        pass(1, [segment(1, 'completed', 2)]),
        pass(2, [segment(1, 'completed', 2)], { rotate180: true }),
        pass(3, [segment(1, 'completed', 1)]),
      ]),
      [...pagesOfFirstSegment(2), pageName(2, 1, 1), pageName(2, 1, 2), pageName(3, 1, 1)],
    );

    const { session, notices } = await reconciled(root);

    expect(notices).toEqual([]);
    expect(rolesOf(session?.passes ?? [])).toEqual([
      [1, 'fronts', null],
      [2, 'backs', null],
      [3, 'added', null],
    ]);
    const journal = await journalOnDisk(layout);
    expect(journal.version).toBe(JOURNAL_VERSION);
    expect(rolesOf(journal.passes)).toEqual(rolesOf(session?.passes ?? []));
    expect(journal.passes[1]).toMatchObject({ rotate180: true });

    const before = await dirSnapshot(root);
    await reconciled(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });
});

describe('сверка при запуске: режим пустых оборотов (M4, R8)', () => {
  it('журнал версии 5 переписывается текущей версией: режим «оставлять», пометок нет', async () => {
    const { root, layout } = await seed(
      {
        ...omit(journalV6Of([pass(1, [segment(1, 'completed', 2)])], { saved: true }), 'blankMode'),
        version: 5,
        edits: omit(EMPTY_EDITS, 'notBlank', 'keepOriginal'),
      },
      pagesOfFirstSegment(2),
    );

    const { session, notices } = await reconciled(root);

    expect(notices).toEqual([]);
    expect(session).toMatchObject({ saved: true, blankMode: 'keep', edits: EMPTY_EDITS });
    const journal = await journalOnDisk(layout);
    expect(journal).toMatchObject({
      version: JOURNAL_VERSION,
      blankMode: 'keep',
      edits: EMPTY_EDITS,
    });

    const before = await dirSnapshot(root);
    await reconciled(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });
});

describe('сверка при запуске: режим выравнивания (M6, R15; ADR 0004, амендмент 2026-10-28)', () => {
  it('журнал версии 7 переписывается текущей версией без копии: режим «не выравнивать», откатов нет', async () => {
    const { root, layout } = await seed(
      journalV7Of([pass(1, [segment(1, 'completed', 2)])], { saved: true }),
      pagesOfFirstSegment(2),
    );

    const { session, notices } = await reconciled(root);

    expect(notices).toEqual([]);
    expect(session).toMatchObject({ saved: true, straighten: 'off', edits: EMPTY_EDITS });
    const journal = await journalOnDisk(layout);
    expect(journal).toMatchObject({
      version: JOURNAL_VERSION,
      straighten: 'off',
      edits: EMPTY_EDITS,
    });
    expect(
      (await readdir(layout.sessionDir)).filter((name) => isSetAsideName(name, 'session.json')),
    ).toEqual([]);

    const before = await dirSnapshot(root);
    await reconciled(root);
    expect(await dirSnapshot(root)).toEqual(before);
  });
});
