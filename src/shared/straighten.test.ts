import { describe, expect, it } from 'vitest';
import {
  NO_STRAIGHTEN,
  NO_STRAIGHTEN_MARK,
  straightenMarkOf,
  straightenSummaryOf,
  type StraightenFact,
  type StraightenMark,
  type StraightenMarkInput,
} from './straighten';

// Статус страницы и сводка (план M6, U12; KTD-9): одно правило на ядро и зеркало renderer'а.
// Табличный тест режим × факты × откат; `null` в сводку не входит, отложенные — не «ждут».

const fact = (overrides: Partial<StraightenFact> = {}): StraightenFact => ({
  outcome: null,
  corrected: false,
  deferred: null,
  ...overrides,
});

const input = (overrides: Partial<StraightenMarkInput> = {}): StraightenMarkInput => ({
  mode: 'auto',
  lost: false,
  blank: false,
  keepOriginal: false,
  fact: undefined,
  ...overrides,
});

const mark = (status: StraightenMark['status'], reason: StraightenMark['reason'] = null) => ({
  status,
  reason,
});

describe('статус страницы (KTD-9)', () => {
  it.each<[string, StraightenMarkInput, StraightenMark]>([
    [
      'режим «не выравнивать» — null при любых фактах',
      input({ mode: 'off', fact: fact({ outcome: 'willStraighten', corrected: true }) }),
      NO_STRAIGHTEN_MARK,
    ],
    [
      'потерянная — null',
      input({ lost: true, fact: fact({ outcome: 'level' }) }),
      NO_STRAIGHTEN_MARK,
    ],
    [
      'пустой оборот — null, даже измеренный',
      input({ blank: true, fact: fact({ outcome: 'willStraighten', corrected: true }) }),
      NO_STRAIGHTEN_MARK,
    ],
    ['фактов нет — ждёт', input(), mark('pending')],
    [
      'файл есть, исхода нет (кэш оценок потерян) — ждёт измерения',
      input({ fact: fact({ corrected: true }) }),
      mark('pending'),
    ],
    [
      'не по чему мерить',
      input({ fact: fact({ outcome: 'unmeasurable' }) }),
      mark('unmeasurable', 'measure'),
    ],
    [
      'коррекция не помогла',
      input({ fact: fact({ outcome: 'notImproved' }) }),
      mark('unmeasurable', 'nohelp'),
    ],
    ['ровная', input({ fact: fact({ outcome: 'level' }) }), mark('level')],
    [
      'выправлять, файла ещё нет — ждёт',
      input({ fact: fact({ outcome: 'willStraighten' }) }),
      mark('pending'),
    ],
    [
      'выправлять, файл есть — выправлена',
      input({ fact: fact({ outcome: 'willStraighten', corrected: true }) }),
      mark('straightened'),
    ],
    [
      'выправлена, откат пользователя — оригинал оставлен',
      input({ keepOriginal: true, fact: fact({ outcome: 'willStraighten', corrected: true }) }),
      mark('kept'),
    ],
    [
      'откат без файла не действует: ждёт',
      input({ keepOriginal: true, fact: fact({ outcome: 'willStraighten' }) }),
      mark('pending'),
    ],
    [
      'откат на ровной не действует',
      input({ keepOriginal: true, fact: fact({ outcome: 'level' }) }),
      mark('level'),
    ],
    [
      'отложена: мало места',
      input({ fact: fact({ outcome: 'willStraighten', deferred: 'noSpace' }) }),
      mark('deferred', 'disk'),
    ],
    [
      'отложена: сбой',
      input({ fact: fact({ outcome: 'willStraighten', deferred: 'failed' }) }),
      mark('deferred', 'fail'),
    ],
    [
      'отложена, но файл прежней версии есть — выправлена',
      input({ fact: fact({ outcome: 'willStraighten', corrected: true, deferred: 'failed' }) }),
      mark('straightened'),
    ],
  ])('%s', (_name, given, expected) => {
    expect(straightenMarkOf(given)).toEqual(expected);
  });
});

describe('сводка по ленте', () => {
  it('считает статусы и причины; null не входит; отложенные не «ждут»', () => {
    const marks: StraightenMark[] = [
      mark('straightened'),
      mark('straightened'),
      mark('kept'),
      mark('level'),
      mark('unmeasurable', 'measure'),
      mark('unmeasurable', 'nohelp'),
      mark('deferred', 'disk'),
      mark('pending'),
      NO_STRAIGHTEN_MARK,
    ];
    expect(straightenSummaryOf('auto', marks)).toEqual({
      mode: 'auto',
      straightened: 2,
      kept: 1,
      level: 1,
      unmeasurable: 2,
      deferred: 1,
      pending: 1,
      total: 8,
      reasons: { measure: 1, nohelp: 1, disk: 1, fail: 0 },
    });
  });

  it('пустая лента и режим «не выравнивать» — нули', () => {
    expect(straightenSummaryOf('off', [NO_STRAIGHTEN_MARK])).toEqual(NO_STRAIGHTEN);
    expect(straightenSummaryOf('auto', [])).toEqual({ ...NO_STRAIGHTEN, mode: 'auto' });
  });
});
