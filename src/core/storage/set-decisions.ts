import { ok, sessionConflict, type Result, type SessionConflictReason } from '@shared';
import {
  addedSetsOfJournal,
  isVacant,
  pagesOf,
  passStateOf,
  runningSegmentOf,
  type Journal,
  type JournalPass,
} from './journal';
import { segmentPrefix } from './layout';

// Решения по оборотам добавленного набора «ДN» (M4.5, KTD3; ADR 0004, амендмент 2026-10-23):
// «Оставить как есть» и «Переснять обороты набора». Живут отдельно от хранилища сессии (ориентир
// размера файла), но исполняются его очередью и его `commit`: хранилище подставляет контекст.

const conflict = (reason: SessionConflictReason): Result<never> => ({
  ok: false,
  error: sessionConflict(reason),
});

/** Журнал с решением по оборотам набора на проходе его лиц (M4.5, KTD1). */
export const withDecision = (
  current: Journal,
  fronts: JournalPass,
  backsDecision: 'declined' | 'kept',
): Journal => ({
  ...current,
  passes: current.passes.map((pass) => (pass === fronts ? { ...pass, backsDecision } : pass)),
});

/** Двусторонний набор «ДN» с проходами лиц и оборотов; `null` — набора нет или оборотов у него нет. */
function twoSidedSet(
  current: Journal,
  set: number,
): { readonly fronts: JournalPass; readonly backs: JournalPass } | null {
  const found = addedSetsOfJournal(current).find((it) => it.set === set && it.sides === 'two');
  const fronts = current.passes.find((pass) => pass.number === found?.fronts);
  const backs = current.passes.find((pass) => pass.number === found?.backs);
  return fronts === undefined || backs === undefined ? null : { fronts, backs };
}

/**
 * Набор «ДN» с несовпавшими оборотами, по которому ещё можно решать: общий гард «Оставить как
 * есть» и «Переснять» — сессия есть, проход не идёт, набор с оборотами найден, обороты не
 * прерваны, числа не равны и решения ещё нет.
 */
export function mismatchedSetOf(
  journal: Journal | null,
  set: number,
): Result<{
  readonly journal: Journal;
  readonly fronts: JournalPass;
  readonly backs: JournalPass;
}> {
  if (journal === null || isVacant(journal)) {
    return conflict('noSession');
  }
  if (runningSegmentOf(journal) !== null) {
    return conflict('passRunning');
  }
  const found = twoSidedSet(journal, set);
  if (found === null) {
    return conflict('noPendingSet');
  }
  const { fronts, backs } = found;
  // Прерванные обороты решает плашка: досканировать или «Оставить как есть» (`acceptPass` ставит
  // `kept` сам). Решение поверх досканируемого прохода дало бы `kept` у прохода, который ещё растёт.
  if (passStateOf(backs) === 'interrupted') {
    return conflict('passInterrupted');
  }
  return fronts.backsDecision !== 'none' || pagesOf(backs).length === pagesOf(fronts).length
    ? conflict('setNotMismatched')
    : ok({ journal, fronts, backs });
}

/** Что хранилище даёт командам набора: журнал в памяти, запись и чистку под пометкой. */
export interface SetDecisionsContext {
  readonly journal: () => Journal | null;
  readonly commit: (next: Journal, mode: 'must' | 'soft') => Promise<Result<void>>;
  /** Идущие чтения страниц дочитывают до удаления файлов. */
  readonly settleReads: () => Promise<unknown>;
  /** Удаление файлов под пометкой, снятие пометки — как у «Остановить» (KTD-20). */
  readonly removeMarked: (sessionId: string, prefix: string) => Promise<void>;
}

export function setDecisionsOf(context: SetDecisionsContext) {
  return {
    /** «Оставить как есть»: durable `kept`; вывод не меняется (подблоки уже в ленте). */
    async keepSetBacks(set: number): Promise<Result<void>> {
      const found = mismatchedSetOf(context.journal(), set);
      if (!found.ok) {
        return found;
      }
      return context.commit(withDecision(found.value.journal, found.value.fronts, 'kept'), 'must');
    },

    /**
     * «Переснять обороты набора»: отброс прохода — как «Остановить» на сегменте (KTD-20):
     * пометки об удалении в журнале раньше файлов; не доведённое удаление дочищает сверка при
     * запуске. Правки по ключам прохода вычищает нормализация в `commit`; вывод меняется —
     * отметка о сохранении снимается.
     */
    async rescanSetBacks(set: number): Promise<Result<void>> {
      const found = mismatchedSetOf(context.journal(), set);
      if (!found.ok) {
        return found;
      }
      const { journal: current, backs } = found.value;
      const prefixes = backs.segments.map((segment) => segmentPrefix(backs.number, segment.number));
      const marked = await context.commit(
        {
          ...current,
          passes: current.passes.filter((pass) => pass !== backs),
          deletions: [...current.deletions, ...prefixes],
          saved: false,
        },
        'must',
      );
      if (!marked.ok) {
        return marked;
      }
      await context.settleReads();
      for (const prefix of prefixes) {
        await context.removeMarked(current.sessionId, prefix);
      }
      return ok(undefined);
    },
  };
}
