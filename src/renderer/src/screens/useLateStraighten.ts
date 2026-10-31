import { useEffect, useEffectEvent, useState } from 'react';
import type { AssembledPage, StraightenMark, StraightenStatus } from '@shared';

// Поздние статусы выравнивания (план M6, U8; handoff M6 «Тост поздних изменений»; B-19): порция
// — страницы, вставшие в обработку уже в `editor` (досканирование, поздняя коррекция) или бывшие
// в ней при входе; один тост на порцию, когда в ней не осталось ни «ждёт», ни пересчёта в ходу,
// — статусы приходят по одному, и тост на каждый шёл бы подряд. Считаются только страницы,
// выровненные впервые: страница, ушедшая в пересчёт уже выровненной и вернувшаяся такой же, — не
// «ещё». Пересчёт (в обработку встала страница со статусом) даёт текст «пересчитано» и при нуле
// новых. Пересчёт после обновления приложения (AE13, U9; B-19): страница с файлом прежних версий
// показывает прежний вид без «ждёт», а ядро ставит ей `recalc: 'pending'` — она входит в порцию
// как пересчёт; `recalc` `'disk'` / `'fail'` — пересчёт отложен: такая страница порцию не держит и
// выходит из неё (AE15: отложенные не блокируют и не шумят); порция из одних отложенных тоста не
// даёт. Констант версий renderer не знает — признак от ядра. Правки — откат и его undo — в
// обработку не ведут: тоста нет (урок M4 про ложные тосты при undo). Корректировка состояния при
// рендере, тост — эффектом по номеру события (как `useLateHidden`).

interface Entry {
  /** Статус до обработки; `undefined` — страницы раньше не было или она ждала при входе. */
  readonly before: StraightenStatus | undefined;
  /** В обработку встала страница, уже имевшая статус или файл прежних версий, — пересчёт. */
  readonly recalc: boolean;
}

interface Watch {
  /** Лента, по которой состояние посчитано: новая ссылка — новый снимок. */
  readonly order: readonly AssembledPage[];
  readonly marks: ReadonlyMap<string, StraightenMark>;
  readonly batch: ReadonlyMap<string, Entry>;
  /** Номер события «порция закончилась»; растёт на каждый тост. */
  readonly event: number;
  readonly count: number;
  readonly eventRecalc: boolean;
}

const marksOf = (order: readonly AssembledPage[]): ReadonlyMap<string, StraightenMark> =>
  new Map(order.map((page) => [page.key, page.straighten]));

/** Пересчёт файла прежних версий идёт или ждёт очереди (AE13): прежний вид показан. */
const recalcPending = (mark: StraightenMark): boolean => mark.recalc === 'pending';

/** Пересчёт отложен — мало места или сбой: порцию не держит, из порции выходит. */
const recalcDeferred = (mark: StraightenMark | undefined): boolean =>
  mark?.recalc === 'disk' || mark?.recalc === 'fail';

/** Порция не закончена: кто-то ждёт или пересчитывается. */
const unsettled = (marks: ReadonlyMap<string, StraightenMark>): boolean =>
  [...marks.values()].some((mark) => mark.status === 'pending' || recalcPending(mark));

function initialWatch(order: readonly AssembledPage[]): Watch {
  const marks = marksOf(order);
  const batch = new Map<string, Entry>();
  for (const [key, mark] of marks) {
    if (mark.status === 'pending') {
      batch.set(key, { before: undefined, recalc: false });
    } else if (recalcPending(mark)) {
      batch.set(key, { before: mark.status, recalc: true });
    }
  }
  return { order, marks, batch, event: 0, count: 0, eventRecalc: false };
}

function nextWatch(watch: Watch, order: readonly AssembledPage[]): Watch {
  const marks = marksOf(order);
  let batch = new Map(watch.batch);
  for (const [key, mark] of marks) {
    if (batch.has(key)) {
      continue;
    }
    const before = watch.marks.get(key);
    if (mark.status === 'pending' && before?.status !== 'pending') {
      batch.set(key, {
        before: before?.status,
        recalc: before !== undefined && before.status !== null,
      });
    } else if (recalcPending(mark) && (before === undefined || !recalcPending(before))) {
      batch.set(key, { before: before?.status ?? mark.status, recalc: true });
    }
  }
  let { event, count, eventRecalc } = watch;
  if (batch.size > 0 && !unsettled(marks)) {
    let fresh = 0;
    let recalc = false;
    for (const [key, entry] of batch) {
      const mark = marks.get(key);
      if (recalcDeferred(mark)) {
        continue;
      }
      if (mark?.status === 'straightened' && entry.before !== 'straightened') {
        fresh += 1;
      }
      recalc ||= entry.recalc;
    }
    if (fresh > 0 || recalc) {
      event += 1;
      count = fresh;
      eventRecalc = recalc;
    }
    batch = new Map();
  }
  return { order, marks, batch, event, count, eventRecalc };
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
