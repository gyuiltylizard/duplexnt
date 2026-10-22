// Ограничение одновременных задач для производного (миниатюры, оценки пустых страниц):
// освободившееся место передаётся ждущему напрямую, порядок — очереди.

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Не больше `concurrency` задач одновременно; меньше одной не бывает. */
export function limiterOf(concurrency: number): Limiter {
  const limit = Math.max(1, concurrency);
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) {
        active -= 1;
      } else {
        next();
      }
    }
  };
}
