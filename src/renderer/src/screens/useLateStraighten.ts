import { useEffect, useEffectEvent, useState } from 'react';
import type { AssembledPage, StraightenStatus } from '@shared';

// Поздние статусы выравнивания (план M6, U8; handoff M6 «Тост поздних изменений»): порция —
// страницы, вставшие в обработку уже в `editor` (досканирование, поздняя коррекция, пересчёт
// после обновления приложения) или бывшие в ней при входе; один тост на порцию, когда в ней не
// осталось `pending`, — статусы приходят по одному, и тост на каждый шёл бы подряд. Считаются
// только страницы, выровненные впервые: страница, ушедшая в пересчёт уже выровненной и
// вернувшаяся такой же, — не «ещё». Пересчёт (в обработку встала страница со статусом) даёт
// текст «пересчитано» и при нуле новых. Правки — откат и его undo — в обработку не ведут: тоста
// нет (урок M4 про ложные тосты при undo). Корректировка состояния при рендере, тост — эффектом
// по номеру события (как `useLateHidden`).

interface Watch {
  /** Лента, по которой состояние посчитано: новая ссылка — новый снимок. */
  readonly order: readonly AssembledPage[];
  readonly statuses: ReadonlyMap<string, StraightenStatus>;
  /** Порция: ключ → статус до обработки; `undefined` — страницы раньше не было или она ждала при входе. */
  readonly batch: ReadonlyMap<string, StraightenStatus | undefined>;
  /** В порции есть пересчёт: в обработку встала страница, уже имевшая статус. */
  readonly recalc: boolean;
  /** Номер события «порция закончилась»; растёт на каждый тост. */
  readonly event: number;
  readonly count: number;
  readonly eventRecalc: boolean;
}

const statusesOf = (order: readonly AssembledPage[]): ReadonlyMap<string, StraightenStatus> =>
  new Map(order.map((page) => [page.key, page.straighten.status]));

const anyPending = (statuses: ReadonlyMap<string, StraightenStatus>): boolean =>
  [...statuses.values()].includes('pending');

function initialWatch(order: readonly AssembledPage[]): Watch {
  const statuses = statusesOf(order);
  const batch = new Map<string, StraightenStatus | undefined>();
  for (const [key, status] of statuses) {
    if (status === 'pending') {
      batch.set(key, undefined);
    }
  }
  return { order, statuses, batch, recalc: false, event: 0, count: 0, eventRecalc: false };
}

function nextWatch(watch: Watch, order: readonly AssembledPage[]): Watch {
  const statuses = statusesOf(order);
  let batch = new Map(watch.batch);
  let { recalc } = watch;
  for (const [key, status] of statuses) {
    const before = watch.statuses.get(key);
    if (status === 'pending' && before !== 'pending' && !batch.has(key)) {
      batch.set(key, before);
      if (before !== undefined && before !== null) {
        recalc = true;
      }
    }
  }
  let { event, count, eventRecalc } = watch;
  if (batch.size > 0 && !anyPending(statuses)) {
    let fresh = 0;
    for (const [key, before] of batch) {
      if (statuses.get(key) === 'straightened' && before !== 'straightened') {
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
  return { order, statuses, batch, recalc, event, count, eventRecalc };
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
