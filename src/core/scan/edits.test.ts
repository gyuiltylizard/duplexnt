import { EMPTY_EDITS, type SessionEdits } from '@shared';
import { describe, expect, it } from 'vitest';
import {
  documentsOf,
  hasEdits,
  normalizeCuts,
  normalizeEdits,
  pageAngle,
  rebaseEdits,
  remapCuts,
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

  it('хвостовая дописка при ручном порядке разрезы не двигает', () => {
    const manual = edits({ order: ['c', 'a', 'b'], cuts: [1], names: ['', 'Хвост'] });

    expect(rebaseEdits(['a', 'b', 'c'], ['a', 'b', 'c', 'd'], manual)).toEqual(manual);
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
});
