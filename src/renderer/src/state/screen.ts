import {
  hasPages,
  isBacksKind,
  passesByKind,
  pendingSetOf,
  type PassesByKind,
  type PassProgress,
  type PassSnapshot,
  type SessionSnapshot,
  type Snapshot,
} from '@shared';

// Экран выводится из снимка чистой функцией (план M1, U20): своего состояния навигации у
// интерфейса нет. В M2 добавлен `flip` (план M2, KTD-5); `merge` — эфемерная пауза поверх
// `screenOf`, живёт в renderer (U9), здесь её нет. С M4.5 (KTD7) `flip` показывается и для
// двустороннего набора, ждущего обороты, — тем же экраном, без своих экранов у набора.

export type Screen = 'incompatible' | 'scan' | 'editor' | 'setup' | 'flip';

/**
 * Проходы сессии по ролям — единственное место правила в renderer (M3.5, KTD-4): роль читается
 * из `kind` общим помощником `passesByKind`, и только у прохода хотя бы с одной страницей.
 * «Остановить» на первом сегменте убирает опустевший проход целиком, но промежуточный снимок
 * мог бы нести его пустым; прерванный до первой страницы проход оборотов роли не занимает —
 * иначе он блокировал бы «Обороты не нужны». `EditorScreen` и история правок берут проход
 * оборотов отсюда же.
 */
export const rolesOf = (passes: readonly PassSnapshot[]): PassesByKind<PassSnapshot> =>
  passesByKind(passes, hasPages);

/** Номер «ДN» набора, ждущего обороты (M4.5, KTD2) — тем же правилом, что ядро; `null` — нет. */
export const pendingSetNumberOf = (passes: readonly PassSnapshot[]): number | null =>
  pendingSetOf(passes, hasPages, (pass) => pass.state)?.set ?? null;

/**
 * Форма «flip». Набор ждёт обороты (M4.5, R6) — `flip` с приоритетом над `editor` и независимо
 * от отказа по основной пачке: разворот нужен этим листам. Иначе — основная пачка: единственный
 * уцелевший проход — лицевой, завершён или принят, отказа от оборотов нет. Прерванный лицевой —
 * `editor` (досканирование, как M1); любой другой уцелевший проход — обороты или добавленный
 * набор — тоже `editor`: разворот листов уже позади.
 */
function flipForm(session: SessionSnapshot): boolean {
  if (pendingSetNumberOf(session.passes) !== null) {
    return true;
  }
  if (session.backsDeclined) {
    return false;
  }
  const { fronts, backs, added, addedFronts, addedBacks } = rolesOf(session.passes);
  return (
    fronts !== null &&
    backs === null &&
    added.length === 0 &&
    addedFronts.length === 0 &&
    addedBacks.length === 0 &&
    (fronts.state === 'completed' || fronts.state === 'accepted')
  );
}

/**
 * S2 (KTD-11): проход оборотов — основной пачки или набора (M4.5) — запущен с `flip`, устройство
 * ещё занято или задание только создаётся, страниц нет — экран остаётся `flip` с состоянием
 * ожидания. Первая страница или фаза `scanning` уводит на `scan`. Досканирование прерванных
 * оборотов — сразу `scan` (M1); лицевой и добавленный проходы с `flip` не запускаются — сразу
 * `scan`.
 */
function flipBusy(pass: PassProgress): boolean {
  return (
    isBacksKind(pass.kind) &&
    !pass.resumed &&
    pass.pages === 0 &&
    (pass.phase === 'starting' || pass.phase === 'busy')
  );
}

export function screenOf(snapshot: Snapshot): Screen {
  // Режим отказа хранилища перекрывает всё: ни прохода, ни сессии на этом экране нет (KTD-35).
  if (snapshot.storage.incompatible) {
    return 'incompatible';
  }
  if (snapshot.pass !== null) {
    return flipBusy(snapshot.pass) ? 'flip' : 'scan';
  }
  if (snapshot.session !== null) {
    return flipForm(snapshot.session) ? 'flip' : 'editor';
  }
  return 'setup';
}
