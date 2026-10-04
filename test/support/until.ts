import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';

/** Ждёт условия, а не времени: под нагрузкой фиксированная пауза промахивается. */
export async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000 && !condition(); attempt += 1) {
    await delay(5);
  }
  expect(condition()).toBe(true);
}
