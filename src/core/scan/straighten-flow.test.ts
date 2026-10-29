import { describe, expect, it } from 'vitest';
import { NO_STRAIGHTEN, NO_STRAIGHTEN_MARK, type AssembledPage, type SkewVerdicts } from '@shared';
import {
  addedOf,
  keyOf,
  pagesOf,
  passOf,
  sessionOf,
  setBacksOf,
} from '../../../test/support/assembly';
import type { StraightenedFile } from '../storage/straightened';
import {
  pagesToMeasure,
  straightenFactsOf,
  straightenProgressOf,
  straightenRefusal,
  straightSnapshotOf,
  type StraightenQueueState,
} from './straighten-flow';

// Какие страницы измеряет детектор перекоса (M6, U5; R6): все проходы в режиме «выравнивать»,
// без потерянных; обороты при оцениваемой пустоте — только с вердиктом «не пусто» или пометкой
// «не пустая». Факты для статусов, ход, гард записи и снимок выправленных на сохранение (U12;
// KTD-8, KTD-9) — чистые функции здесь же. Проводка в службе — `pass-service.straighten.test.ts`.

const keys = (pages: ReturnType<typeof pagesToMeasure>): string[] => pages.map((page) => page.key);

describe('выравнивание: страницы под измерение', () => {
  const session = sessionOf(
    [
      passOf(1, 2, { pages: pagesOf(1, 2, [2]) }),
      passOf(2, 3),
      addedOf(3, 1, null),
      setBacksOf(4, 2, 1),
    ],
    { blankMode: 'hide', straighten: 'auto' },
  );
  const verdicts = new Map([
    [keyOf(2, 1), false],
    [keyOf(2, 2), true],
    [keyOf(4, 1), false],
  ]);

  it('лица и односторонние — всегда; обороты — по вердикту «не пусто»; без вердикта — ждут; потерянные — нет', () => {
    expect(keys(pagesToMeasure(session, verdicts))).toEqual([
      keyOf(1, 1),
      keyOf(2, 1),
      keyOf(3, 1),
      keyOf(4, 1),
    ]);
  });

  it('пометка «не пустая» возвращает оборот под измерение — и без вердикта, и при «пусто»', () => {
    const marked = {
      ...session,
      edits: { ...session.edits, notBlank: [keyOf(2, 2), keyOf(2, 3)] },
    };
    expect(keys(pagesToMeasure(marked, verdicts))).toEqual([
      keyOf(1, 1),
      keyOf(2, 1),
      keyOf(2, 2),
      keyOf(2, 3),
      keyOf(3, 1),
      keyOf(4, 1),
    ]);
  });

  it('при «Оставлять» пустоты обороты измеряются все: вердиктов нет', () => {
    expect(keys(pagesToMeasure({ ...session, blankMode: 'keep' }, new Map()))).toEqual([
      keyOf(1, 1),
      keyOf(2, 1),
      keyOf(2, 2),
      keyOf(2, 3),
      keyOf(3, 1),
      keyOf(4, 1),
    ]);
  });

  it('режим «не выравнивать» и отсутствие сессии — никого', () => {
    expect(pagesToMeasure({ ...session, straighten: 'off' }, verdicts)).toEqual([]);
    expect(pagesToMeasure(null, verdicts)).toEqual([]);
  });
});

const PROFILE = { kind: 'knots' as const, us: [0.5], thetas: [0.4] };

const fileOf = (key: string, version = 1, bytes = 100): StraightenedFile => ({
  path: `/derived/straight/${key}.v${String(version)}.jpg`,
  version,
  bytes,
  encoding: 'jpeg-q92-444',
  dpi: 300,
});

const queueOf = (overrides: Partial<StraightenQueueState> = {}): StraightenQueueState => ({
  queued: [],
  running: null,
  deferred: new Map(),
  ...overrides,
});

describe('выравнивание: факты для статусов и ход (KTD-9)', () => {
  const session = sessionOf([passOf(1, 3)], { straighten: 'auto' });
  const verdicts: SkewVerdicts = new Map([
    [keyOf(1, 1), { outcome: 'willStraighten', profile: PROFILE }],
    [keyOf(1, 2), { outcome: 'level', profile: PROFILE }],
  ]);
  const files = new Map([[keyOf(1, 1), fileOf(keyOf(1, 1))]]);
  const straightened = { resolve: (key: string) => files.get(key) ?? null };

  it('факт — у страниц с исходом, файлом или отсрочкой; без всего — ключа нет; режим off — пусто', () => {
    const queue = queueOf({ deferred: new Map([[keyOf(1, 3), 'noSpace']]) });
    expect(straightenFactsOf(session, verdicts, straightened, queue)).toEqual(
      new Map([
        [keyOf(1, 1), { outcome: 'willStraighten', version: 1, deferred: null }],
        [keyOf(1, 2), { outcome: 'level', version: null, deferred: null }],
        [keyOf(1, 3), { outcome: null, version: null, deferred: 'noSpace' }],
      ]),
    );
    expect(straightenFactsOf(session, new Map(), { resolve: () => null }, queueOf()).size).toBe(0);
    expect(
      straightenFactsOf({ ...session, straighten: 'off' }, verdicts, straightened, queue).size,
    ).toBe(0);
    expect(straightenFactsOf(null, verdicts, straightened, queue).size).toBe(0);
  });

  it('ход: очередь с исполняемой; вне режима «выравнивать» — null', () => {
    const queue = queueOf({ queued: [keyOf(1, 1), keyOf(1, 2)], running: keyOf(1, 1) });
    expect(straightenProgressOf(session, queue)).toEqual({ queued: 2, running: keyOf(1, 1) });
    expect(straightenProgressOf({ ...session, straighten: 'off' }, queue)).toBeNull();
    expect(straightenProgressOf(null, queue)).toBeNull();
  });

  it('гард записи: ждущие — отказ с числом; отложенные не держат', () => {
    expect(straightenRefusal({ ...NO_STRAIGHTEN, mode: 'auto', pending: 2, deferred: 1 })).toEqual({
      ok: false,
      error: { code: 'sessionConflict', details: { pending: 2, reason: 'straightenPending' } },
    });
    expect(straightenRefusal({ ...NO_STRAIGHTEN, mode: 'auto', deferred: 3, total: 3 })).toBeNull();
    expect(straightenRefusal(NO_STRAIGHTEN)).toBeNull();
  });
});

describe('выравнивание: снимок выправленных на сохранение (KTD-8)', () => {
  const pageOf = (key: string, status: AssembledPage['straighten']['status']): AssembledPage => ({
    key,
    side: 'front',
    sheet: null,
    angle: 0,
    lost: false,
    addedSet: null,
    blank: null,
    straighten: status === null ? NO_STRAIGHTEN_MARK : { status, reason: null, version: 1 },
  });
  const K1 = keyOf(1, 1);
  const K2 = keyOf(1, 2);
  const K3 = keyOf(1, 3);

  it('в снимок идут только «выправлена»: откаченная и ждущая — нет; дайджест не зависит от порядка', () => {
    const files = new Map([
      [K1, fileOf(K1)],
      [K2, fileOf(K2)],
      [K3, fileOf(K3)],
    ]);
    const straightened = { resolve: (key: string) => files.get(key) ?? null };
    const pages = [pageOf(K1, 'straightened'), pageOf(K2, 'kept'), pageOf(K3, 'straightened')];

    const { snapshot, digest } = straightSnapshotOf(pages, straightened);
    expect([...snapshot.keys()]).toEqual([K1, K3]);
    expect(snapshot.get(K1)).toEqual(fileOf(K1));
    expect(straightSnapshotOf([...pages].reverse(), straightened).digest).toBe(digest);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('дайджест меняется от набора ключей, версии и размера файла; без выправленных — свой, постоянный', () => {
    const base = new Map([[K1, fileOf(K1)]]);
    const digestOf = (files: Map<string, StraightenedFile>, pages = [pageOf(K1, 'straightened')]) =>
      straightSnapshotOf(pages, { resolve: (key) => files.get(key) ?? null }).digest;
    const reference = digestOf(base);

    expect(digestOf(new Map([[K1, fileOf(K1, 2)]]))).not.toBe(reference);
    expect(digestOf(new Map([[K1, fileOf(K1, 1, 101)]]))).not.toBe(reference);
    expect(
      digestOf(new Map([...base, [K2, fileOf(K2)]]), [
        pageOf(K1, 'straightened'),
        pageOf(K2, 'straightened'),
      ]),
    ).not.toBe(reference);
    // Статус без записи (гонка со сбросом) — страницы в снимке нет.
    expect(digestOf(new Map(), [pageOf(K1, 'straightened')])).toBe(digestOf(new Map(), []));
  });
});
