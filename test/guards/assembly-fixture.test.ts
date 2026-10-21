import { EMPTY_EDITS, type PassSnapshot, type SessionSnapshot } from '@shared';
import { describe, expect, it } from 'vitest';
import { assembleSession } from '../../src/core/scan/assembly';
import { assemblyOf } from '../../src/renderer/src/state/assembly-fixture';

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
  passes,
  ...extra,
});

const pairs = [passOf(1, 'fronts', 3), passOf(2, 'backs', 3)];
const F2 = 'p01-s01-0002';

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
  ])('%s', (_name, session) => {
    expect(assemblyOf(session)).toEqual(assembleSession(session));
  });
});
