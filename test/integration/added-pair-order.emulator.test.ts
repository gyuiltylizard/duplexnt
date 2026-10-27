import { describe, expect, it } from 'vitest';
import { EMPTY_EDITS, type Snapshot } from '@shared';
import type { ScanJobLimits } from '../../src/core/escl/scan-job';
import type { PassService, PassServiceOptions } from '../../src/core/scan/pass-service';
import { connectService, scanned } from '../support/pass-service';
import { unwrap } from '../support/result';

// B-13, часть 2 — воспроизведение на настоящей цепочке (эмулятор → служба → хранилище →
// сборка): двусторонние добавленные наборы при явном порядке ленты и после «Вернуть». Основная
// пачка 2+2, наборы по два листа с оборотами. Правило «якорь на лице со своим оборотом = после
// листа» живёт в renderer (план 2026-10-27-005, KTD-8) и покрыто тестами `EditorScreen`; служба
// получает готовый ключ хвоста и ставит блок за ним буквально.

const FAST: Partial<ScanJobLimits> = {
  retryDelayMs: 5,
  busyCeilingMs: 200,
  notReadyCeilingMs: 2000,
  pageIdleTimeoutMs: 300,
  pageDeadlineMs: 3000,
  deleteDeadlineMs: 300,
};

const OPTIONS = {
  jobLimits: FAST,
  minFreeBytes: 1,
  retry: { ceilingMs: 0 },
} satisfies PassServiceOptions;

/** Страница `page` прохода `pass`. */
const key = (pass: number, page: number): string => `p0${String(pass)}-s01-000${String(page)}`;

// Основная пачка: лица 1–2, обороты обратным порядком подачи (первый — оборот листа 2).
const F1 = key(1, 1);
const F2 = key(1, 2);
const B1 = key(2, 2);
const B2 = key(2, 1);

/** Блок двустороннего набора из двух листов с чередованием: оборот листа i — страница 2−i оборотов. */
const pairBlock = (fronts: number, backs: number): string[] => [
  key(fronts, 1),
  key(backs, 2),
  key(fronts, 2),
  key(backs, 1),
];

const keysOf = (snapshot: Snapshot): string[] =>
  snapshot.assembly?.order.map((page) => page.key) ?? [];

/** Набор «ДN» с оборотами: лица с якорем, затем обороты без намерения. */
async function addPair(service: PassService, after: string): Promise<void> {
  expect(unwrap(await service.startPass({ kind: 'addedFronts', after }))).toMatchObject({
    end: 'completed',
    pages: 2,
  });
  expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: 2 });
}

/** Основная пачка 2+2 с ручным порядком «второй лист вперёд» — порядок ленты явный. */
async function manualOrder(service: PassService): Promise<string[]> {
  await scanned(service, 2, 2);
  expect(keysOf(service.snapshot())).toEqual([F1, B1, F2, B2]);
  const manual = [F2, B2, F1, B1];
  unwrap(await service.setEdits({ ...EMPTY_EDITS, order: manual }, {}));
  expect(keysOf(service.snapshot())).toEqual(manual);
  return manual;
}

describe('B-13: пары добавленных наборов при явном порядке и после «Вернуть»', () => {
  // Пока проход оборотов идёт, его страницы встают в явный порядок подблоком за лицами; по
  // завершении ядро расставляет их заново чередованием (B-13, U4; `withRebasedEdits`).
  it('набор при явном порядке ленты: обороты чередуются с лицами, а не блоком за ними', async () => {
    const { service } = await connectService(
      {
        trays: [
          [1, 2],
          [4, 3],
          [5, 6],
          [8, 7],
        ],
      },
      OPTIONS,
    );
    const manual = await manualOrder(service);
    // «В конец документа» — якорь последняя страница полной ленты (B1).
    await addPair(service, B1);
    expect(keysOf(service.snapshot())).toEqual([...manual, ...pairBlock(3, 4)]);
  });

  // Характеризация: «Вернуть» сбрасывает ручной порядок, и наборы встают за своими якорями по
  // базовому порядку. Якорь — ключ страницы, а не место в ленте: набор, добавленный «в конец
  // документа» при ручном порядке, после «Вернуть» идёт за той же страницей, где бы она ни
  // оказалась. Блоки пар при этом целы.
  it('два набора подряд, затем «Вернуть»: блоки целы, идут за своими якорями', async () => {
    const { service } = await connectService(
      {
        trays: [
          [1, 2],
          [4, 3],
          [5, 6],
          [8, 7],
          [9, 10],
          [12, 11],
        ],
      },
      OPTIONS,
    );
    await manualOrder(service);
    await addPair(service, B1);
    // Второй набор — «в конец документа»: последняя страница полной ленты после первого набора.
    const last = keysOf(service.snapshot()).at(-1) ?? '';
    expect(last).toBe(key(4, 1));
    await addPair(service, last);

    unwrap(await service.setEdits(EMPTY_EDITS, {}));
    // Якорь Д1 — B1, в базовом порядке вторая страница; Д2 — за последней страницей Д1.
    expect(keysOf(service.snapshot())).toEqual([
      F1,
      B1,
      ...pairBlock(3, 4),
      ...pairBlock(5, 6),
      F2,
      B2,
    ]);
  });

  // Характеризация: якорь — ключ хвоста листа Д1 (его даёт renderer), блок Д2 — после листа.
  // Якорь-лицо поставил бы блок между лицом и его оборотом — картина скриншота автора; это
  // решает renderer, а не ядро (KTD-8).
  it('якорь — хвост листа набора Д1: блок Д2 встаёт после листа', async () => {
    const { service } = await connectService(
      {
        trays: [
          [1, 2],
          [4, 3],
          [5, 6],
          [8, 7],
          [9, 10],
          [12, 11],
        ],
      },
      OPTIONS,
    );
    await scanned(service, 2, 2);
    await addPair(service, B2);
    expect(keysOf(service.snapshot())).toEqual([F1, B1, F2, B2, ...pairBlock(3, 4)]);
    await addPair(service, key(4, 1));
    unwrap(await service.setEdits(EMPTY_EDITS, {}));
    expect(keysOf(service.snapshot())).toEqual([
      F1,
      B1,
      F2,
      B2,
      ...pairBlock(3, 4),
      ...pairBlock(5, 6),
    ]);
  });
});
