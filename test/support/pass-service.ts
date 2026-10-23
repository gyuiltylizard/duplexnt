import { expect } from 'vitest';
import type { PassService } from '../../src/core/scan/pass-service';
import { unwrap } from './result';

// Общие шаги тестов службы проходов на эмуляторе (M4.5, U8): вступительные проходы.

/** Проходы без намерения по порядку: каждый завершён с ожидаемым числом страниц. */
export async function scanned(service: PassService, ...pages: readonly number[]): Promise<void> {
  for (const count of pages) {
    expect(unwrap(await service.startPass(null))).toMatchObject({ end: 'completed', pages: count });
  }
}
