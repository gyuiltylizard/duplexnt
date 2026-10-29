// Ограничение одновременных задач для производного (миниатюры, оценки пустых страниц, измерение
// перекоса): освободившееся место передаётся ждущему напрямую, порядок — очереди. Очередей две
// (план M6, U5; KTD-4): `normal` — то, что человек ждёт глазами (миниатюры, вердикты пустоты),
// `low` — измерение перекоса по ходу прохода; `low` стартует, только когда `normal` пуста. Один
// экземпляр на всё производное main-стороны: три отдельных лимитера дали бы до шести декодов
// разом на пуле libuv рядом с `fsync` приёма страницы.

export type LimiterPriority = 'normal' | 'low';

export type Limiter = <T>(task: () => Promise<T>, priority?: LimiterPriority) => Promise<T>;

/** Не больше `concurrency` задач одновременно; меньше одной не бывает. */
export function limiterOf(concurrency: number): Limiter {
  const limit = Math.max(1, concurrency);
  let active = 0;
  const waiting: Record<LimiterPriority, (() => void)[]> = { normal: [], low: [] };
  const nextWaiting = (): (() => void) | undefined => waiting.normal.shift() ?? waiting.low.shift();
  return async (task, priority = 'normal') => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting[priority].push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = nextWaiting();
      if (next === undefined) {
        active -= 1;
      } else {
        next();
      }
    }
  };
}
