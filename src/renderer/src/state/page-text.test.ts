import { NO_STRAIGHTEN_MARK, type AssembledPage } from '@shared';
import { describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import { noteOf, whatOf } from './page-text';

// Словарь страницы по режиму сборки (план M3.6, U5; KTD9; R11, R23): до сборки — сторона по
// группе и место в наборе, после — лист по записи; «листа 0» не бывает.

const t = i18n.t.bind(i18n);

const page = (overrides: Partial<AssembledPage>): AssembledPage => ({
  key: 'k',
  side: 'front',
  sheet: 3,
  angle: 0,
  lost: false,
  addedSet: null,
  blank: null,
  straighten: NO_STRAIGHTEN_MARK,
  ...overrides,
});

describe('whatOf', () => {
  it.each([
    ['sets', page({}), 'лицевая, 3-я в наборе лиц'],
    ['sets', page({ side: 'back', sheet: 4 }), 'оборотная, 4-я в наборе оборотов'],
    ['sets', page({ addedSet: 1 }), 'добавленный набор 1, в наборе лиц'],
    ['sets', page({ side: 'back', addedSet: 2 }), 'добавленный набор 2, в наборе оборотов'],
    ['pairs', page({}), 'лицо листа 3'],
    ['pairs', page({ side: 'back' }), 'оборот листа 3'],
    ['pairs', page({ addedSet: 1, sheet: null }), 'добавленный набор 1'],
    ['assembled', page({ side: 'back', sheet: 2 }), 'оборот листа 2'],
    ['assembled', page({ addedSet: 1, sheet: null }), 'добавленный набор 1'],
    // Страница без листа после сборки — без «листа 0».
    ['assembled', page({ sheet: null }), 'лицевая, без листа'],
    ['assembled', page({ side: 'back', sheet: null }), 'оборотная, без листа'],
  ] as const)('%s: %o', (mode, entry, expected) => {
    expect(whatOf(t, entry, mode)).toBe(expected);
  });
});

describe('whatOf: страницы двустороннего набора (M4.5, R13)', () => {
  it.each([
    ['addedFronts', page({ addedSet: 1, sheet: 2 }), 'лицо листа 2 набора Д1'],
    ['addedBacks', page({ addedSet: 1, sheet: 2, side: 'back' }), 'оборот листа 2 набора Д1'],
    ['addedFronts', page({ addedSet: 1, sheet: null }), 'лицевая набора Д1'],
    ['addedBacks', page({ addedSet: 1, sheet: null, side: 'back' }), 'оборотная набора Д1'],
    // Односторонний набор — прежние слова, какой бы ни была сторона.
    ['added', page({ addedSet: 2, sheet: null }), 'добавленный набор 2'],
  ] as const)('%s: %o', (origin, entry, expected) => {
    expect(whatOf(t, entry, 'pairs', origin)).toBe(expected);
    expect(whatOf(t, entry, 'assembled', origin)).toBe(expected);
  });

  it('noteOf: пара и подблоки — свои пояснения', () => {
    expect(
      noteOf(t, page({ addedSet: 1, sheet: 2, side: 'back' }), 'pairs', false, 'addedBacks'),
    ).toBe(
      'Страница двустороннего набора: оборот сопоставлен с лицом по позиции в проходе оборотов набора.',
    );
    expect(
      noteOf(t, page({ addedSet: 1, sheet: null }), 'assembled', false, 'addedFronts'),
    ).toContain('лежат подблоками, без пар');
    expect(noteOf(t, page({ addedSet: 1, sheet: null }), 'pairs', false, 'added')).toContain(
      'сканировалась одним проходом',
    );
  });
});

describe('noteOf', () => {
  it('потеря файла важнее режима', () => {
    expect(noteOf(t, page({ lost: true }), 'sets', false)).toBe(
      'Файл этой страницы потерян — место в порядке сохранено.',
    );
  });

  it('наборы: пояснение называет лист, которым страница станет после сборки', () => {
    expect(noteOf(t, page({}), 'sets', false)).toBe(
      'Документ не собран: сторона и место считаются по набору. После сборки эта страница станет лицом листа 3.',
    );
    expect(noteOf(t, page({ side: 'back', sheet: 1 }), 'sets', false)).toContain(
      'станет оборотом листа 1.',
    );
    expect(noteOf(t, page({ addedSet: 1 }), 'sets', false)).toBe(
      'Страница добавленного набора: в каком наборе лежит, той стороной листа и станет после сборки.',
    );
  });

  it('пары и собрано: как в M3–M3.5', () => {
    expect(noteOf(t, page({}), 'pairs', false)).toBe(
      'Лицо листа 3; его оборот — из прохода оборотов.',
    );
    expect(noteOf(t, page({}), 'pairs', true)).toBe('Обороты не сканировали — лист односторонний.');
    expect(noteOf(t, page({ side: 'back' }), 'assembled', false)).toBe(
      'Оборот листа 3: сопоставлен с лицом по позиции в проходе оборотов.',
    );
    expect(noteOf(t, page({ addedSet: 2, sheet: null }), 'assembled', false)).toContain(
      'Страница добавленного набора',
    );
  });
});
