import type { AssembledDocument, AssembledPage, SessionAssembly, SessionSnapshot } from '@shared';
import { rolesOf } from './screen';

/** Пустая лента без правок: основа для снимков, где важен только отчёт. */
export const NO_EDITS_ASSEMBLY: Omit<SessionAssembly, 'report'> = {
  order: [],
  documents: [{ name: '', start: 0, count: 0 }],
  orderEdited: false,
  hasEdits: false,
  deleted: 0,
};

/**
 * ТОЛЬКО ДЛЯ ТЕСТОВ renderer: упрощённое зеркало автопорядка ядра (M2, KTD-4; M3.5, KTD-2) —
 * лицевые по порядку, обороты обратным порядком от последнего листа; непарными остаются
 * младшие листы, лишние обороты — в конце; затем блоки добавленных наборов по возрастанию
 * номера прохода, каждый сразу за якорем (перед прикреплёнными к нему раньше), без якоря — в
 * конец. Правки не применяются: ленту с правками renderer получает из снимка готовой (M3,
 * KTD-2), и тесты с правками строят сборку сами. Настоящая функция живёт в
 * `src/core/scan/assembly.ts` и недоступна renderer'у границей слоёв; расхождение ловит
 * табличный тест `test/guards/assembly-fixture.test.ts` на одних данных.
 */
export function assemblyOf(session: SessionSnapshot): SessionAssembly {
  const { fronts: frontsPass, backs: backsPass, added } = rolesOf(session.passes);
  const fronts = frontsPass?.pages ?? [];
  const backs = backsPass?.pages ?? [];
  const n = fronts.length;
  const backAngle = backsPass?.rotate180 === true ? 180 : 0;
  const unpairedSheets =
    backsPass === null
      ? []
      : Array.from({ length: Math.max(0, n - backs.length) }, (_, index) => index + 1);
  const order: AssembledPage[] = [];
  fronts.forEach((page, index) => {
    const sheet = index + 1;
    order.push({
      key: page.key,
      side: 'front',
      sheet,
      angle: 0,
      lost: page.lost,
      unpaired: unpairedSheets.includes(sheet),
      addedSet: null,
    });
    const back = backs[n - sheet];
    if (back !== undefined) {
      order.push({
        key: back.key,
        side: 'back',
        sheet,
        angle: backAngle,
        lost: back.lost,
        unpaired: false,
        addedSet: null,
      });
    }
  });
  for (const back of backs.slice(n)) {
    order.push({
      key: back.key,
      side: 'back',
      sheet: null,
      angle: backAngle,
      lost: back.lost,
      unpaired: false,
      addedSet: null,
    });
  }
  added.forEach((pass, index) => {
    const block = pass.pages.map((page): AssembledPage => ({
      key: page.key,
      side: 'front',
      sheet: null,
      angle: 0,
      lost: page.lost,
      unpaired: false,
      addedSet: index + 1,
    }));
    const anchor = pass.after === null ? -1 : order.findIndex((page) => page.key === pass.after);
    order.splice(anchor === -1 ? order.length : anchor + 1, 0, ...block);
  });
  return {
    order,
    documents: [{ name: '', start: 0, count: order.length }],
    orderEdited: false,
    hasEdits: backAngle !== 0,
    deleted: 0,
    report: {
      fronts: n,
      backs: backs.length,
      pairs: Math.min(n, backs.length),
      unpairedSheets,
      extraBacks: Math.max(0, backs.length - n),
      backsState: backsPass?.state ?? null,
      backsDeclined: session.backsDeclined,
      mismatch: backsPass !== null && backs.length !== n,
    },
  };
}

/**
 * ТОЛЬКО ДЛЯ ТЕСТОВ: документы ленты длины `length` по разрезам — как их отдало бы ядро (R10).
 * Пустая лента — один пустой документ.
 */
export function documentsOf(
  length: number,
  cuts: readonly number[] = [],
  names: readonly string[] = [],
): AssembledDocument[] {
  const bounds = [0, ...cuts, length];
  return bounds.slice(0, -1).map((start, index) => ({
    name: names[index] ?? '',
    start,
    count: (bounds[index + 1] ?? length) - start,
  }));
}
