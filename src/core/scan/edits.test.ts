import { EMPTY_EDITS, sameEdits, type SessionEdits } from '@shared';
import { describe, expect, it } from 'vitest';
import {
  documentsOf,
  hasEdits,
  normalizeCuts,
  normalizeEdits,
  pageAngle,
  rebaseEdits,
  rebaseOrder,
  remapCuts,
  setsContext,
  TRANSIT_CONTEXT,
  visibleKeysOf,
} from './edits';

// Табличные тесты правок поверх автопорядка (план M3, U2) — обязательная зона тест-политики:
// здесь решается, какие страницы и в каком порядке лягут в документы, и молча потерять или
// задвоить страницу нельзя.

const edits = (extra: Partial<SessionEdits>): SessionEdits => ({ ...EMPTY_EDITS, ...extra });

// Короткие ключи читаются в таблицах лучше настоящих: модулю правок формат ключа безразличен.
const AUTO = ['a', 'b', 'c', 'd', 'e'];

describe('правки: видимая лента', () => {
  it.each([
    ['без правок — автопорядок', edits({}), AUTO],
    [
      'явный порядок целиком',
      edits({ order: ['e', 'd', 'c', 'b', 'a'] }),
      ['e', 'd', 'c', 'b', 'a'],
    ],
    [
      'ключи вне явного порядка — в конце, в автопорядке (R4)',
      edits({ order: ['c', 'a'] }),
      ['c', 'a', 'b', 'd', 'e'],
    ],
    ['удалённые не показываются', edits({ deleted: ['b', 'e'] }), ['a', 'c', 'd']],
    [
      'удалённые не показываются и при явном порядке',
      edits({ order: ['e', 'a', 'b'], deleted: ['a'] }),
      ['e', 'b', 'c', 'd'],
    ],
    [
      'мёртвые ключи и повторы порядка отбрасываются',
      edits({ order: ['x', 'b', 'b', 'a'] }),
      ['b', 'a', 'c', 'd', 'e'],
    ],
  ])('%s', (_name, given, expected) => {
    expect(visibleKeysOf(AUTO, given)).toEqual(expected);
  });

  it('каждая живая страница — ровно один раз: в ленте или среди удалённых (R3)', () => {
    // Детерминированный перебор: порядки, удаления и мусор в разных сочетаниях.
    let seed = 7;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648);
    const pick = (pool: readonly string[]): string[] =>
      pool.filter(() => next() % 3 === 0).sort(() => (next() % 2 === 0 ? -1 : 1));
    const pool = [...AUTO, 'x', 'y'];
    for (let round = 0; round < 200; round += 1) {
      const given = edits({ order: pick([...pool, ...pool]), deleted: pick(pool) });
      const normalized = normalizeEdits(AUTO, given);
      const visible = visibleKeysOf(AUTO, normalized);

      expect(new Set(visible).size).toBe(visible.length);
      expect([...visible, ...normalized.deleted].sort()).toEqual([...AUTO].sort());
    }
  });
});

describe('правки: нормализация разрезов', () => {
  it.each([
    ['канонические не меняются', [2, 4], ['А', 'Б', 'В'], 5, [2, 4], ['А', 'Б', 'В']],
    [
      'разрез перед первой позицией снят вместе с именем пустого',
      [0, 3],
      ['А', 'Б', 'В'],
      5,
      [3],
      ['Б', 'В'],
    ],
    [
      'совпавшие разрезы — пустой документ схлопнулся с именем (AE6)',
      [2, 2],
      ['А', 'Б', 'В'],
      5,
      [2],
      ['А', 'В'],
    ],
    [
      'разрез в конце ленты — пустой последний схлопнулся',
      [2, 5],
      ['А', 'Б', 'В'],
      5,
      [2],
      ['А', 'Б'],
    ],
    ['выход за край прижимается', [2, 9], ['А', 'Б', 'В'], 5, [2], ['А', 'Б']],
    [
      'убывающий прижат к предыдущему — средний пустой схлопнулся',
      [4, 2],
      ['А', 'Б', 'В'],
      5,
      [4],
      ['А', 'В'],
    ],
    ['пустая лента — один документ, первое имя живо', [1, 2], ['А', 'Б', 'В'], 0, [], ['А']],
  ])('%s', (_name, cuts, names, length, expectedCuts, expectedNames) => {
    expect(normalizeCuts(cuts, names, length)).toEqual({
      cuts: expectedCuts,
      names: expectedNames,
    });
  });

  it('разрезы считаются по видимой ленте: удалённые позиций не занимают', () => {
    const given = edits({ deleted: ['d', 'e'], cuts: [3, 4], names: ['', 'Б', 'В'] });

    // Видимых три: разрез 3 — в конце ленты, пустые документы схлопнулись.
    expect(normalizeEdits(AUTO, given)).toMatchObject({ cuts: [], names: [''] });
  });
});

describe('правки: канонический вид', () => {
  const messy = edits({
    order: ['c', 'x', 'c', 'a'],
    rotations: { b: 90, x: 180, c: 270 },
    deleted: ['e', 'y', 'e'],
    cuts: [0, 2, 2, 9],
    names: ['A', 'B', 'C', 'D', 'E'],
  });

  it('мёртвые ключи и повторы вычищены, разрезы внутри ленты', () => {
    expect(normalizeEdits(AUTO, messy)).toEqual({
      order: ['c', 'a'],
      rotations: { b: 90, c: 270 },
      deleted: ['e'],
      cuts: [2],
      names: ['B', 'D'],
      divider: null,
    });
  });

  it('нормализация идемпотентна', () => {
    const once = normalizeEdits(AUTO, messy);

    expect(normalizeEdits(AUTO, once)).toEqual(once);
  });
});

describe('правки: документы по разрезам', () => {
  it('документы покрывают ленту без зазоров', () => {
    expect(documentsOf(5, edits({ cuts: [2, 3], names: ['А', '', 'В'] }))).toEqual([
      { name: 'А', start: 0, count: 2 },
      { name: '', start: 2, count: 1 },
      { name: 'В', start: 3, count: 2 },
    ]);
  });

  it('перенос через разрез меняет документ только перенесённой страницы (AE5)', () => {
    // Лента a b | c d e; «d» перенесли в начало. Жест редактора (U6) держит разрез между теми
    // же неподвижными соседями «b» и «c»: позиция сдвигается на перенесённую страницу.
    const before = edits({ cuts: [2], names: ['Счёт', 'Акт'] });
    const after = edits({ order: ['d', 'a', 'b', 'c', 'e'], cuts: [3], names: ['Счёт', 'Акт'] });
    const documentOf = (given: SessionEdits, key: string): string | undefined => {
      const index = visibleKeysOf(AUTO, given).indexOf(key);
      return documentsOf(AUTO.length, given).find(
        (doc) => index >= doc.start && index < doc.start + doc.count,
      )?.name;
    };

    expect(AUTO.map((key) => documentOf(before, key))).toEqual([
      'Счёт',
      'Счёт',
      'Акт',
      'Акт',
      'Акт',
    ]);
    expect(AUTO.map((key) => documentOf(after, key))).toEqual([
      'Счёт',
      'Счёт',
      'Акт',
      'Счёт',
      'Акт',
    ]);
  });
});

describe('правки: разрезы при изменении ленты вне правок (KTD-10)', () => {
  it('вставка в середину автопорядка — разрез остался перед той же страницей', () => {
    // Лицевые f1 f2 f3, оборот листа 3; досканирование добавило оборот листа 2.
    const before = ['f1', 'f2', 'f3', 'b3'];
    const after = ['f1', 'f2', 'b2', 'f3', 'b3'];

    expect(remapCuts(before, after, [2])).toEqual([3]);
  });

  it('страницы за разрезом нет — разрез перед следующей уцелевшей', () => {
    expect(remapCuts(['a', 'b', 'c', 'd'], ['a', 'b', 'd'], [2])).toEqual([2]);
    expect(remapCuts(['a', 'b', 'c', 'd'], ['a', 'd'], [1, 2])).toEqual([1, 1]);
  });

  it('за разрезом не осталось ни одной страницы — разрез в конце ленты', () => {
    expect(remapCuts(['a', 'b', 'c'], ['a'], [1])).toEqual([1]);
  });

  it('хвостовая дописка при ручном порядке: ключ встаёт за предшественником, разрез — перед той же страницей', () => {
    const manual = edits({ order: ['c', 'a', 'b'], cuts: [1], names: ['', 'Хвост'] });

    // «d» идёт в автопорядке за «c»; «c» первый в ручном порядке — «d» за ним, разрез перед «a».
    expect(rebaseEdits(['a', 'b', 'c'], ['a', 'b', 'c', 'd'], manual)).toEqual(
      edits({ order: ['c', 'd', 'a', 'b'], cuts: [2], names: ['', 'Хвост'] }),
    );
  });

  it('отброс сегмента в середине: разрез переехал, правки мёртвых ключей вычищены', () => {
    const given = edits({
      rotations: { c: 90, d: 180 },
      deleted: ['c'],
      cuts: [3],
      names: ['', 'Хвост'],
    });

    // Видимая лента a b d e, разрез перед «e»; ушли «c» и «d».
    expect(rebaseEdits(AUTO, ['a', 'b', 'e'], given)).toEqual(
      edits({ cuts: [2], names: ['', 'Хвост'] }),
    );
  });

  it('состав не менялся — только нормализация, без переноса', () => {
    const given = edits({ cuts: [2, 2], names: ['', 'Б', 'В'] });

    expect(rebaseEdits(AUTO, AUTO, given)).toEqual(edits({ cuts: [2], names: ['', 'В'] }));
    expect(rebaseEdits(null, AUTO, given)).toEqual(edits({ cuts: [2], names: ['', 'В'] }));
  });
});

describe('правки: граница наборов (M3.6, KTD3)', () => {
  it('вне режима наборов граница всегда null, разрезы — как прежде', () => {
    expect(normalizeEdits(AUTO, edits({ divider: 2, cuts: [1] }))).toMatchObject({
      divider: null,
      cuts: [1],
      names: ['', ''],
    });
  });

  it('в режиме наборов разрезы и имена — как в пустых правках; граница остаётся', () => {
    expect(
      normalizeEdits(AUTO, edits({ cuts: [1], names: ['a', 'b'], divider: 1 }), setsContext(2)),
    ).toEqual({ ...EMPTY_EDITS, divider: 1 });
  });

  it('идёт проход оборотов — переходное состояние: разрезы и граница остаются, граница прижата', () => {
    const given = edits({ cuts: [1], names: ['a', 'b'], divider: 9 });

    expect(normalizeEdits(AUTO, given, TRANSIT_CONTEXT)).toEqual({ ...given, divider: 5 });
  });

  it.each([
    ['равна авто — null', 2, [], 2, null],
    ['ноль допустим: группа лиц пуста', 0, [], 2, 0],
    ['все страницы — лица', 5, [], 2, 5],
    ['за концом ленты — прижата к концу', 9, [], 2, 5],
    ['конец ленты считается по видимым', 9, ['e'], 2, 4],
    ['после прижатия равна авто — null', 9, ['e'], 4, null],
  ])('граница: %s', (_name, divider, deleted, sets, expected) => {
    expect(normalizeEdits(AUTO, edits({ divider, deleted }), setsContext(sets)).divider).toBe(
      expected,
    );
  });

  it('при изменении ленты вне правок граница остаётся перед той же страницей (R9)', () => {
    const given = edits({ divider: 2 }); // a b | c d e

    const sets = setsContext(1);

    expect(rebaseEdits(AUTO, ['a', 'b', 'x', 'c', 'd', 'e'], given, sets).divider).toBe(3);
    expect(rebaseEdits(AUTO, ['a', 'b', 'd', 'e'], given, sets).divider).toBe(2);
    // За границей не осталось страниц: граница в конце — допустимо, не схлопывается.
    expect(rebaseEdits(AUTO, ['a', 'b'], given, sets).divider).toBe(2);
    // Состав не менялся — только нормализация.
    expect(rebaseEdits(AUTO, AUTO, given, setsContext(2)).divider).toBeNull();
  });

  it('граница — правка: есть что откатывать; равенство правок её видит', () => {
    expect(hasEdits(edits({ divider: 0 }), false)).toBe(true);
    expect(sameEdits(edits({ divider: 1 }), edits({ divider: null }))).toBe(false);
    expect(sameEdits(edits({ divider: 1 }), edits({ divider: 1 }))).toBe(true);
  });
});

describe('правки: угол и признак правок', () => {
  it.each([
    [undefined, false, 0],
    [undefined, true, 180],
    [90, false, 90],
    [90, true, 270],
    [180, true, 0],
    [270, true, 90],
  ] as const)('ручной %s + оборот %s → %s (KTD-4)', (edit, backs, expected) => {
    expect(pageAngle(edit, backs)).toBe(expected);
  });

  it.each([
    ['пусто', edits({}), false, false],
    ['поворот оборотов', edits({}), true, true],
    ['порядок', edits({ order: ['b'] }), false, true],
    ['угол', edits({ rotations: { a: 90 } }), false, true],
    ['удаление', edits({ deleted: ['a'] }), false, true],
    ['разрез', edits({ cuts: [1], names: ['', ''] }), false, true],
    ['имя единственного документа', edits({ names: ['Договор'] }), false, true],
  ])('%s', (_name, given, rotateBacks, expected) => {
    expect(hasEdits(given, rotateBacks)).toBe(expected);
  });

  it('равенство правок не зависит от порядка ключей углов', () => {
    const left = edits({ rotations: { a: 90, b: 180 } });
    const right = edits({ rotations: { b: 180, a: 90 } });

    expect(sameEdits(left, right)).toBe(true);
    expect(sameEdits(left, edits({ rotations: { a: 90 } }))).toBe(false);
    expect(sameEdits(left, edits({ rotations: { a: 90, b: 270 } }))).toBe(false);
    expect(
      sameEdits(edits({ cuts: [1], names: ['', ''] }), edits({ cuts: [2], names: ['', ''] })),
    ).toBe(false);
  });
});

describe('правки: ручной порядок при новых ключах (M3.5, KTD-3)', () => {
  // Пары 1л 1о 2л 2о 3л 3о в коротких ключах: f1 b1 f2 b2 f3 b3; добавленные — d1, d2, e1.
  const PAIRS = ['f1', 'b1', 'f2', 'b2', 'f3', 'b3'];
  /** Автопорядок после вставки набора `keys` сразу за `after`. */
  const inserted = (auto: readonly string[], after: string, keys: readonly string[]): string[] => {
    const at = auto.indexOf(after);
    return [...auto.slice(0, at + 1), ...keys, ...auto.slice(at + 1)];
  };
  const AFTER_F2 = inserted(PAIRS, 'f2', ['d1', 'd2']);

  it.each([
    [
      'полный ручной порядок: новые ключи за предшественником по автопорядку',
      ['f3', 'f1', 'f2', 'b1', 'b2', 'b3'],
      ['f3', 'f1', 'f2', 'd1', 'd2', 'b1', 'b2', 'b3'],
    ],
    [
      'неполный порядок: предшественник ищется среди размещённых',
      ['f3', 'f1'],
      ['f3', 'f1', 'd1', 'd2'],
    ],
    [
      'якоря нет в порядке — предшественник по автопорядку, который в порядке есть',
      ['b3', 'f1'],
      ['b3', 'f1', 'd1', 'd2'],
    ],
    ['предшественника в порядке нет — ключ не размещается', ['b3', 'b2'], ['b3', 'b2']],
  ])('%s', (_name, order, expected) => {
    expect(rebaseOrder(PAIRS, AFTER_F2, order)).toEqual(expected);
  });

  it('якорь удалён правкой: в порядке он есть — набор за ним, видимая лента — за предыдущей', () => {
    const given = edits({ order: ['f3', 'f1', 'f2', 'b1'], deleted: ['f2'] });

    const rebased = rebaseEdits(PAIRS, AFTER_F2, given);
    expect(rebased.order).toEqual(['f3', 'f1', 'f2', 'd1', 'd2', 'b1']);
    expect(visibleKeysOf(AFTER_F2, rebased)).toEqual(['f3', 'f1', 'd1', 'd2', 'b1', 'b2', 'b3']);
  });

  it('три ключа одним коммитом (усыновлённый сегмент) — подряд, как при трёх коммитах', () => {
    const order = ['f3', 'f1', 'f2', 'b1'];
    const after = inserted(PAIRS, 'f2', ['d1', 'd2', 'd3']);

    const atOnce = rebaseOrder(PAIRS, after, order);
    const oneByOne = rebaseOrder(
      inserted(PAIRS, 'f2', ['d1', 'd2']),
      after,
      rebaseOrder(
        inserted(PAIRS, 'f2', ['d1']),
        inserted(PAIRS, 'f2', ['d1', 'd2']),
        rebaseOrder(PAIRS, inserted(PAIRS, 'f2', ['d1']), order),
      ),
    );
    expect(atOnce).toEqual(['f3', 'f1', 'f2', 'd1', 'd2', 'd3', 'b1']);
    expect(oneByOne).toEqual(atOnce);
  });

  it('первый набор перетащен в начало, второй добавлен после того же якоря — за якорем, не рядом с первым', () => {
    const before = AFTER_F2;
    const after = inserted(PAIRS, 'f2', ['e1', 'd1', 'd2']);
    const order = ['d1', 'd2', 'f1', 'b1', 'f2', 'b2', 'f3', 'b3'];

    expect(rebaseOrder(before, after, order)).toEqual([
      'd1',
      'd2',
      'f1',
      'b1',
      'f2',
      'e1',
      'b2',
      'f3',
      'b3',
    ]);
  });

  it('разрезы переезжают, углы и удаления целы; повтор ничего не меняет', () => {
    const given = edits({
      order: ['f3', 'f1', 'f2', 'b1', 'b2', 'b3'],
      rotations: { f1: 90, b3: 180 },
      deleted: ['b2'],
      cuts: [2, 3],
      names: ['А', 'Б', 'В'],
    });
    // Видимая лента до: f3 f1 | f2 | b1 b3; после: f3 f1 | f2 d1 d2 | b1 b3.
    const rebased = rebaseEdits(PAIRS, AFTER_F2, given);

    expect(rebased).toEqual(
      edits({
        order: ['f3', 'f1', 'f2', 'd1', 'd2', 'b1', 'b2', 'b3'],
        rotations: { f1: 90, b3: 180 },
        deleted: ['b2'],
        cuts: [2, 5],
        names: ['А', 'Б', 'В'],
      }),
    );
    expect(rebaseEdits(AFTER_F2, AFTER_F2, rebased)).toEqual(rebased);
  });

  it('досканирование лицевых при ручном порядке — на своё место, не в конец (замена AE9 M3)', () => {
    // Лицевые f1 f2 прерваны, обороты b2 b1; досканирован f3: автопорядок f1 b1 f2 b2 f3.
    const before = ['f1', 'b1', 'f2', 'b2'];
    const after = ['f1', 'b1', 'f2', 'b2', 'f3'];
    const manual = edits({ order: ['f2', 'b2', 'f1', 'b1'], cuts: [2], names: ['', 'Хвост'] });

    expect(rebaseEdits(before, after, manual)).toEqual(
      edits({ order: ['f2', 'b2', 'f3', 'f1', 'b1'], cuts: [3], names: ['', 'Хвост'] }),
    );
  });

  describe('разрезы и документы', () => {
    const documentNames = (auto: readonly string[], given: SessionEdits): string[] => {
      const visible = visibleKeysOf(auto, given);
      return documentsOf(visible.length, given).flatMap((doc) =>
        visible.slice(doc.start, doc.start + doc.count).map(() => doc.name),
      );
    };

    it('якорь — последняя страница документа → набор в нём', () => {
      // Документы: А = f1 b1 f2, Б = b2 f3 b3; набор после f2 (последняя в А).
      const given = edits({ cuts: [3], names: ['А', 'Б'] });

      const rebased = rebaseEdits(PAIRS, AFTER_F2, given);
      expect(rebased.cuts).toEqual([5]);
      expect(documentNames(AFTER_F2, rebased)).toEqual(['А', 'А', 'А', 'А', 'А', 'Б', 'Б', 'Б']);
    });

    it('первый набор отрезан в отдельный документ, второй добавлен после того же якоря → в документе якоря', () => {
      // Лента f1 b1 f2 | d1 d2 | b2 f3 b3; набор e1 после f2 встаёт перед d1 — в документе якоря.
      const given = edits({ cuts: [3, 5], names: ['А', 'Набор', 'Б'] });
      const after = inserted(PAIRS, 'f2', ['e1', 'd1', 'd2']);

      const rebased = rebaseEdits(AFTER_F2, after, given);
      expect(rebased.cuts).toEqual([4, 6]);
      expect(documentNames(after, rebased)).toEqual([
        'А',
        'А',
        'А',
        'А',
        'Набор',
        'Набор',
        'Б',
        'Б',
        'Б',
      ]);
    });

    it('якорь — последняя страница ленты → разрезы не тронуты', () => {
      const given = edits({ cuts: [3], names: ['А', 'Б'] });
      const after = inserted(PAIRS, 'b3', ['d1', 'd2']);

      expect(rebaseEdits(PAIRS, after, given)).toEqual(given);
    });
  });
});
