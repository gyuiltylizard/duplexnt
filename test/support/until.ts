import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';
import type { Snapshot } from '../../src/shared';

/** Ждёт условия, а не времени: под нагрузкой фиксированная пауза промахивается. */
export async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000 && !condition(); attempt += 1) {
    await delay(5);
  }
  expect(condition()).toBe(true);
}

/**
 * Ждёт оценок пустых оборотов (M4, KTD4, KTD6): запись PDF при незавершённых оценках ядро
 * отклоняет (`blankPending`), renderer в это время держит экран `merge`.
 */
export const untilScored = (snapshot: () => Snapshot): Promise<void> =>
  until(() => (snapshot().assembly?.blank.pending ?? 0) === 0);
