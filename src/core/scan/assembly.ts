import type {
  AssembledPage,
  AssemblyReport,
  PassSnapshot,
  SessionAssembly,
  SessionSnapshot,
} from '@shared';

// Сборка двух проходов (план M2, U2; KTD-4): чистая функция над снимком сессии. Порядок и отчёт —
// производное, в журнал не пишутся (ADR 0004).
//
// Правило пар — физика разворота (техбаза §5): обороты приходят в обратном порядке, первая
// страница прохода оборотов — оборот ПОСЛЕДНЕГО листа лицевого прохода. Пары считаются от начала
// прохода оборотов; при нехватке оборотов непарными остаются листы с МЕНЬШИМИ номерами, при
// избытке лишние обороты идут в конец набора и не выбрасываются.
//
// Роль прохода — позиция среди уцелевших (непустых) проходов, не чётность номера: номера не
// переиспользуются, и после «Остановить» повторный запуск оборотов получает номер 3.

/** Уцелевшие проходы снимка: с хотя бы одной страницей (роль — позиция здесь, KTD-4). */
const survivingOf = (session: SessionSnapshot): PassSnapshot[] =>
  session.passes.filter((pass) => pass.pages.length > 0);

/** Сборка сессии: порядок по умолчанию и отчёт пар. */
export function assembleSession(session: SessionSnapshot): SessionAssembly {
  const [frontsPass, backsPass, ...rest] = survivingOf(session);
  const fronts = frontsPass?.pages ?? [];
  const backs = backsPass?.pages ?? [];
  // Поворот — атрибут прохода оборотов (KTD-2): флаг лицевого прохода роли не играет.
  const rotateBacks = backsPass?.rotate180 ?? false;

  const order: AssembledPage[] = [];
  const unpairedSheets: number[] = [];
  for (const [index, front] of fronts.entries()) {
    order.push({
      key: front.key,
      side: 'front',
      sheet: front.number,
      rotate180: false,
      lost: front.lost,
    });
    // Оборот листа i (с нуля) — страница F−1−i прохода оборотов: пары от его начала.
    const back = backs[fronts.length - 1 - index];
    if (back === undefined) {
      if (backs.length > 0) {
        unpairedSheets.push(front.number);
      }
    } else {
      order.push({
        key: back.key,
        side: 'back',
        sheet: front.number,
        rotate180: rotateBacks,
        lost: back.lost,
      });
    }
  }
  // Лишние обороты — в конец набора, в порядке получения; их листы неизвестны.
  for (const extra of backs.slice(fronts.length)) {
    order.push({
      key: extra.key,
      side: 'back',
      sheet: null,
      rotate180: rotateBacks,
      lost: extra.lost,
    });
  }
  // Третьего набора в M2 не бывает (политика прохода, U3); если он всё же есть — страницы не
  // выбрасываются, а идут в конец без пары и в отчёте не участвуют.
  for (const pass of rest) {
    for (const page of pass.pages) {
      order.push({ key: page.key, side: 'front', sheet: null, rotate180: false, lost: page.lost });
    }
  }

  const extraBacks = Math.max(0, backs.length - fronts.length);
  const report: AssemblyReport = {
    fronts: fronts.length,
    backs: backs.length,
    pairs: Math.min(fronts.length, backs.length),
    unpairedSheets,
    extraBacks,
    backsState: backsPass?.state ?? null,
    backsDeclined: session.backsDeclined,
    mismatch: unpairedSheets.length > 0 || extraBacks > 0,
  };
  return { order, report };
}
