import type { PageInfo } from './session-store';

// Живость страницы для производного (M4, KTD3; M6, KTD-12): кэши оценок, выправленные файлы,
// очередь коррекции и миниатюры помнят, из какой сессии страница, и перед записью или выдачей
// спрашивают источник снова — «Остановить», «Новое сканирование» и пересъём могли её отбросить,
// а тот же ключ новой сессии — другая страница. Одно правило на всех потребителей.

/** Источник страниц: хранилище сессии подходит. */
export interface PageSource {
  pageInfo(key: string): PageInfo | null;
}

/** Страница на месте и из той же сессии, что при начале работы. */
export const isAlive = (
  source: PageSource,
  key: string,
  info: Pick<PageInfo, 'sessionId'>,
): boolean => source.pageInfo(key)?.sessionId === info.sessionId;

/** Забывает записи страниц, которых у источника больше нет (отброшены или другая сессия). */
export function pruneStale(
  entries: Map<string, { readonly sessionId: string }>,
  source: PageSource,
): void {
  for (const [key, entry] of entries) {
    if (!isAlive(source, key, entry)) {
      entries.delete(key);
    }
  }
}
