import type {
  AssembledDocument,
  AssembledPage,
  AssemblyMode,
  PassSnapshot,
  SessionAssembly,
  SessionSnapshot,
  SetsLayout,
} from '@shared';
import { rolesOf } from './screen';

/** Пустая лента без правок: основа для снимков, где важен только отчёт. */
export const NO_EDITS_ASSEMBLY: Omit<SessionAssembly, 'report'> = {
  order: [],
  documents: [{ name: '', start: 0, count: 0 }],
  sets: null,
  orderEdited: false,
  hasEdits: false,
  deleted: 0,
};

/** Режим сборки без правок (M3.6, R4): как считает ядро, с идущим проходом оборотов — пары. */
function modeOf(session: SessionSnapshot): AssemblyMode {
  if (session.assembled !== null) {
    return 'assembled';
  }
  const { fronts, backs } = rolesOf(session.passes);
  if (backs === null || backs.state === 'running') {
    return 'pairs';
  }
  return backs.pages.length === (fronts?.pages.length ?? 0) ? 'pairs' : 'sets';
}

interface MirrorPage extends Omit<AssembledPage, 'side' | 'sheet'> {
  readonly group: 'fronts' | 'backs' | null;
  readonly ofBacks: boolean;
}

/** Блоки добавленных наборов — по якорю, без якоря в конец; группа — группа якоря. */
function placeAdded(
  order: MirrorPage[],
  added: readonly PassSnapshot[],
  end: 'fronts' | 'backs' | null,
): void {
  added.forEach((pass, index) => {
    const anchor = pass.after === null ? -1 : order.findIndex((page) => page.key === pass.after);
    const group = anchor === -1 ? end : (order[anchor]?.group ?? null);
    const block = pass.pages.map((page): MirrorPage => ({
      key: page.key,
      angle: 0,
      lost: page.lost,
      unpaired: false,
      addedSet: index + 1,
      group,
      ofBacks: false,
    }));
    order.splice(anchor === -1 ? order.length : anchor + 1, 0, ...block);
  });
}

/**
 * ТОЛЬКО ДЛЯ ТЕСТОВ renderer: упрощённое зеркало базового порядка ядра (M2, KTD-4; M3.5, KTD-2;
 * M3.6, KTD2) — пары: лицевые по порядку, обороты обратным порядком от последнего листа, непарными
 * остаются младшие листы, лишние обороты — в конце; раздельные наборы: лица, затем обороты обратным
 * порядком подачи, граница — число лиц; собрано: лента по записи, новые ключи — за предыдущей
 * страницей своего прохода, добавленные — по якорю, иначе в конец; затем блоки добавленных
 * наборов по возрастанию номера прохода, каждый сразу за якорем, без якоря — в конец. Правки не
 * применяются: ленту с правками renderer получает из снимка готовой (M3, KTD-2), и тесты с
 * правками строят сборку сами. Настоящая функция живёт в `src/core/scan/assembly.ts` и недоступна
 * renderer'у границей слоёв; расхождение ловит табличный тест
 * `test/guards/assembly-fixture.test.ts` на одних данных.
 */
export function assemblyOf(session: SessionSnapshot): SessionAssembly {
  const { fronts: frontsPass, backs: backsPass, added } = rolesOf(session.passes);
  const fronts = frontsPass?.pages ?? [];
  const backs = backsPass?.pages ?? [];
  const n = fronts.length;
  const backAngle = backsPass?.rotate180 === true ? 180 : 0;
  const mode = modeOf(session);
  const unpairedSheets =
    backsPass === null
      ? []
      : Array.from({ length: Math.max(0, n - backs.length) }, (_, index) => index + 1);
  const report = {
    mode,
    fronts: n,
    backs: backs.length,
    pairs: Math.min(n, backs.length),
    unpairedSheets,
    extraBacks: Math.max(0, backs.length - n),
    backsState: backsPass?.state ?? null,
    backsDeclined: session.backsDeclined,
    mismatch: mode === 'sets',
  };
  const front = (page: PassSnapshot['pages'][number], group: MirrorPage['group']): MirrorPage => ({
    key: page.key,
    angle: 0,
    lost: page.lost,
    unpaired: unpairedSheets.includes(page.number),
    addedSet: null,
    group,
    ofBacks: false,
  });
  const back = (page: PassSnapshot['pages'][number], group: MirrorPage['group']): MirrorPage => ({
    key: page.key,
    angle: backAngle,
    lost: page.lost,
    unpaired: false,
    addedSet: null,
    group,
    ofBacks: true,
  });

  const order: MirrorPage[] = [];
  let sets: SetsLayout | null = null;
  let placed: (MirrorPage & Pick<AssembledPage, 'side' | 'sheet'>)[];
  if (mode === 'assembled') {
    const counted = session.passes.filter((pass) => pass.pages.length > 0);
    const known = new Map(
      counted.flatMap((pass) =>
        pass.pages.map((page, index) => [
          page.key,
          { pass, previous: pass.pages[index - 1]?.key ?? null, page },
        ]),
      ),
    );
    const addedIndex = new Map(added.map((pass, index) => [pass.number, index + 1]));
    const pageOf = (key: string): MirrorPage => {
      const origin = known.get(key);
      const ofBacks = origin?.pass.kind === 'backs';
      return {
        key,
        angle: ofBacks ? backAngle : 0,
        lost: origin?.page.lost ?? false,
        unpaired: false,
        addedSet: origin === undefined ? null : (addedIndex.get(origin.pass.number) ?? null),
        group: null,
        ofBacks,
      };
    };
    const record = (session.assembled ?? []).filter((key) => known.has(key));
    order.push(...record.map(pageOf));
    for (const pass of counted) {
      for (const page of pass.pages) {
        if (order.some((one) => one.key === page.key)) {
          continue;
        }
        const previous = known.get(page.key)?.previous ?? null;
        const after = previous === null ? -1 : order.findIndex((one) => one.key === previous);
        const anchor =
          after === -1 && pass.kind === 'added' && pass.after !== null
            ? order.findIndex((one) => one.key === pass.after)
            : after;
        order.splice(anchor === -1 ? order.length : anchor + 1, 0, pageOf(page.key));
      }
    }
    const positions = new Map(record.map((key, index) => [key, index]));
    placed = order.map((page) => {
      const position = positions.get(page.key);
      return position === undefined
        ? { ...page, side: page.ofBacks ? 'back' : 'front', sheet: null }
        : {
            ...page,
            side: position % 2 === 0 ? 'front' : 'back',
            sheet: Math.floor(position / 2) + 1,
          };
    });
  } else if (mode === 'sets') {
    order.push(...fronts.map((page) => front(page, 'fronts')));
    order.push(...[...backs].reverse().map((page) => back(page, 'backs')));
    placeAdded(order, added, 'backs');
    const divider = order.filter((page) => page.group === 'fronts').length;
    sets = { fronts: divider, backs: order.length - divider, divider };
    placed = order.map((page, index) =>
      index < divider
        ? { ...page, side: 'front', sheet: index + 1 }
        : { ...page, side: 'back', sheet: index - divider + 1 },
    );
  } else {
    const sheets = new Map<string, number | null>();
    fronts.forEach((page, index) => {
      const sheet = index + 1;
      order.push(front(page, null));
      sheets.set(page.key, sheet);
      const pair = backs[n - sheet];
      if (pair !== undefined) {
        order.push(back(pair, null));
        sheets.set(pair.key, sheet);
      }
    });
    for (const extra of backs.slice(n)) {
      order.push(back(extra, null));
      sheets.set(extra.key, null);
    }
    placeAdded(order, added, null);
    placed = order.map((page) => ({
      ...page,
      side: page.ofBacks ? 'back' : 'front',
      sheet: sheets.get(page.key) ?? null,
    }));
  }

  return {
    order: placed.map(({ key, side, sheet, angle, lost, unpaired, addedSet }) => ({
      key,
      side,
      sheet,
      angle,
      lost,
      unpaired,
      addedSet,
    })),
    documents: [{ name: '', start: 0, count: placed.length }],
    sets,
    orderEdited: false,
    hasEdits: backAngle !== 0,
    deleted: 0,
    report: { ...report, groups: sets },
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
