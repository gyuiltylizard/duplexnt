import {
  EMPTY_EDITS,
  type PassSnapshot,
  type SessionSnapshot,
  type StraightenFacts,
} from '@shared';
import { describe, expect, it } from 'vitest';
import { assembleSession } from '../../src/core/scan/assembly';
import { assemblyOf, assemblyWithEditsOf } from '../../src/renderer/src/state/assembly-fixture';

// Renderer не импортирует ядро (граница слоёв), а jsdom-тестам нужна лента — поэтому у них своё
// зеркало автопорядка `assemblyOf` (план M3.5, KTD-2). Этот тест живёт вне обоих слоёв и гоняет
// зеркало и ядро на одних данных: разошлись — jsdom-тесты проверяют не ту ленту.

const pagesOf = (pass: number, count: number, lost: readonly number[] = []) =>
  Array.from({ length: count }, (_value, index) => ({
    key: `p${String(pass).padStart(2, '0')}-s01-${String(index + 1).padStart(4, '0')}`,
    number: index + 1,
    lost: lost.includes(index + 1),
  }));

const passOf = (
  number: number,
  kind: PassSnapshot['kind'],
  count: number,
  extra: Partial<PassSnapshot> = {},
): PassSnapshot => ({
  number,
  kind,
  after: null,
  pair: null,
  backsDecision: null,
  state: 'completed',
  paramsKnown: true,
  scanner: null,
  rotate180: false,
  pages: pagesOf(number, count),
  ...extra,
});

const sessionOf = (
  passes: PassSnapshot[],
  extra: Partial<SessionSnapshot> = {},
): SessionSnapshot => ({
  id: 'a1b2c3d4e5f60718',
  backsDeclined: false,
  saved: false,
  edits: EMPTY_EDITS,
  assembled: null,
  blankMode: 'keep',
  straighten: 'off',
  passes,
  ...extra,
});

const pairs = [passOf(1, 'fronts', 3), passOf(2, 'backs', 3)];
const F2 = 'p01-s01-0002';
/** Лица двустороннего набора «Д1» (3 стр.) после F2, обороты ждём (M4.5). */
const SET_FRONTS = passOf(3, 'addedFronts', 3, { after: F2, backsDecision: 'none' });
/** Пара набора «Д1» 3+3. */
const PAIR = [SET_FRONTS, passOf(4, 'addedBacks', 3, { pair: 3 })];

describe('зеркало автопорядка renderer против ядра (KTD-2)', () => {
  it.each<[string, SessionSnapshot]>([
    ['равные проходы 3+3', sessionOf(pairs)],
    [
      'оборотов меньше: непарные — младшие',
      sessionOf([passOf(1, 'fronts', 3), passOf(2, 'backs', 1)]),
    ],
    ['оборотов больше: лишние в конце', sessionOf([passOf(1, 'fronts', 2), passOf(2, 'backs', 4)])],
    [
      'только лицевые, обороты не нужны',
      sessionOf([passOf(1, 'fronts', 3)], { backsDeclined: true }),
    ],
    [
      'обороты повёрнуты на 180°',
      sessionOf([passOf(1, 'fronts', 2), passOf(2, 'backs', 2, { rotate180: true })]),
    ],
    [
      'обороты приняты коротким',
      sessionOf([passOf(1, 'fronts', 3), passOf(2, 'backs', 2, { state: 'accepted' })]),
    ],
    [
      'потерянная страница на своём месте',
      sessionOf([passOf(1, 'fronts', 3, { pages: pagesOf(1, 3, [2]) }), passOf(2, 'backs', 3)]),
    ],
    [
      'пустой проход оборотов роли не занимает',
      sessionOf([passOf(1, 'fronts', 2), passOf(2, 'backs', 0, { state: 'interrupted' })]),
    ],
    [
      'роль по kind: лицевые — проход №3',
      sessionOf([passOf(3, 'fronts', 2)], { backsDeclined: true }),
    ],
    [
      'пример из плана: два набора с одним якорем, якорь внутри блока',
      sessionOf([
        ...pairs,
        passOf(3, 'added', 2, { after: F2 }),
        passOf(4, 'added', 1, { after: F2 }),
        passOf(5, 'added', 1, { after: 'p03-s01-0002' }),
      ]),
    ],
    ['якорь — оборот', sessionOf([...pairs, passOf(3, 'added', 2, { after: 'p02-s01-0002' })])],
    ['якоря нет — в конец', sessionOf([...pairs, passOf(3, 'added', 2)])],
    [
      'якорь исчез из сессии — в конец',
      sessionOf([...pairs, passOf(3, 'added', 2, { after: 'p09-s01-0001' })]),
    ],
    [
      'якорь — ключ более позднего прохода — в конец',
      sessionOf([
        ...pairs,
        passOf(3, 'added', 1, { after: 'p04-s01-0001' }),
        passOf(4, 'added', 1),
      ]),
    ],
    [
      'добавленный при «обороты не нужны»: вне отчёта, без поворота',
      sessionOf(
        [passOf(1, 'fronts', 2), passOf(2, 'added', 1, { after: 'p01-s01-0001', rotate180: true })],
        { backsDeclined: true },
      ),
    ],
    [
      'добавленный при несовпадении: отчёт пар прежний, непарные помечены',
      sessionOf([
        passOf(1, 'fronts', 3),
        passOf(2, 'backs', 2),
        passOf(3, 'added', 1, { after: 'p01-s01-0001' }),
      ]),
    ],
    [
      'тег набора — номер от 1 среди добавленных, не номер прохода',
      sessionOf([passOf(1, 'fronts', 2), passOf(4, 'added', 1), passOf(7, 'added', 1)], {
        backsDeclined: true,
      }),
    ],
    [
      'пустой добавленный проход набора не образует',
      sessionOf([
        ...pairs,
        passOf(3, 'added', 0, { state: 'interrupted' }),
        passOf(4, 'added', 1, { after: F2 }),
      ]),
    ],
    // Режимы M3.6 (KTD2): раздельные наборы и «собрано».
    [
      'раздельные наборы 3/2: лица, затем обороты обратным порядком',
      sessionOf([passOf(1, 'fronts', 3), passOf(2, 'backs', 2)]),
    ],
    [
      'наборы: добавленный с якорем-оборотом — в группе оборотов за якорем',
      sessionOf([
        passOf(1, 'fronts', 3),
        passOf(2, 'backs', 2),
        passOf(3, 'added', 1, { after: 'p02-s01-0002' }),
      ]),
    ],
    [
      'наборы: добавленный с якорем-лицом — в группе лиц',
      sessionOf([
        passOf(1, 'fronts', 3),
        passOf(2, 'backs', 2),
        passOf(3, 'added', 2, { after: F2 }),
      ]),
    ],
    [
      'наборы: якоря нет — в конец группы оборотов',
      sessionOf([passOf(1, 'fronts', 3), passOf(2, 'backs', 2), passOf(3, 'added', 1)]),
    ],
    [
      'наборы: обороты прерваны и не приняты',
      sessionOf([passOf(1, 'fronts', 3), passOf(2, 'backs', 1, { state: 'interrupted' })]),
    ],
    [
      'наборы: обороты повёрнуты на 180°',
      sessionOf([passOf(1, 'fronts', 2), passOf(2, 'backs', 3, { rotate180: true })]),
    ],
    [
      'проход оборотов идёт при неравных числах — пары',
      sessionOf([passOf(1, 'fronts', 3), passOf(2, 'backs', 1, { state: 'running' })]),
    ],
    [
      'собрано: лента по записи, сторона и лист по позиции',
      sessionOf([passOf(1, 'fronts', 3), passOf(2, 'backs', 2)], {
        assembled: ['p01-s01-0001', 'p02-s01-0002', 'p01-s01-0002', 'p02-s01-0001', 'p01-s01-0003'],
      }),
    ],
    [
      'собрано: новый добавленный после сборки — по якорю, без листа',
      sessionOf(
        [
          passOf(1, 'fronts', 3),
          passOf(2, 'backs', 2),
          passOf(3, 'added', 2, { after: 'p02-s01-0002' }),
        ],
        {
          assembled: [
            'p01-s01-0001',
            'p02-s01-0002',
            'p01-s01-0002',
            'p02-s01-0001',
            'p01-s01-0003',
          ],
        },
      ),
    ],
    [
      'собрано: досканированный сегмент оборотов — за предыдущей страницей прохода, повёрнут',
      sessionOf(
        [
          passOf(1, 'fronts', 3),
          passOf(2, 'backs', 0, {
            rotate180: true,
            pages: [...pagesOf(2, 2), { key: 'p02-s02-0001', number: 3, lost: false }],
          }),
        ],
        {
          assembled: [
            'p01-s01-0001',
            'p02-s01-0002',
            'p01-s01-0002',
            'p02-s01-0001',
            'p01-s01-0003',
          ],
        },
      ),
    ],
    [
      'собрано: мёртвый ключ записи пропущен, ключ без записи — в конец',
      sessionOf([passOf(1, 'fronts', 3), passOf(2, 'backs', 2)], {
        assembled: ['p01-s01-0001', 'p09-s01-0001', 'p02-s01-0002', 'p01-s01-0003'],
      }),
    ],
    // Двусторонние добавленные наборы (M4.5, KTD5).
    ['пара набора 3+3 по якорю — чередование, лист внутри набора', sessionOf([...pairs, ...PAIR])],
    [
      'пара набора: обороты короче — подблоки, несовпадение набора в отчёте',
      sessionOf([...pairs, SET_FRONTS, passOf(4, 'addedBacks', 2, { pair: 3 })]),
    ],
    [
      'пара набора: обороты прерваны на одной странице',
      sessionOf([
        ...pairs,
        SET_FRONTS,
        passOf(4, 'addedBacks', 1, { pair: 3, state: 'interrupted' }),
      ]),
    ],
    [
      'пара набора: обороты приняты короткими, решение «оставить»',
      sessionOf([
        ...pairs,
        passOf(3, 'addedFronts', 3, { after: F2, backsDecision: 'kept' }),
        passOf(4, 'addedBacks', 2, { pair: 3, state: 'accepted' }),
      ]),
    ],
    ['набор ждёт обороты — pendingSet', sessionOf([...pairs, SET_FRONTS])],
    [
      'набор после отказа от оборотов — односторонним блоком',
      sessionOf([...pairs, passOf(3, 'addedFronts', 3, { after: F2, backsDecision: 'declined' })]),
    ],
    [
      'обороты набора повёрнуты, основной пачки — нет',
      sessionOf([...pairs, SET_FRONTS, passOf(4, 'addedBacks', 3, { pair: 3, rotate180: true })]),
    ],
    [
      'обороты основной пачки повёрнуты, набора — нет',
      sessionOf([passOf(1, 'fronts', 3), passOf(2, 'backs', 3, { rotate180: true }), ...PAIR]),
    ],
    [
      'два набора: односторонний, пара и односторонний с якорем внутри блока пары',
      sessionOf([
        ...pairs,
        passOf(3, 'added', 1, { after: 'p01-s01-0001' }),
        passOf(4, 'addedFronts', 2, { after: F2, backsDecision: 'none' }),
        passOf(5, 'addedBacks', 2, { pair: 4 }),
        passOf(6, 'added', 1, { after: 'p05-s01-0001' }),
      ]),
    ],
    [
      'осиротевшие обороты набора — в конец',
      sessionOf([...pairs, passOf(4, 'addedBacks', 2, { pair: 3 })]),
    ],
    [
      'пара набора без якоря — блоком в конец',
      sessionOf([
        ...pairs,
        passOf(3, 'addedFronts', 2, { backsDecision: 'none' }),
        passOf(4, 'addedBacks', 2, { pair: 3 }),
      ]),
    ],
    [
      'пустые лица набора роли не занимают, обороты по ссылке на них — осиротевшие',
      sessionOf([
        ...pairs,
        passOf(3, 'addedFronts', 0, { after: F2, backsDecision: 'none', state: 'interrupted' }),
        passOf(4, 'addedBacks', 1, { pair: 3 }),
      ]),
    ],
    [
      'собрано: пара вне записи — блоком по якорю с чередованием',
      sessionOf([passOf(1, 'fronts', 3), passOf(2, 'backs', 2), ...PAIR], {
        assembled: ['p01-s01-0001', 'p02-s01-0002', 'p01-s01-0002', 'p02-s01-0001', 'p01-s01-0003'],
      }),
    ],
    [
      'собрано: набор, которого запись коснулась, — по одной странице',
      sessionOf([passOf(1, 'fronts', 3), passOf(2, 'backs', 2), ...PAIR], {
        assembled: [
          'p01-s01-0001',
          'p02-s01-0002',
          'p01-s01-0002',
          'p03-s01-0001',
          'p02-s01-0001',
          'p01-s01-0003',
        ],
      }),
    ],
    [
      'наборы: односторонний набор рядом с парой (пара — только через правку журнала)',
      sessionOf([passOf(1, 'fronts', 3), passOf(2, 'backs', 2), ...PAIR, passOf(5, 'added', 1)]),
    ],
  ])('%s', (_name, session) => {
    expect(assemblyOf(session)).toEqual(assembleSession(session));
  });
});

// Зеркало с правками (M3.6; ревью #8): jsdom-фикстура `applied` строит ленту с правками сама —
// сверяем её с ядром в каждом режиме. Правки — канонические: ядро нормализует до снимка, а
// зеркало получает уже записанное.
describe('зеркало с правками против ядра (M3, KTD-2; M3.6, R8–R11)', () => {
  const sets3x2 = [passOf(1, 'fronts', 3), passOf(2, 'backs', 2)];
  const F1 = 'p01-s01-0001';
  const F3 = 'p01-s01-0003';
  const B1 = 'p02-s01-0001';
  const B2 = 'p02-s01-0002';
  const record = [F1, B2, F2, B1, F3];

  it.each<[string, SessionSnapshot]>([
    [
      'пары: явный порядок, разрезы, удаление, повороты',
      sessionOf(pairs, {
        edits: {
          ...EMPTY_EDITS,
          order: [F2, F1],
          deleted: [B1],
          rotations: { [F3]: 90 },
          cuts: [2],
          names: ['Счёт', 'Акт'],
        },
      }),
    ],
    [
      'наборы: лицо перенесено в обороты, граница явная',
      sessionOf(sets3x2, {
        edits: { ...EMPTY_EDITS, order: [F1, F2, B2, F3, B1], divider: 2 },
      }),
    ],
    [
      'наборы: оборот перенесён в лица, граница равна числу лиц',
      sessionOf(sets3x2, {
        edits: { ...EMPTY_EDITS, order: [F1, F2, F3, B2, B1], divider: 4 },
      }),
    ],
    [
      'наборы: удаление без явной границы — авто по базовой группе',
      sessionOf(sets3x2, { edits: { ...EMPTY_EDITS, deleted: [F1, B2] } }),
    ],
    [
      'наборы: граница 0 и граница в конце ленты',
      sessionOf(sets3x2, { edits: { ...EMPTY_EDITS, divider: 0 } }),
    ],
    ['наборы: все страницы — лица', sessionOf(sets3x2, { edits: { ...EMPTY_EDITS, divider: 5 } })],
    [
      'наборы: удалённые и повёрнутые при явной границе',
      sessionOf(sets3x2, {
        edits: { ...EMPTY_EDITS, deleted: [F2], rotations: { [B1]: 270 }, divider: 1 },
      }),
    ],
    [
      'собрано: удаление страницы записи — листы по позиции среди оставшихся',
      sessionOf(sets3x2, {
        assembled: record,
        edits: { ...EMPTY_EDITS, deleted: [B2] },
      }),
    ],
    [
      'собрано: явный порядок и разрезы поверх записи',
      sessionOf(sets3x2, {
        assembled: record,
        edits: { ...EMPTY_EDITS, order: [F3, F1], cuts: [2], names: ['', 'Хвост'] },
      }),
    ],
    [
      'собрано: добавленный после сборки, перенесённый и повёрнутый',
      sessionOf([...sets3x2, passOf(3, 'added', 1, { after: B1 })], {
        assembled: record,
        edits: { ...EMPTY_EDITS, order: ['p03-s01-0001', F1], rotations: { 'p03-s01-0001': 90 } },
      }),
    ],
    // Пары добавленных наборов с правками (M4.5).
    [
      'пары: пара набора — явный порядок, удаление оборота набора, ручной поворот поверх флага, разрез',
      sessionOf([...pairs, SET_FRONTS, passOf(4, 'addedBacks', 3, { pair: 3, rotate180: true })], {
        edits: {
          ...EMPTY_EDITS,
          order: ['p04-s01-0001', F1],
          deleted: ['p04-s01-0003'],
          rotations: { 'p04-s01-0002': 90, 'p03-s01-0001': 180 },
          cuts: [4],
          names: ['', 'Набор'],
        },
      }),
    ],
    [
      'пары: подблоки несовпавшего набора с удалением лица набора',
      sessionOf([...pairs, SET_FRONTS, passOf(4, 'addedBacks', 2, { pair: 3 })], {
        edits: { ...EMPTY_EDITS, deleted: ['p03-s01-0002'] },
      }),
    ],
    [
      'собрано: пара после сборки с переносом её оборота',
      sessionOf([...sets3x2, ...PAIR], {
        assembled: record,
        edits: { ...EMPTY_EDITS, order: ['p04-s01-0003', F1] },
      }),
    ],
  ])('%s', (_name, session) => {
    expect(assemblyWithEditsOf(session)).toEqual(assembleSession(session));
  });
});

// Флаги пустых оборотов (M4, R10, KTD4, KTD9): зеркало ставит их по тем же правилам, что ядро —
// по проходу оборотов, режиму сессии, вердикту, пометке и режиму сборки.
describe('зеркало с флагами пустых оборотов против ядра (M4, R10)', () => {
  const B1 = 'p02-s01-0001';
  const B2 = 'p02-s01-0002';
  const B3 = 'p02-s01-0003';
  const verdicts = new Map<string, boolean>([
    [B1, true],
    [B2, false],
    [F2, true],
    ['p03-s01-0001', true],
    ['p04-s01-0001', true],
  ]);
  const sets3x2 = [passOf(1, 'fronts', 3), passOf(2, 'backs', 2)];

  it.each<[string, SessionSnapshot]>([
    [
      'пары, «Скрывать»: B1 скрыт, B2 нет, B3 ждёт, лицо без флага',
      sessionOf(pairs, { blankMode: 'hide' }),
    ],
    ['пары, «Помечать»', sessionOf(pairs, { blankMode: 'mark' })],
    ['пары, «Оставлять»: без флагов и ожидания', sessionOf(pairs, { blankMode: 'keep' })],
    ['наборы, «Скрывать» — метка, не скрытие', sessionOf(sets3x2, { blankMode: 'hide' })],
    [
      'добавленный набор не оценивается',
      sessionOf([...pairs, passOf(3, 'added', 1, { after: B1 })], { blankMode: 'hide' }),
    ],
    [
      'потерянный оборот — без флага и ожидания',
      sessionOf([passOf(1, 'fronts', 3), passOf(2, 'backs', 3, { pages: pagesOf(2, 3, [1, 3]) })], {
        blankMode: 'hide',
      }),
    ],
    [
      'собрано, «Скрывать»: оборот по проходу',
      sessionOf(sets3x2, {
        blankMode: 'hide',
        assembled: ['p01-s01-0001', B2, F2, B1, 'p01-s01-0003'],
      }),
    ],
    // Обороты набора оцениваются (M4.5, KTD6): вердикт на p04-s01-0001 — пусто.
    [
      'пара набора, «Скрывать»: оборот набора скрыт в чередовании, лица набора без флага',
      sessionOf([...pairs, ...PAIR], { blankMode: 'hide' }),
    ],
    [
      'подблоки несовпавшего набора, «Скрывать»: скрытие действует',
      sessionOf([...pairs, SET_FRONTS, passOf(4, 'addedBacks', 2, { pair: 3 })], {
        blankMode: 'hide',
      }),
    ],
    [
      'осиротевшие обороты набора, «Помечать»',
      sessionOf([...pairs, passOf(4, 'addedBacks', 2, { pair: 3 })], { blankMode: 'mark' }),
    ],
  ])('%s', (_name, session) => {
    expect(assemblyOf(session, verdicts)).toEqual(assembleSession(session, verdicts));
    expect(assemblyOf(session)).toEqual(assembleSession(session));
  });

  it.each<[string, SessionSnapshot]>([
    [
      'пары: пометка «не пустая» (с вердиктом и без), удаление',
      sessionOf(pairs, {
        blankMode: 'hide',
        edits: { ...EMPTY_EDITS, notBlank: [B1, B3], deleted: [B2] },
      }),
    ],
    [
      'наборы с явной границей: оборот в группе лиц остаётся оборотом по проходу',
      sessionOf(sets3x2, {
        blankMode: 'hide',
        edits: { ...EMPTY_EDITS, order: [B1, 'p01-s01-0001'], divider: 2 },
      }),
    ],
    [
      'собрано: порядок и разрезы поверх, флаги по проходу',
      sessionOf(sets3x2, {
        blankMode: 'mark',
        assembled: ['p01-s01-0001', B2, F2, B1, 'p01-s01-0003'],
        edits: { ...EMPTY_EDITS, order: [B1], cuts: [2], names: ['', ''] },
      }),
    ],
  ])('%s', (_name, session) => {
    expect(assemblyWithEditsOf(session, verdicts)).toEqual(assembleSession(session, verdicts));
  });
});

// Статусы выравнивания (M6, KTD-9): зеркало ставит их тем же `straightenMarkOf` — по режиму
// сессии, флагу пустоты, фактам ядра и откату пользователя; сводка — тем же правилом.
describe('зеркало со статусами выравнивания против ядра (M6, KTD-9)', () => {
  const B1 = 'p02-s01-0001';
  const B2 = 'p02-s01-0002';
  const F1 = 'p01-s01-0001';
  const F3 = 'p01-s01-0003';
  const blank = new Map<string, boolean>([
    [B1, true],
    [B2, false],
  ]);
  const facts: StraightenFacts = new Map([
    [F1, { outcome: 'willStraighten', version: 1, deferred: null, cause: null }],
    [F2, { outcome: 'unmeasurable', version: null, deferred: null, cause: 'shape' }],
    [F3, { outcome: 'willStraighten', version: null, deferred: 'noSpace', cause: null }],
    [B1, { outcome: 'willStraighten', version: 1, deferred: null, cause: null }],
    [B2, { outcome: 'level', version: null, deferred: null, cause: null }],
    ['p03-s01-0001', { outcome: 'notImproved', version: null, deferred: null, cause: null }],
  ]);
  const sets3x2 = [passOf(1, 'fronts', 3), passOf(2, 'backs', 2)];

  it.each<[string, SessionSnapshot]>([
    [
      'пары, «Скрывать»: скрытый пустой — null, остальные по фактам',
      sessionOf(pairs, { blankMode: 'hide', straighten: 'auto' }),
    ],
    [
      'пары, «Оставлять»: пустой оборот тоже со статусом',
      sessionOf(pairs, { blankMode: 'keep', straighten: 'auto' }),
    ],
    [
      'режим сессии «не выравнивать»: всё null',
      sessionOf(pairs, { blankMode: 'hide', straighten: 'off' }),
    ],
    [
      'наборы: статусы по фактам, помеченный пустой — null',
      sessionOf(sets3x2, { blankMode: 'hide', straighten: 'auto' }),
    ],
    [
      'добавленный набор: «не помогла»',
      sessionOf([...pairs, passOf(3, 'added', 1, { after: B1 })], {
        blankMode: 'hide',
        straighten: 'auto',
      }),
    ],
    [
      'потерянная — null',
      sessionOf([passOf(1, 'fronts', 3, { pages: pagesOf(1, 3, [1]) }), passOf(2, 'backs', 3)], {
        straighten: 'auto',
      }),
    ],
    [
      'откат «Оставить оригинал»: kept у выправленной, у остальных не действует',
      sessionOf(pairs, {
        blankMode: 'keep',
        straighten: 'auto',
        edits: { ...EMPTY_EDITS, keepOriginal: [F1, F2, B2] },
      }),
    ],
    [
      'откат и удаление поверх при «Скрывать»',
      sessionOf(pairs, {
        blankMode: 'hide',
        straighten: 'auto',
        edits: { ...EMPTY_EDITS, keepOriginal: [B1, F1], deleted: [F3] },
      }),
    ],
    [
      'собрано: статусы по ключу, не по позиции',
      sessionOf(sets3x2, {
        blankMode: 'hide',
        straighten: 'auto',
        assembled: [F1, B2, F2, B1, F3],
        edits: { ...EMPTY_EDITS, order: [B1], keepOriginal: [F1] },
      }),
    ],
  ])('%s', (_name, session) => {
    expect(assemblyWithEditsOf(session, blank, facts)).toEqual(
      assembleSession(session, blank, facts),
    );
    if (session.edits === EMPTY_EDITS) {
      expect(assemblyOf(session, blank, facts)).toEqual(assembleSession(session, blank, facts));
    }
  });
});
