import type { PassProgress, SessionSnapshot, Snapshot } from '@shared';

// Экран выводится из снимка чистой функцией (план M1, U20): своего состояния навигации у
// интерфейса нет. В M2 добавлен `flip` (план M2, KTD-5); `merge` — эфемерная пауза поверх
// `screenOf`, живёт в renderer (U9), здесь её нет.

export type Screen = 'incompatible' | 'scan' | 'editor' | 'setup' | 'flip';

/**
 * Уцелевшие проходы — непустые (KTD-4): «Остановить» на первом сегменте убирает опустевший
 * проход целиком, но промежуточный снимок мог бы нести его пустым — фильтр страхует.
 */
function surviving(session: SessionSnapshot) {
  return session.passes.filter((pass) => pass.pages.length > 0);
}

/**
 * Форма «flip»: единственный уцелевший проход — лицевой (роль по позиции, KTD-4), завершён
 * или принят, отказа от оборотов нет. Прерванный лицевой — `editor` (досканирование, как M1).
 */
function flipForm(session: SessionSnapshot): boolean {
  if (session.backsDeclined) {
    return false;
  }
  const passes = surviving(session);
  const only = passes.length === 1 ? passes[0] : undefined;
  return only !== undefined && (only.state === 'completed' || only.state === 'accepted');
}

/**
 * S2 (KTD-11): проход оборотов запущен с `flip`, устройство ещё занято или задание только
 * создаётся, страниц нет — экран остаётся `flip` с состоянием ожидания. Первая страница или
 * фаза `scanning` уводит на `scan`. Досканирование прерванных оборотов — сразу `scan` (M1).
 */
function flipBusy(pass: PassProgress): boolean {
  return (
    pass.expected !== null &&
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
