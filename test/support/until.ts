import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'vitest';
import type { Snapshot } from '../../src/shared';

/**
 * Ждёт условия, а не времени: под нагрузкой фиксированная пауза промахивается. `attempts` —
 * по 5 мс; по умолчанию 10 с.
 */
export async function until(condition: () => boolean, attempts = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts && !condition(); attempt += 1) {
    await delay(5);
  }
  expect(condition()).toBe(true);
}

/**
 * Ждёт оценок пустых оборотов (M4, KTD4, KTD6) и выравнивания (M6, KTD-8): запись PDF при
 * незавершённых ядро отклоняет (`blankPending`, `straightenPending`), renderer в это время
 * держит экран `merge`.
 */
export const untilScored = (snapshot: () => Snapshot): Promise<void> =>
  until(() => {
    const assembly = snapshot().assembly;
    return (assembly?.blank.pending ?? 0) === 0 && (assembly?.straighten.pending ?? 0) === 0;
  });

/**
 * Ждёт конца измерений и коррекции (M6, U9): настоящий исполнитель на эмуляторе тратит до
 * секунды на страницу, поэтому бюджет — 40 с.
 */
export const untilStraightened = (snapshot: () => Snapshot): Promise<void> =>
  until(() => (snapshot().assembly?.straighten.pending ?? 0) === 0, 8000);
