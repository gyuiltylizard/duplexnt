import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AssembledPage, StraightenFact } from '@shared';
import { F1, F2, makePass, makeSnapshot, pages } from './editor-fixture';
import { useLateStraighten } from './useLateStraighten';

// Тост пересчёта после смены версии геометрии (M6, U9; AE13): страница с файлом прежней версии
// показана без «ждёт» и входит в порцию как пересчёт; тост — один, когда ни ждущих, ни прежних
// версий не осталось. Версия подменяется модулем: продуктовая — 1, прежних у неё нет. Порции по
// `pending` — в `EditorScreen.straighten.test.tsx`.

vi.mock('@shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared')>()),
  STRAIGHTEN_GEOMETRY_VERSION: 2,
}));

const fact = (
  version: number | null,
  outcome: StraightenFact['outcome'] = 'willStraighten',
  deferred: StraightenFact['deferred'] = null,
): StraightenFact => ({
  outcome,
  version,
  detector: version === null ? null : 1,
  stale: false,
  deferred,
  cause: null,
});

const orderOf = (facts: readonly (readonly [string, StraightenFact])[]): readonly AssembledPage[] =>
  makeSnapshot(
    [makePass({ pages: pages(2) })],
    {},
    { straighten: 'auto' },
    undefined,
    new Map(facts),
  ).assembly?.order ?? [];

function mount(order: readonly AssembledPage[]) {
  const onLate = vi.fn<(count: number, recalc: boolean) => void>();
  const hook = renderHook(
    (props: { readonly order: readonly AssembledPage[] }) => {
      useLateStraighten({ order: props.order, onLate });
    },
    { initialProps: { order } },
  );
  return {
    onLate,
    rerender: (next: readonly AssembledPage[]): void => {
      hook.rerender({ order: next });
    },
  };
}

describe('поздние статусы: пересчёт после смены версии геометрии (M6, AE13)', () => {
  it('прежняя версия без «ждёт» — порция; один тост «пересчитано», когда прежних не осталось; повтор снимка — без тоста', () => {
    const { onLate, rerender } = mount(
      orderOf([
        [F1, fact(1)],
        [F2, fact(1)],
      ]),
    );
    expect(onLate).not.toHaveBeenCalled();
    expect(orderOf([[F1, fact(1)]])[0]?.straighten.status).toBe('straightened');

    rerender(
      orderOf([
        [F1, fact(2)],
        [F2, fact(1)],
      ]),
    );
    expect(onLate).not.toHaveBeenCalled();

    const done = orderOf([
      [F1, fact(2)],
      [F2, fact(2)],
    ]);
    rerender(done);
    expect(onLate).toHaveBeenCalledExactlyOnceWith(0, true);
    rerender([...done]);
    expect(onLate).toHaveBeenCalledTimes(1);
  });

  it('прежняя версия после пересчёта оказалась ровной — порция закончена; впервые выровненная в той же порции считается', () => {
    const { onLate, rerender } = mount(
      orderOf([
        [F1, fact(1)],
        [F2, fact(null, null)],
      ]),
    );
    rerender(
      orderOf([
        [F1, fact(null, 'level')],
        [F2, fact(2)],
      ]),
    );
    expect(onLate).toHaveBeenCalledExactlyOnceWith(1, true);
  });

  it('пересчёт прежней версии отложен (мало места) — порция не закончена, тоста нет', () => {
    const { onLate, rerender } = mount(
      orderOf([
        [F1, fact(1)],
        [F2, fact(1)],
      ]),
    );
    rerender(
      orderOf([
        [F1, fact(2)],
        [F2, fact(1, 'willStraighten', 'noSpace')],
      ]),
    );
    expect(onLate).not.toHaveBeenCalled();
  });
});
