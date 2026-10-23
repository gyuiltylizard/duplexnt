import { useState } from 'react';
import type { AddedSetReport, AssembledPage, Snapshot } from '@shared';
import { pairLanded } from './assembly-outcome';
import type { Screen } from './screen';

// Посадка двустороннего набора (план M4.5, U6; KTD7; handoff M4.5, S6, S10): пара закрыта —
// обороты набора завершены, приняты или не нужны — и `editor` на экране → пауза `merge`, текущая
// на первой показанной странице набора и один тост «добавлено N». Выводится из снимка, а не из
// «последнего прохода» (урок M3.5, ревью 3): снимки приходят пачкой, кадр `scan` между `flip` и
// `editor` легко пропустить. Дедуп — по сессии и номеру набора среди закрытых пар; «Переснять»
// убирает проход оборотов, набор снова ждёт — и следующая посадка состоится. Первый снимок
// процесса ничего не сажает: закрытые на нём пары уже посажены прошлым процессом (после
// перезапуска паузы нет, как у основной пачки). Корректировка состояния при рендере — идемпотентно
// и переживает StrictMode.

export interface SetLanding {
  readonly set: AddedSetReport;
  /** Первая показанная страница набора — на неё садится текущая; `null` — показанных нет. */
  readonly key: string | null;
  /** Показанных страниц набора — число тоста. */
  readonly shown: number;
  /** Скрытых пустых оборотов набора — тост называет их отдельно. */
  readonly hidden: number;
}

const keyOf = (sessionId: string, set: number): string => `${sessionId}:${String(set)}`;

const sameKeys = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.size === right.size && [...left].every((key) => right.has(key));

/** Посадка по показанной ленте снимка (KTD7): страницы набора, скрытые — по флагу `blank`. */
function landingOf(order: readonly AssembledPage[], set: AddedSetReport): Omit<SetLanding, 'set'> {
  const pages = order.filter((entry) => entry.addedSet === set.set);
  const shown = pages.filter((entry) => entry.blank !== 'hidden');
  return { key: shown[0]?.key ?? null, shown: shown.length, hidden: pages.length - shown.length };
}

/**
 * Свежезакрытая пара на кадре `editor` — ровно один раз на закрытие; `null` — сажать нечего.
 * На кадре, где посадка найдена, её же корректировка помечает пару увиденной: повторный рендер
 * (StrictMode, корректировки App) вернёт `null`.
 */
export function useSetLanding(snapshot: Snapshot | null, screen: Screen | null): SetLanding | null {
  // `null` — ни одного снимка ещё не было.
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
  const session = snapshot?.session ?? null;
  const assembly = snapshot?.assembly ?? null;
  if (snapshot === null) {
    return null;
  }
  if (session === null || assembly === null) {
    if (seen === null || seen.size > 0) {
      setSeen(new Set());
    }
    return null;
  }
  const landed = assembly.report.sets.filter(pairLanded);
  const keys = new Set(landed.map((set) => keyOf(session.id, set.set)));
  if (seen === null) {
    setSeen(keys);
    return null;
  }
  // Пара, переставшая быть закрытой («Переснять» убрал обороты), забывается на любом кадре: экран
  // после отброса уходит на `flip`, кадра `editor` между посадками может не быть. Новые пары
  // помечаются увиденными только на `editor`: закрытая на другом кадре дождётся его.
  if (screen !== 'editor') {
    const kept = new Set([...seen].filter((key) => keys.has(key)));
    if (kept.size !== seen.size) {
      setSeen(kept);
    }
    return null;
  }
  if (!sameKeys(seen, keys)) {
    setSeen(keys);
  }
  const fresh = landed.filter((set) => !seen.has(keyOf(session.id, set.set))).at(-1);
  return fresh === undefined ? null : { set: fresh, ...landingOf(assembly.order, fresh) };
}
