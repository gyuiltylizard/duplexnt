import type { AssembledPage, SessionAssembly, SessionSnapshot } from '@shared';

/**
 * ТОЛЬКО ДЛЯ ТЕСТОВ renderer: упрощённое зеркало сборки ядра (KTD-4) — лицевые по порядку,
 * обороты обратным порядком от последнего листа; непарными остаются младшие листы, лишние
 * обороты — в конце. Настоящая функция живёт в `src/core/scan/assembly.ts` и недоступна
 * renderer'у границей слоёв; расхождение с ядром чинится здесь, в одном месте.
 */
export function assemblyOf(session: SessionSnapshot): SessionAssembly {
  const surviving = session.passes.filter((pass) => pass.pages.length > 0);
  const backsPass = surviving[1];
  const fronts = surviving[0]?.pages ?? [];
  const backs = backsPass?.pages ?? [];
  const n = fronts.length;
  const order: AssembledPage[] = [];
  fronts.forEach((page, index) => {
    const sheet = index + 1;
    order.push({ key: page.key, side: 'front', sheet, rotate180: false, lost: page.lost });
    const back = backs[n - sheet];
    if (back !== undefined) {
      order.push({
        key: back.key,
        side: 'back',
        sheet,
        rotate180: backsPass?.rotate180 ?? false,
        lost: back.lost,
      });
    }
  });
  for (const back of backs.slice(n)) {
    order.push({
      key: back.key,
      side: 'back',
      sheet: null,
      rotate180: backsPass?.rotate180 ?? false,
      lost: back.lost,
    });
  }
  const unpaired = Array.from({ length: Math.max(0, n - backs.length) }, (_, index) => index + 1);
  return {
    order,
    report: {
      fronts: n,
      backs: backs.length,
      pairs: Math.min(n, backs.length),
      unpairedSheets: backsPass === undefined ? [] : unpaired,
      extraBacks: Math.max(0, backs.length - n),
      backsState: backsPass?.state ?? null,
      backsDeclined: session.backsDeclined,
      mismatch: backsPass !== undefined && backs.length !== n,
    },
  };
}
