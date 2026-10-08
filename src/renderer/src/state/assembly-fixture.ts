import type { AssembledDocument, AssembledPage, SessionAssembly, SessionSnapshot } from '@shared';

/** Пустая лента без правок: основа для снимков, где важен только отчёт. */
export const NO_EDITS_ASSEMBLY: Omit<SessionAssembly, 'report'> = {
  order: [],
  documents: [{ name: '', start: 0, count: 0 }],
  orderEdited: false,
  hasEdits: false,
  deleted: 0,
};

/**
 * ТОЛЬКО ДЛЯ ТЕСТОВ renderer: упрощённое зеркало автопорядка ядра (KTD-4) — лицевые по порядку,
 * обороты обратным порядком от последнего листа; непарными остаются младшие листы, лишние
 * обороты — в конце. Правки не применяются: ленту с правками renderer получает из снимка
 * готовой (M3, KTD-2), и тесты с правками строят сборку сами. Настоящая функция живёт в
 * `src/core/scan/assembly.ts` и недоступна renderer'у границей слоёв.
 */
export function assemblyOf(session: SessionSnapshot): SessionAssembly {
  const surviving = session.passes.filter((pass) => pass.pages.length > 0);
  const backsPass = surviving[1];
  const fronts = surviving[0]?.pages ?? [];
  const backs = backsPass?.pages ?? [];
  const n = fronts.length;
  const backAngle = backsPass?.rotate180 === true ? 180 : 0;
  const unpairedSheets =
    backsPass === undefined
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
      mismatch: backsPass !== undefined && backs.length !== n,
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
