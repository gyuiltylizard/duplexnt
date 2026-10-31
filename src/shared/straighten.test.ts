import { describe, expect, it } from 'vitest';
import {
  NO_STRAIGHTEN,
  NO_STRAIGHTEN_MARK,
  pageImageViewOf,
  straightenMarkOf,
  straightenSummaryOf,
  type StraightenFact,
  type StraightenMark,
  type StraightenMarkInput,
} from './straighten';

// Статус страницы и сводка (план M6, U12; KTD-9): одно правило на ядро и зеркало renderer'а.
// Табличный тест режим × факты × откат; `null` в сводку не входит, отложенные — не «ждут».

/** Факт; у «есть файл» детектор — 1 и файл текущий, если не задано иное. */
const fact = (overrides: Partial<StraightenFact> = {}): StraightenFact => ({
  outcome: null,
  version: null,
  detector: overrides.version === undefined || overrides.version === null ? null : 1,
  stale: false,
  deferred: null,
  cause: null,
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

const mark = (
  status: StraightenMark['status'],
  reason: StraightenMark['reason'] = null,
  version: number | null = null,
  recalc: StraightenMark['recalc'] = null,
): StraightenMark => ({ status, reason, version, detector: version === null ? null : 1, recalc });

describe('статус страницы (KTD-9)', () => {
  it.each<[string, StraightenMarkInput, StraightenMark]>([
    [
      'режим «не выравнивать» — null при любых фактах',
      input({ mode: 'off', fact: fact({ outcome: 'willStraighten', version: 1 }) }),
      NO_STRAIGHTEN_MARK,
    ],
    [
      'потерянная — null',
      input({ lost: true, fact: fact({ outcome: 'level' }) }),
      NO_STRAIGHTEN_MARK,
    ],
    [
      'пустой оборот — null, даже измеренный',
      input({ blank: true, fact: fact({ outcome: 'willStraighten', version: 1 }) }),
      NO_STRAIGHTEN_MARK,
    ],
    ['фактов нет — ждёт', input(), mark('pending')],
    [
      'файл есть, исхода нет (кэш оценок потерян или версия геометрии сменилась) — выправлена прежним файлом, измерение фоном (AE8, AE13)',
      input({ fact: fact({ version: 1 }) }),
      mark('straightened', null, 1),
    ],
    [
      'файл есть, исхода нет, откат пользователя — оригинал оставлен',
      input({ keepOriginal: true, fact: fact({ version: 1 }) }),
      mark('kept', null, 1),
    ],
    [
      'не по чему мерить',
      input({ fact: fact({ outcome: 'unmeasurable' }) }),
      mark('unmeasurable', 'measure'),
    ],
    [
      'строки есть, но наклон не сходится в одну форму',
      input({ fact: fact({ outcome: 'unmeasurable', cause: 'shape' }) }),
      mark('unmeasurable', 'shape'),
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
      'выправлять, файл есть — выправлена с версией файла',
      input({ fact: fact({ outcome: 'willStraighten', version: 3 }) }),
      mark('straightened', null, 3),
    ],
    [
      'выправлена, откат пользователя — оригинал оставлен',
      input({ keepOriginal: true, fact: fact({ outcome: 'willStraighten', version: 1 }) }),
      mark('kept', null, 1),
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
      'отложена, но файл текущих версий есть — выправлена без пересчёта',
      input({ fact: fact({ outcome: 'willStraighten', version: 1, deferred: 'failed' }) }),
      mark('straightened', null, 1),
    ],
    [
      'файл прежних версий без исхода — выправлена, пересчёт ждёт (AE13; B-19)',
      input({ fact: fact({ version: 1, stale: true }) }),
      mark('straightened', null, 1, 'pending'),
    ],
    [
      'файл прежних версий, выправлять, в очереди — пересчёт ждёт',
      input({ fact: fact({ outcome: 'willStraighten', version: 1, stale: true }) }),
      mark('straightened', null, 1, 'pending'),
    ],
    [
      'файл прежних версий, пересчёт отложен: мало места',
      input({
        fact: fact({ outcome: 'willStraighten', version: 1, stale: true, deferred: 'noSpace' }),
      }),
      mark('straightened', null, 1, 'disk'),
    ],
    [
      'файл прежних версий, пересчёт отложен: сбой',
      input({
        fact: fact({ outcome: 'willStraighten', version: 1, stale: true, deferred: 'failed' }),
      }),
      mark('straightened', null, 1, 'fail'),
    ],
    [
      'файл прежних версий, откат пользователя — оригинал оставлен, пересчёт ждёт',
      input({ keepOriginal: true, fact: fact({ version: 1, stale: true }) }),
      mark('kept', null, 1, 'pending'),
    ],
    [
      'файл прежних версий, но новый вердикт «ровная» — ровная, файла в пометке нет',
      input({ fact: fact({ outcome: 'level', version: 1, stale: true }) }),
      mark('level'),
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
      reasons: { measure: 1, shape: 0, nohelp: 1, disk: 1, fail: 0 },
    });
  });

  it('вид картинки: выправленный — только у «выправлена» с версией; остальным и странице прохода — оригинал', () => {
    const page = (status: StraightenMark['status'], version: number | null = 1) => ({
      key: 'p01-s01-0001',
      straighten: mark(status, null, version),
    });
    expect(pageImageViewOf(page('straightened', 2), 'page')).toEqual({
      view: 'straight',
      key: 'p01-s01-0001',
      version: 2,
      detector: 1,
    });
    expect(pageImageViewOf(page('straightened', 2), 'thumb').view).toBe('straight-thumb');
    expect(pageImageViewOf(page('straightened', null), 'thumb').view).toBe('thumb');
    for (const status of ['kept', 'level', 'pending', 'deferred', 'unmeasurable', null] as const) {
      expect(pageImageViewOf(page(status), 'page'), String(status)).toEqual({
        view: 'page',
        key: 'p01-s01-0001',
        version: null,
        detector: null,
      });
    }
    expect(pageImageViewOf({ key: 'p01-s01-0001' }, 'thumb').view).toBe('thumb');
  });

  it('пустая лента и режим «не выравнивать» — нули', () => {
    expect(straightenSummaryOf('off', [NO_STRAIGHTEN_MARK])).toEqual(NO_STRAIGHTEN);
    expect(straightenSummaryOf('auto', [])).toEqual({ ...NO_STRAIGHTEN, mode: 'auto' });
  });
});
