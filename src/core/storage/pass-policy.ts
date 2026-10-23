import {
  fail,
  ok,
  sessionConflict,
  type AddedPassIntent,
  type DomainError,
  type PassKind,
  type Result,
  type SessionConflictReason,
  type StartPassRequest,
} from '@shared';
import { modeOf } from '../scan/assembly';
import {
  isVacant,
  nextKindOf,
  NOTHING_LOST,
  pagesOf,
  passSnapshotsOf,
  passStateOf,
  pendingPairOf,
  rolesOf,
  runningSegmentOf,
  type Journal,
  type JournalPass,
  type PassOrigin,
} from './journal';
import { parsePageKey } from './layout';

// Политика запуска прохода — чистые запросы над журналом (M3.5, KTD-5; M4.5, KTD2): одно место
// правила для службы (до сети) и хранилища (при записи). Хранилище подставляет своё состояние;
// здесь нет ни очереди операций, ни файлов.

/** Что начнёт `startPass` по запросу — ответ `planPass` (M3.5, KTD-5). */
export interface PassPlan {
  readonly kind: PassKind;
  /** Досканирование прерванного последнего прохода, а не новый проход. */
  readonly resumed: boolean;
  /**
   * Ожидаемое число страниц: у оборотов — страницы лицевых, у оборотов набора — страницы его лиц
   * (M4.5, R7); иначе `null` (M2, R2).
   */
  readonly expected: number | null;
  /** Номер прохода лиц набора у оборотов набора (M4.5, KTD2); у остальных `null`. */
  readonly pair: number | null;
}

export interface PolicyState {
  readonly journal: Journal | null;
  /** Данные более новой версии: режим отказа (KTD-35). */
  readonly incompatible: boolean;
}

export const REFUSAL: DomainError = { code: 'storageIncompatible' };

export const conflict = (reason: SessionConflictReason): Result<never> => ({
  ok: false,
  error: sessionConflict(reason),
});

/** Проход, которому принадлежит ключ страницы с записью в журнале; иначе `null`. */
export function locatePass(journal: Journal | null, key: string): JournalPass | null {
  const address = parsePageKey(key);
  if (address === null || journal === null) {
    return null;
  }
  const pass = journal.passes.find((it) => it.number === address.pass);
  const segment = pass?.segments.find((it) => it.number === address.segment);
  return pass !== undefined && segment !== undefined && address.index <= segment.pageCount
    ? pass
    : null;
}

/** Прерванный последний проход с известными параметрами — его можно досканировать. */
export function resumable({
  journal,
  incompatible,
}: PolicyState): Result<JournalPass & { readonly origin: PassOrigin }> {
  if (incompatible) {
    return { ok: false, error: REFUSAL };
  }
  const pass = journal?.passes.at(-1);
  if (journal === null || pass === undefined || isVacant(journal)) {
    return conflict('noSession');
  }
  const state = passStateOf(pass);
  if (state === 'running') {
    return conflict('passRunning');
  }
  if (state !== 'interrupted') {
    return conflict('notInterrupted');
  }
  const { origin } = pass;
  return origin === null ? conflict('paramsUnknown') : ok({ ...pass, origin });
}

/**
 * Намерение добавленного набора (M3.5, R9; M4.5, R3, R11): сессия есть, якорь — её страница;
 * пока набор ждёт обороты, новый набор не начинается (`pairPending`) — очередь без намерения
 * даёт его обороты; двусторонний набор в режиме раздельных наборов — `pairInSets` (ядро
 * отказывает и без интерфейса).
 */
export function checkIntent(
  { journal }: PolicyState,
  intent: AddedPassIntent | null,
): Result<void> {
  if (intent === null) {
    return ok(undefined);
  }
  if (journal === null || isVacant(journal)) {
    return conflict('noSession');
  }
  if (intent.after !== null && locatePass(journal, intent.after) === null) {
    return fail('invalidInput', { field: 'after' });
  }
  if (pendingPairOf(journal) !== null) {
    return conflict('pairPending');
  }
  if (
    intent.kind === 'addedFronts' &&
    modeOf(passSnapshotsOf(journal, NOTHING_LOST), journal.assembled) === 'sets'
  ) {
    return conflict('pairInSets');
  }
  return ok(undefined);
}

/** Ожидаемое число страниц у роли оборотов: страницы парного прохода лиц (M2, R2; M4.5, R7). */
function expectedOf(journal: Journal, kind: PassKind, pair: number | null): number | null {
  if (kind === 'backs') {
    const { fronts } = rolesOf(journal);
    return fronts === null ? null : pagesOf(fronts).length;
  }
  if (kind === 'addedBacks') {
    const fronts = journal.passes.find((pass) => pass.number === pair);
    return fronts === undefined ? null : pagesOf(fronts).length;
  }
  return null;
}

/**
 * Политика запуска (M3.5, KTD-5; M4.5, R11). Без намерения: прерванный последний проход —
 * досканирование (отказы `resumable`), лицевые без оборотов — обороты (`backsDeclined` /
 * `backsPresent` отказывают), набор, ждущий обороты, — его обороты с ожидаемым числом, пустая
 * сессия — лицевые. С намерением: `checkIntent`, при прерванном последнем — `passInterrupted`
 * (иначе лицевые застряли бы прерванными навсегда); отказ от оборотов и их наличие не мешают.
 */
export function planPass(state: PolicyState, request: StartPassRequest): Result<PassPlan> {
  const { journal, incompatible } = state;
  if (incompatible) {
    return { ok: false, error: REFUSAL };
  }
  if (runningSegmentOf(journal) !== null) {
    return conflict('passRunning');
  }
  const last = journal?.passes.at(-1);
  if (request !== null) {
    const checked = checkIntent(state, request);
    if (!checked.ok) {
      return checked;
    }
    if (last !== undefined && passStateOf(last) === 'interrupted') {
      return conflict('passInterrupted');
    }
    return ok({ kind: request.kind, resumed: false, expected: null, pair: null });
  }
  if (journal === null || last === undefined || isVacant(journal)) {
    return ok({ kind: 'fronts', resumed: false, expected: null, pair: null });
  }
  const target = resumable(state);
  if (target.ok) {
    const { kind, pair } = last;
    return ok({ kind, resumed: true, expected: expectedOf(journal, kind, pair), pair });
  }
  if (
    target.error.code !== 'sessionConflict' ||
    target.error.details?.reason !== 'notInterrupted'
  ) {
    return target;
  }
  // Последний проход завершён или принят — очередь ролей (`nextKindOf`); «добавленный» без
  // намерения — значит, оборотов нет по отказу или они уже есть, а набора, ждущего обороты, нет.
  const kind = nextKindOf(journal);
  if (kind === 'added') {
    return conflict(journal.backsDeclined ? 'backsDeclined' : 'backsPresent');
  }
  const pair = kind === 'addedBacks' ? (pendingPairOf(journal)?.fronts ?? null) : null;
  return ok({ kind, resumed: false, expected: expectedOf(journal, kind, pair), pair });
}
