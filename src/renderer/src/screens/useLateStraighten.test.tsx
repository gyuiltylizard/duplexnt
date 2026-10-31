import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AssembledPage, StraightenFact } from '@shared';
import { F1, F2, makePass, makeSnapshot, pages } from './editor-fixture';
import { useLateStraighten } from './useLateStraighten';

// Тост пересчёта после смены версии геометрии или детектора (M6, U9; AE13; B-19): страница с
// файлом прежних версий показана без «ждёт» и входит в порцию как пересчёт по признаку ядра
// `recalc`; тост — один, когда ни ждущих, ни пересчёта в ходу не осталось; отложенный пересчёт
// порцию не держит. Констант версий хук не знает — подмены модулей нет. Порции по `pending` — в
// `EditorScreen.straighten.test.tsx`.

/** Факт файла: прежних версий (`stale`) или текущих; без файла — `version: null`. */
const fact = (
  version: number | null,
  outcome: StraightenFact['outcome'] = 'willStraighten',
  deferred: StraightenFact['deferred'] = null,
  stale = false,
): StraightenFact => ({
  outcome,
  version,
  detector: version === null ? null : 1,
  stale,
  deferred,
  cause: null,
});

/** Файл прежних версий без исхода: пересчёт ждёт. */
const old = (deferred: StraightenFact['deferred'] = null): StraightenFact =>
  fact(1, deferred === null ? null : 'willStraighten', deferred, true);
/** Файл текущих версий — пересчёт закончен. */
const fresh = (): StraightenFact => fact(1);

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

describe('поздние статусы: пересчёт файлов прежних версий (M6, AE13; B-19)', () => {
  it('прежние версии без «ждёт» — порция; один тост «пересчитано», когда пересчёт всех закончен; повтор снимка — без тоста', () => {
    const start = orderOf([
      [F1, old()],
      [F2, old()],
    ]);
    const { onLate, rerender } = mount(start);
    expect(onLate).not.toHaveBeenCalled();
    expect(start.map((page) => page.straighten)).toMatchObject([
      { status: 'straightened', recalc: 'pending' },
      { status: 'straightened', recalc: 'pending' },
    ]);

    rerender(
      orderOf([
        [F1, fresh()],
        [F2, old()],
      ]),
    );
    expect(onLate).not.toHaveBeenCalled();

    const done = orderOf([
      [F1, fresh()],
      [F2, fresh()],
    ]);
    rerender(done);
    expect(onLate).toHaveBeenCalledExactlyOnceWith(0, true);
    rerender([...done]);
    expect(onLate).toHaveBeenCalledTimes(1);
  });

  it('прежняя версия после пересчёта оказалась ровной — порция закончена; впервые выровненная в той же порции считается', () => {
    const { onLate, rerender } = mount(
      orderOf([
        [F1, old()],
        [F2, fact(null, null)],
      ]),
    );
    rerender(
      orderOf([
        [F1, fact(null, 'level')],
        [F2, fresh()],
      ]),
    );
    expect(onLate).toHaveBeenCalledExactlyOnceWith(1, true);
  });

  it('пересчёт отложен (мало места) — порцию не держит и из неё выходит: ждущая страница закрывает порцию «выровнено ещё 1»', () => {
    const { onLate, rerender } = mount(
      orderOf([
        [F1, old()],
        [F2, fact(null, null)],
      ]),
    );
    rerender(
      orderOf([
        [F1, old('noSpace')],
        [F2, fact(null, null)],
      ]),
    );
    expect(onLate).not.toHaveBeenCalled();
    const settled = orderOf([
      [F1, old('noSpace')],
      [F2, fresh()],
    ]);
    expect(settled[0]?.straighten).toMatchObject({ status: 'straightened', recalc: 'disk' });
    rerender(settled);
    // Отложенная не считается пересчётом: текст без «пересчитано».
    expect(onLate).toHaveBeenCalledExactlyOnceWith(1, false);
  });

  it('порция из одних отложенных — тоста нет; снятие отсрочки позже даёт свой тост', () => {
    const { onLate, rerender } = mount(
      orderOf([
        [F1, old()],
        [F2, old()],
      ]),
    );
    rerender(
      orderOf([
        [F1, old('noSpace')],
        [F2, old('failed')],
      ]),
    );
    expect(onLate).not.toHaveBeenCalled();

    // Место появилось: пересчёт пошёл снова — новая порция, тост по её концу.
    rerender(
      orderOf([
        [F1, old()],
        [F2, old('failed')],
      ]),
    );
    rerender(
      orderOf([
        [F1, fresh()],
        [F2, old('failed')],
      ]),
    );
    expect(onLate).toHaveBeenCalledExactlyOnceWith(0, true);
  });

  it('смешанная порция: пересчёт и впервые выровненная — «пересчитано», счёт только впервые выровненных', () => {
    const { onLate, rerender } = mount(
      orderOf([
        [F1, old()],
        [F2, fact(null, 'willStraighten')],
      ]),
    );
    rerender(
      orderOf([
        [F1, fresh()],
        [F2, fresh()],
      ]),
    );
    expect(onLate).toHaveBeenCalledExactlyOnceWith(1, true);
  });

  it('файл текущих версий без исхода (кэш оценок потерян, AE8) — не пересчёт: порции нет', () => {
    const { onLate, rerender } = mount(
      orderOf([
        [F1, fact(1, null)],
        [F2, fact(1, null)],
      ]),
    );
    rerender(
      orderOf([
        [F1, fresh()],
        [F2, fresh()],
      ]),
    );
    expect(onLate).not.toHaveBeenCalled();
  });
});
