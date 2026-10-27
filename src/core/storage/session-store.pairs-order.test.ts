import { assert, describe, expect, it } from 'vitest';
import { EMPTY_EDITS, type SessionSnapshot } from '@shared';
import { ok, ORIGIN, setup } from '../../../test/support/session-store';
import { assembleSession } from '../scan/assembly';
import { withRebasedEdits } from './rebase';
import { reconcileSession } from './reconcile';

// Перерасстановка ключей завершённого прохода оборотов в явном порядке (B-13, план
// 2026-10-27-005, U4, KTD-6; ADR 0004, амендмент 2026-10-28): пока проход идёт, его страницы
// встают в `order` подблоком за соседом по `settled`-проекции; по выходу из `running` ядро
// расставляет их заново против итоговой сборки — чередованием. Трогаются только ключи этого
// прохода. Проверяется настоящей цепочкой хранилища: `beginPass` → `acceptPage` → `endSegment`.

const F1 = 'p01-s01-0001';
const F2 = 'p01-s01-0002';
/** Обороты основной пачки подаются обратным порядком: первый — оборот листа 2. */
const B2 = 'p02-s01-0001';
const B1 = 'p02-s01-0002';
const S1F1 = 'p03-s01-0001';
const S1F2 = 'p03-s01-0002';
const S1B2 = 'p04-s01-0001';
const S1B1 = 'p04-s01-0002';
/** Явный порядок после ручной перестановки: второй лист вперёд. */
const SWAPPED = [F2, B2, F1, B1];

const keysOf = (session: SessionSnapshot | null): string[] => {
  assert(session !== null);
  return assembleSession(session).order.map((page) => page.key);
};

/** Основная пачка 2+2 с ручным порядком «второй лист вперёд». */
async function swappedPack() {
  const context = await setup();
  const { store, accept } = context;
  ok(await store.beginPass(ORIGIN, null));
  await accept(1, 2);
  ok(await store.endSegment('completed'));
  ok(await store.beginPass(ORIGIN, null));
  await accept(3, 4);
  ok(await store.endSegment('completed'));
  ok(await store.setEdits({ ...EMPTY_EDITS, order: SWAPPED }, {}));
  expect(keysOf(store.snapshot())).toEqual(SWAPPED);
  return context;
}

/** Лица набора «в конец документа» (после B1) — две страницы, проход завершён. */
async function setFronts(context: Awaited<ReturnType<typeof swappedPack>>): Promise<void> {
  const { store, accept } = context;
  ok(await store.beginPass(ORIGIN, { kind: 'addedFronts', after: B1 }));
  await accept(5, 6);
  ok(await store.endSegment('completed'));
  expect(keysOf(store.snapshot())).toEqual([...SWAPPED, S1F1, S1F2]);
}

describe('перерасстановка оборотов завершённого прохода при явном порядке (B-13, U4)', () => {
  it('обороты набора: пока проход шёл — подблок, после completed — чередование; остальные ключи на местах', async () => {
    const context = await swappedPack();
    const { store, accept, journalOnDisk } = context;
    await setFronts(context);

    ok(await store.beginPass(ORIGIN, null));
    await accept(7, 8);
    // Идущий проход: обороты за лицами подблоком (ревью M3.6, #1 — решение на время прохода).
    expect(keysOf(store.snapshot())).toEqual([...SWAPPED, S1F1, S1F2, S1B1, S1B2]);

    ok(await store.endSegment('completed'));
    const expected = [...SWAPPED, S1F1, S1B1, S1F2, S1B2];
    expect(keysOf(store.snapshot())).toEqual(expected);
    expect((await journalOnDisk()).edits.order).toEqual(expected);
  });

  it('основная пачка: лица переставлены до оборотов — после completed обороты у своих лиц (характеризация)', async () => {
    const { store, accept } = await setup();
    ok(await store.beginPass(ORIGIN, null));
    await accept(1, 2);
    ok(await store.endSegment('completed'));
    ok(await store.setEdits({ ...EMPTY_EDITS, order: [F2, F1] }, {}));

    ok(await store.beginPass(ORIGIN, null));
    await accept(3, 4);
    ok(await store.endSegment('completed'));
    expect(keysOf(store.snapshot())).toEqual([F2, B2, F1, B1]);
  });

  it('проход лиц набора: завершение порядок не трогает', async () => {
    const context = await swappedPack();
    const { store, journalOnDisk } = context;
    await setFronts(context);
    expect((await journalOnDisk()).edits.order).toEqual([...SWAPPED, S1F1, S1F2]);
    expect(store.snapshot()?.edits.order).toEqual([...SWAPPED, S1F1, S1F2]);
  });

  it('«Остановить» на единственном сегменте оборотов: проход исчез — без ошибки, мёртвых ключей в порядке нет', async () => {
    const context = await swappedPack();
    const { store, accept } = context;
    await setFronts(context);

    ok(await store.beginPass(ORIGIN, null));
    await accept(7, 7);
    ok(await store.discardSegment());
    expect(store.snapshot()?.passes.map((pass) => pass.number)).toEqual([1, 2, 3]);
    expect(store.snapshot()?.edits.order).toEqual([...SWAPPED, S1F1, S1F2]);
  });

  it('прерванный проход оборотов: перестановка при interrupted, ручной перенос в прерванном состоянии не сохраняется после completed (оговорка KTD-6)', async () => {
    const context = await swappedPack();
    const { store, accept } = context;
    await setFronts(context);

    ok(await store.beginPass(ORIGIN, null));
    await accept(7, 7);
    ok(await store.endSegment('interrupted'));
    // Один оборот из двух: сборка — подблоки, оборот за лицами.
    expect(keysOf(store.snapshot())).toEqual([...SWAPPED, S1F1, S1F2, S1B2]);

    // Ручной перенос пришедшего оборота в начало ленты.
    ok(await store.setEdits({ ...EMPTY_EDITS, order: [S1B2, ...SWAPPED, S1F1, S1F2] }, {}));
    expect(keysOf(store.snapshot())).toEqual([S1B2, ...SWAPPED, S1F1, S1F2]);

    ok(await store.resumePass());
    await accept(8, 8);
    ok(await store.endSegment('completed'));
    // Все обороты прохода — чередованием (докачанный — второй сегмент); перенос S1B2 руками не
    // сохранён.
    expect(keysOf(store.snapshot())).toEqual([...SWAPPED, S1F1, 'p04-s02-0001', S1F2, S1B2]);
  });

  it('сверка после сбоя посреди оборотов набора: перестановка один раз, повтор ничего не меняет', async () => {
    const context = await swappedPack();
    const { store, accept, root, journalOnDisk } = context;
    await setFronts(context);

    ok(await store.beginPass(ORIGIN, null));
    await accept(7, 8);
    // Сбой: сегмент на диске остаётся `running`.
    expect((await journalOnDisk()).passes.at(-1)?.segments.at(-1)?.state).toBe('running');

    await reconcileSession(root, { retry: { ceilingMs: 0 } });
    const adopted = await journalOnDisk();
    expect(adopted.passes.at(-1)?.segments.at(-1)?.state).toBe('interrupted');
    const expected = [...SWAPPED, S1F1, S1B1, S1F2, S1B2];
    expect(adopted.edits.order).toEqual(expected);

    await reconcileSession(root, { retry: { ceilingMs: 0 } });
    expect((await journalOnDisk()).edits.order).toEqual(expected);
    // Повтор перебазирования над тем же журналом и перебазирование без «до» — идемпотентны.
    expect(withRebasedEdits(adopted, adopted).edits).toEqual(adopted.edits);
    expect(withRebasedEdits(null, adopted).edits).toEqual(adopted.edits);
  });
});
