import {
  passesByKind,
  type PassesByKind,
  type PassProgress,
  type PassSnapshot,
  type SessionSnapshot,
  type Snapshot,
} from '@shared';

// Экран выводится из снимка чистой функцией (план M1, U20): своего состояния навигации у
// интерфейса нет. В M2 добавлен `flip` (план M2, KTD-5); `merge` — эфемерная пауза поверх
// `screenOf`, живёт в renderer (U9), здесь её нет.

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
  passesByKind(passes, (pass) => pass.pages.length > 0);

/**
 * Форма «flip»: единственный уцелевший проход — лицевой, завершён или принят, отказа от
 * оборотов нет. Прерванный лицевой — `editor` (досканирование, как M1); любой другой уцелевший
 * проход — обороты или добавленный набор — тоже `editor`: разворот листов уже позади.
 */
function flipForm(session: SessionSnapshot): boolean {
  if (session.backsDeclined) {
    return false;
  }
  const { fronts, backs, added } = rolesOf(session.passes);
  return (
    fronts !== null &&
    backs === null &&
    added.length === 0 &&
    (fronts.state === 'completed' || fronts.state === 'accepted')
  );
}

/**
 * S2 (KTD-11): проход оборотов запущен с `flip`, устройство ещё занято или задание только
 * создаётся, страниц нет — экран остаётся `flip` с состоянием ожидания. Первая страница или
 * фаза `scanning` уводит на `scan`. Досканирование прерванных оборотов — сразу `scan` (M1);
 * лицевой и добавленный проходы с `flip` не запускаются — сразу `scan`.
 */
function flipBusy(pass: PassProgress): boolean {
  return (
    pass.kind === 'backs' &&
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
