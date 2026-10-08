import type {
  AssembledPage,
  AssemblyReport,
  PassSnapshot,
  SessionAssembly,
  SessionSnapshot,
} from '@shared';
import { documentsOf, hasEdits, normalizeEdits, pageAngle, visibleKeysOf } from './edits';

// Сборка проходов (план M2, U2; KTD-4), добавленные наборы по якорям (план M3.5, U2; KTD-2) и
// правки поверх (план M3, U2): чистая функция над снимком сессии. Лента, документы и отчёт —
// производное, в журнал не пишутся (ADR 0004).
//
// Правило пар — физика разворота (техбаза §5): обороты приходят в обратном порядке, первая
// страница прохода оборотов — оборот ПОСЛЕДНЕГО листа лицевого прохода. Пары считаются от начала
// прохода оборотов; при нехватке оборотов непарными остаются листы с МЕНЬШИМИ номерами, при
// избытке лишние обороты идут в конец набора и не выбрасываются.
//
// Роль прохода — `kind` из журнала (M3.5; ADR 0004, амендмент 2026-10-07), не позиция и не
// чётность номера; роль есть только у прохода со страницами.

/** Уцелевшие проходы: с хотя бы одной страницей. */
export const survivingOf = <T extends { readonly pages: readonly unknown[] }>(
  passes: readonly T[],
): T[] => passes.filter((pass) => pass.pages.length > 0);

export interface PassesByKind {
  readonly fronts: PassSnapshot | null;
  readonly backs: PassSnapshot | null;
  /** Добавленные наборы по возрастанию номера прохода. */
  readonly added: readonly PassSnapshot[];
}

/**
 * Проходы снимка по ролям — зеркало `passesByKind` хранилища для снимка (KTD-4): роль только у
 * прохода со страницами. Второй проход той же основной роли схема журнала не пропустит; если он
 * всё же пришёл, его страницы не выбрасываются — он идёт добавленным набором.
 */
export function passesByKindOf(passes: readonly PassSnapshot[]): PassesByKind {
  const counted = survivingOf(passes);
  const fronts = counted.find((pass) => pass.kind === 'fronts') ?? null;
  const backs = counted.find((pass) => pass.kind === 'backs') ?? null;
  return {
    fronts,
    backs,
    added: counted
      .filter((pass) => pass !== fronts && pass !== backs)
      .sort((left, right) => left.number - right.number),
  };
}

/** Страница автопорядка: до правок, без угла ручного поворота. */
interface AutoPage {
  readonly key: string;
  readonly side: 'front' | 'back';
  readonly sheet: number | null;
  /** Страница прохода оборотов: на неё ложится его флаг 180° (KTD-2). */
  readonly ofBacks: boolean;
  readonly lost: boolean;
  readonly addedSet: number | null;
}

interface AutoAssembly {
  readonly pages: readonly AutoPage[];
  readonly report: Omit<AssemblyReport, 'backsDeclined'>;
  readonly rotateBacks: boolean;
}

/**
 * Автопорядок и отчёт пар по проходам — без правок (M2, KTD-4; M3.5, KTD-2). Основа — лицевые и
 * обороты парами; затем блоки добавленных наборов по возрастанию номера прохода: блок встаёт
 * буквально сразу за якорем — перед наборами, прикреплёнными к нему раньше; якорь внутри чужого
 * блока — сразу за ним; якоря нет (`null`, страница ушла из сессии, ключ более позднего прохода)
 * — в конец. Досканированный сегмент — в конце блока своего прохода (страницы прохода идут
 * подряд). Удалённая правкой или потерянная страница якорем быть может: правки накладываются
 * позже, потерянная стоит на своём месте.
 */
function autoAssembly(passes: readonly PassSnapshot[]): AutoAssembly {
  const { fronts: frontsPass, backs: backsPass, added } = passesByKindOf(passes);
  const fronts = frontsPass?.pages ?? [];
  const backs = backsPass?.pages ?? [];

  const pages: AutoPage[] = [];
  const unpairedSheets: number[] = [];
  for (const [index, front] of fronts.entries()) {
    pages.push({
      key: front.key,
      side: 'front',
      sheet: front.number,
      ofBacks: false,
      lost: front.lost,
      addedSet: null,
    });
    // Оборот листа i (с нуля) — страница F−1−i прохода оборотов: пары от его начала.
    const back = backs[fronts.length - 1 - index];
    if (back === undefined) {
      if (backs.length > 0) {
        unpairedSheets.push(front.number);
      }
    } else {
      pages.push({
        key: back.key,
        side: 'back',
        sheet: front.number,
        ofBacks: true,
        lost: back.lost,
        addedSet: null,
      });
    }
  }
  // Лишние обороты — в конец набора, в порядке получения; их листы неизвестны.
  for (const extra of backs.slice(fronts.length)) {
    pages.push({
      key: extra.key,
      side: 'back',
      sheet: null,
      ofBacks: true,
      lost: extra.lost,
      addedSet: null,
    });
  }
  // Добавленные наборы: без пар и вне отчёта; номер набора — от 1 среди добавленных, не номер
  // прохода (KTD-4).
  added.forEach((pass, index) => {
    const block = pass.pages.map((page): AutoPage => ({
      key: page.key,
      side: 'front',
      sheet: null,
      ofBacks: false,
      lost: page.lost,
      addedSet: index + 1,
    }));
    const anchor = pass.after === null ? -1 : pages.findIndex((page) => page.key === pass.after);
    pages.splice(anchor === -1 ? pages.length : anchor + 1, 0, ...block);
  });

  const extraBacks = Math.max(0, backs.length - fronts.length);
  return {
    pages,
    report: {
      fronts: fronts.length,
      backs: backs.length,
      pairs: Math.min(fronts.length, backs.length),
      unpairedSheets,
      extraBacks,
      backsState: backsPass?.state ?? null,
      mismatch: unpairedSheets.length > 0 || extraBacks > 0,
    },
    // Поворот — атрибут прохода оборотов (KTD-2): флаги других проходов роли не играют.
    rotateBacks: backsPass?.rotate180 ?? false,
  };
}

/** Ключи автопорядка — то, против чего нормализуются правки (хранилище, сверка). */
export const autoKeysOf = (passes: readonly PassSnapshot[]): string[] =>
  autoAssembly(passes).pages.map((page) => page.key);

/**
 * Сборка сессии: автопорядок, поверх него правки (M3, U2), документы по разрезам и отчёт пар.
 * Отчёт — о сканировании, не о ленте: правки его не меняют (KTD-7).
 */
export function assembleSession(session: SessionSnapshot): SessionAssembly {
  const auto = autoAssembly(session.passes);
  const byKey = new Map(auto.pages.map((page) => [page.key, page]));
  const autoKeys = [...byKey.keys()];
  // Снимок уже несёт канонические правки (их нормализует хранилище); повтор дешёв и страхует
  // сборку от мёртвых ключей при любом источнике снимка.
  const edits = normalizeEdits(autoKeys, session.edits);
  const unpaired = new Set(auto.report.unpairedSheets);

  const order: AssembledPage[] = [];
  for (const key of visibleKeysOf(autoKeys, edits)) {
    const page = byKey.get(key);
    if (page !== undefined) {
      order.push({
        key,
        side: page.side,
        sheet: page.sheet,
        angle: pageAngle(edits.rotations[key], page.ofBacks && auto.rotateBacks),
        lost: page.lost,
        unpaired: page.side === 'front' && page.sheet !== null && unpaired.has(page.sheet),
        addedSet: page.addedSet,
      });
    }
  }

  return {
    order,
    documents: documentsOf(order.length, edits),
    orderEdited: edits.order.length > 0,
    hasEdits: hasEdits(edits, auto.rotateBacks),
    deleted: edits.deleted.length,
    report: { ...auto.report, backsDeclined: session.backsDeclined },
  };
}
