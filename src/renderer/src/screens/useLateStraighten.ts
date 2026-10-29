import { useEffect, useEffectEvent, useState } from 'react';
import {
  STRAIGHTEN_GEOMETRY_VERSION,
  type AssembledPage,
  type StraightenMark,
  type StraightenStatus,
} from '@shared';

// Поздние статусы выравнивания (план M6, U8; handoff M6 «Тост поздних изменений»): порция —
// страницы, вставшие в обработку уже в `editor` (досканирование, поздняя коррекция) или бывшие
// в ней при входе; один тост на порцию, когда в ней не осталось `pending`, — статусы приходят по
// одному, и тост на каждый шёл бы подряд. Считаются только страницы, выровненные впервые:
// страница, ушедшая в пересчёт уже выровненной и вернувшаяся такой же, — не «ещё». Пересчёт (в
// обработку встала страница со статусом) даёт текст «пересчитано» и при нуле новых. Пересчёт
// после обновления приложения (AE13, U9): страница с файлом прежней версии геометрии показывает
// прежний вид без «ждёт» — она тоже входит в порцию как пересчёт, а порция закончена, когда не
// осталось ни ждущих, ни прежних версий. Правки — откат и его undo — в обработку не ведут:
// тоста нет (урок M4 про ложные тосты при undo). Корректировка состояния при рендере, тост —
// эффектом по номеру события (как `useLateHidden`).

interface Watch {
  /** Лента, по которой состояние посчитано: новая ссылка — новый снимок. */
  readonly order: readonly AssembledPage[];
  readonly marks: ReadonlyMap<string, StraightenMark>;
  /** Порция: ключ → статус до обработки; `undefined` — страницы раньше не было или она ждала при входе. */
  readonly batch: ReadonlyMap<string, StraightenStatus | undefined>;
  /** В порции есть пересчёт: в обработку встала страница, уже имевшая статус. */
  readonly recalc: boolean;
  /** Номер события «порция закончилась»; растёт на каждый тост. */
  readonly event: number;
  readonly count: number;
  readonly eventRecalc: boolean;
}

const marksOf = (order: readonly AssembledPage[]): ReadonlyMap<string, StraightenMark> =>
  new Map(order.map((page) => [page.key, page.straighten]));

/** Файл прежней версии геометрии: пересчёт идёт фоном, прежний вид показан (AE13). */
const stale = (mark: StraightenMark): boolean =>
  mark.version !== null && mark.version < STRAIGHTEN_GEOMETRY_VERSION;

/** Порция не закончена: кто-то ждёт или показан прежней версией. */
const unsettled = (marks: ReadonlyMap<string, StraightenMark>): boolean =>
  [...marks.values()].some((mark) => mark.status === 'pending' || stale(mark));

function initialWatch(order: readonly AssembledPage[]): Watch {
  const marks = marksOf(order);
  const batch = new Map<string, StraightenStatus | undefined>();
  let recalc = false;
  for (const [key, mark] of marks) {
    if (mark.status === 'pending') {
      batch.set(key, undefined);
    } else if (stale(mark)) {
      batch.set(key, mark.status);
      recalc = true;
    }
  }
  return { order, marks, batch, recalc, event: 0, count: 0, eventRecalc: false };
}

function nextWatch(watch: Watch, order: readonly AssembledPage[]): Watch {
  const marks = marksOf(order);
  let batch = new Map(watch.batch);
  let { recalc } = watch;
  for (const [key, mark] of marks) {
    if (batch.has(key)) {
      continue;
    }
    const before = watch.marks.get(key);
    if (mark.status === 'pending' && before?.status !== 'pending') {
      batch.set(key, before?.status);
      if (before !== undefined && before.status !== null) {
        recalc = true;
      }
    } else if (stale(mark) && (before === undefined || !stale(before))) {
      batch.set(key, before?.status ?? mark.status);
      recalc = true;
    }
  }
  let { event, count, eventRecalc } = watch;
  if (batch.size > 0 && !unsettled(marks)) {
    let fresh = 0;
    for (const [key, before] of batch) {
      if (marks.get(key)?.status === 'straightened' && before !== 'straightened') {
        fresh += 1;
      }
    }
    if (fresh > 0 || recalc) {
      event += 1;
      count = fresh;
      eventRecalc = recalc;
    }
    batch = new Map();
    recalc = false;
  }
  return { order, marks, batch, recalc, event, count, eventRecalc };
}

export function useLateStraighten({
  order,
  onLate,
}: {
  /** Полная видимая лента снимка. */
  readonly order: readonly AssembledPage[];
  /** Порция закончилась: сколько выровнено впервые и был ли в ней пересчёт. */
  readonly onLate: (count: number, recalc: boolean) => void;
}): void {
  const [watch, setWatch] = useState<Watch>(() => initialWatch(order));
  if (watch.order !== order) {
    setWatch(nextWatch(watch, order));
  }
  const announce = useEffectEvent((count: number, recalc: boolean) => {
    onLate(count, recalc);
  });
  useEffect(() => {
    if (watch.event > 0) {
      announce(watch.count, watch.eventRecalc);
    }
  }, [watch.event, watch.count, watch.eventRecalc]);
}
