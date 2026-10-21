import { EMPTY_EDITS, type SessionEdits } from '@shared';
import { describe, expect, it } from 'vitest';
import { fsError } from '../../../test/support/intercept-fs';
import { isJournalRename, ok, ORIGIN, setup } from '../../../test/support/session-store';

// Команда «Собрать документ» (план M3.6, U3; R12, R13; KTD5): гарды по порядку R13, запись
// сборки одним атомарным коммитом, повороты и удаления целы, порядок и граница обнуляются.

const F = (index: number): string => `p01-s01-${String(index).padStart(4, '0')}`;
const B = (index: number): string => `p02-s01-${String(index).padStart(4, '0')}`;
const A = (pass: number, index: number): string =>
  `p${String(pass).padStart(2, '0')}-s01-${String(index).padStart(4, '0')}`;

describe('хранилище сессии: «Собрать документ» (M3.6, U3)', () => {
  /** Лица 1–3, обороты 1–2 (подачей B1 B2): раздельные наборы 3/2. */
  async function mismatched(before?: Parameters<typeof setup>[0]) {
    const context = await setup(before);
    const { store, accept } = context;
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 3);
    ok(await store.endSegment('completed'));
    ok(await store.beginPass(ORIGIN, null));
    await accept(4, 5);
    ok(await store.endSegment('completed'));
    return context;
  }

  /** 3/2 плюс добавленный набор из одной страницы за оборотом B2 — наборы уравнены 3/3. */
  async function equalized(before?: Parameters<typeof setup>[0]) {
    const context = await mismatched(before);
    const { store, accept } = context;
    ok(await store.beginPass(ORIGIN, { kind: 'added', after: B(2) }));
    await accept(6, 6);
    ok(await store.endSegment('completed'));
    return context;
  }

  it('AE4: наборы уравнены → запись сборки по чередованию групп; порядок и граница обнулены, повороты и удаления целы, «сохранено» снято', async () => {
    const { store, journalOnDisk } = await equalized();
    const edits: SessionEdits = {
      ...EMPTY_EDITS,
      rotations: { [F(2)]: 90 },
      deleted: [F(3), B(1)],
      order: [F(2), F(1)],
      divider: 2,
    };
    ok(await store.setEdits(edits, true));
    ok(await store.markSaved());
    // Лента: F2 F1 [F3] | B2 A1 [B1] — 2/2; граница 2 равна авто и хранится как null.
    expect(store.snapshot()?.edits.divider).toBeNull();

    expect(await store.assemble()).toEqual({ ok: true, value: undefined });

    // Чередование F2 B2 F1 A1; удалённые — сразу за видимым предшественником: F3 за F1, B1 за A1.
    const expected = {
      assembled: [F(2), B(2), F(1), F(3), A(3, 1), B(1)],
      edits: { ...edits, order: [], divider: null },
      saved: false,
    };
    expect(store.snapshot()).toMatchObject(expected);
    expect(await journalOnDisk()).toMatchObject(expected);
    expect(store.snapshot()?.passes.find((pass) => pass.kind === 'backs')?.rotate180).toBe(true);
  });

  it('повторная сборка — notSeparate: документ уже собран', async () => {
    const { store } = await equalized();
    ok(await store.assemble());

    expect(await store.assemble()).toMatchObject({
      ok: false,
      error: { code: 'sessionConflict', details: { reason: 'notSeparate' } },
    });
  });

  it('режим пар (числа равны) — notSeparate; без сессии — noSession', async () => {
    const { store, accept } = await setup();
    expect(await store.assemble()).toMatchObject({
      ok: false,
      error: { details: { reason: 'noSession' } },
    });

    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    ok(await store.beginPass(ORIGIN, null));
    await accept(3, 4);
    ok(await store.endSegment('completed'));

    expect(await store.assemble()).toMatchObject({
      ok: false,
      error: { details: { reason: 'notSeparate' } },
    });
  });

  it('видимые числа групп не равны — setsUnequal; все страницы удалены (0/0) — тоже', async () => {
    const { store } = await mismatched();
    expect(await store.assemble()).toMatchObject({
      ok: false,
      error: { details: { reason: 'setsUnequal' } },
    });

    ok(await store.setEdits({ ...EMPTY_EDITS, deleted: [F(1), F(2), F(3), B(1), B(2)] }, false));
    expect(await store.assemble()).toMatchObject({
      ok: false,
      error: { details: { reason: 'setsUnequal' } },
    });
  });

  it('уравнять можно и удалением: 3/2 → удалено лицо → 2/2 → сборка', async () => {
    const { store } = await mismatched();
    ok(await store.setEdits({ ...EMPTY_EDITS, deleted: [F(2)] }, false));

    expect(await store.assemble()).toMatchObject({ ok: true });
    // Удалённая F2 — сразу за своим видимым предшественником F1.
    expect(store.snapshot()?.assembled).toEqual([F(1), F(2), B(2), F(3), B(1)]);
  });

  it('идёт проход — passRunning; последний проход прерван — passInterrupted', async () => {
    const { store, accept } = await mismatched();
    ok(await store.beginPass(ORIGIN, { kind: 'added', after: null }));
    expect(await store.assemble()).toMatchObject({
      ok: false,
      error: { details: { reason: 'passRunning' } },
    });

    await accept(6, 6);
    ok(await store.endSegment('interrupted'));
    expect(await store.assemble()).toMatchObject({
      ok: false,
      error: { details: { reason: 'passInterrupted' } },
    });
  });

  it('запись атомарна: журнал на диске — temp → rename; отказ записи не трогает прежний журнал', async () => {
    let failWrites = false;
    const { store, calls, journalOnDisk } = await equalized((call) => {
      if (failWrites && isJournalRename(call)) {
        throw fsError('EPERM');
      }
    });
    const before = await journalOnDisk();
    failWrites = true;

    expect(await store.assemble()).toMatchObject({ ok: false, error: { code: 'storageFailed' } });
    expect(await journalOnDisk()).toEqual(before);
    expect(store.snapshot()?.assembled).toBeNull();

    failWrites = false;
    const renames = calls.filter(isJournalRename).length;
    ok(await store.assemble());
    expect(calls.filter(isJournalRename).length).toBe(renames + 1);
    expect((await journalOnDisk()).assembled).not.toBeNull();
  });
});
