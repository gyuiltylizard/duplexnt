import { describe, expect, it } from 'vitest';
import { limiterOf } from './limiter';

// Лимитер производного с двумя очередями (план M6, U5; KTD-4): `low` стартует, только когда
// `normal` пуста; предел — суммарный.

/** Задача, которая держится до `release`, и след её старта в общем списке. */
function held(log: string[], name: string) {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const task = async (): Promise<string> => {
    log.push(`start ${name}`);
    await gate;
    log.push(`end ${name}`);
    return name;
  };
  return {
    task,
    release: (): void => {
      release();
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('лимитер производного', () => {
  it('не больше заданного числа задач разом; меньше одной не бывает', async () => {
    const limited = limiterOf(0);
    const log: string[] = [];
    const a = held(log, 'a');
    const b = held(log, 'b');
    const pa = limited(a.task);
    const pb = limited(b.task);
    await tick();
    expect(log).toEqual(['start a']);
    a.release();
    await pa;
    await tick();
    expect(log).toEqual(['start a', 'end a', 'start b']);
    b.release();
    expect(await pb).toBe('b');
  });

  it('`low` ждёт, пока очередь `normal` не опустеет, даже если встала раньше', async () => {
    const limited = limiterOf(1);
    const log: string[] = [];
    const first = held(log, 'first');
    const low = held(log, 'low');
    const normal = held(log, 'normal');
    const pFirst = limited(first.task);
    const pLow = limited(low.task, 'low');
    const pNormal = limited(normal.task);
    await tick();
    expect(log).toEqual(['start first']);

    first.release();
    await pFirst;
    await tick();
    expect(log).toEqual(['start first', 'end first', 'start normal']);

    normal.release();
    await pNormal;
    await tick();
    expect(log.at(-1)).toBe('start low');
    low.release();
    expect(await pLow).toBe('low');
  });

  it('предел суммарный: две `low` занимают оба места, пока `normal` нет', async () => {
    const limited = limiterOf(2);
    const log: string[] = [];
    const l1 = held(log, 'l1');
    const l2 = held(log, 'l2');
    const l3 = held(log, 'l3');
    const n = held(log, 'n');
    const all = [limited(l1.task, 'low'), limited(l2.task, 'low'), limited(l3.task, 'low')];
    await tick();
    expect(log).toEqual(['start l1', 'start l2']);
    const pn = limited(n.task);
    await tick();
    expect(log).toHaveLength(2);

    // Освободилось место — первой идёт `normal`, не третья `low`.
    l1.release();
    await all[0];
    await tick();
    expect(log.at(-1)).toBe('start n');
    n.release();
    await pn;
    await tick();
    expect(log.at(-1)).toBe('start l3');
    l2.release();
    l3.release();
    await Promise.all(all);
  });

  it('отказ задачи освобождает место и пробрасывается', async () => {
    const limited = limiterOf(1);
    const failing = limited(() => Promise.reject(new Error('сбой')));
    await expect(failing).rejects.toThrow('сбой');
    expect(await limited(() => Promise.resolve('дальше'))).toBe('дальше');
  });
});
