import {
  addedSetReportOf,
  addedSetsOf,
  blankFlagOf,
  blankSummaryOf,
  EMPTY_EDITS,
  hasPages,
  isAnchoredKind,
  isBacksKind,
  NO_VERDICTS,
  pendingSetOf,
  sameEdits,
  type AddedSetReport,
  type AssembledDocument,
  type AssembledPage,
  type AssemblyMode,
  type BlankFlag,
  type BlankSummary,
  type BlankVerdicts,
  type PageSnapshot,
  type PassSnapshot,
  type SessionAssembly,
  type SessionSnapshot,
  type SetsLayout,
} from '@shared';
import { rolesOf } from './screen';

/** Сводка пустых оборотов без оценок и при «Оставлять» (M4). */
export const NO_BLANK: BlankSummary = { mode: 'keep', found: 0, hidden: 0, pending: 0 };

/** Пустая лента без правок: основа для снимков, где важен только отчёт. */
export const NO_EDITS_ASSEMBLY: Omit<SessionAssembly, 'report'> = {
  order: [],
  documents: [{ name: '', start: 0, count: 0 }],
  sets: null,
  orderEdited: false,
  hasEdits: false,
  deleted: 0,
  blank: NO_BLANK,
};

const isBacksRole = (pass: PassSnapshot): boolean => isBacksKind(pass.kind);

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

interface MirrorPage extends Omit<AssembledPage, 'side' | 'blank'> {
  readonly group: 'fronts' | 'backs' | null;
  readonly ofBacks: boolean;
}

/**
 * Флаги пустых оборотов поверх ленты — тем же правилом `blankFlagOf`, что и ядро (M4, R10,
 * KTD4, KTD9); зеркало добавляет только сторону по проходу (`ofBacks`) и режим наборов.
 */
function withBlankFlags(
  session: SessionSnapshot,
  pages: readonly (AssembledPage & Pick<MirrorPage, 'ofBacks'>)[],
  sets: SetsLayout | null,
  blank: BlankVerdicts,
): { readonly order: AssembledPage[]; readonly summary: BlankSummary } {
  const notBlank = new Set(session.edits.notBlank);
  const flags: (BlankFlag | 'pending')[] = [];
  const order = pages.map(({ ofBacks, ...page }): AssembledPage => {
    const flag = blankFlagOf({
      mode: session.blankMode,
      ofBacks,
      lost: page.lost,
      verdict: blank.get(page.key),
      notBlank: notBlank.has(page.key),
      inSets: sets !== null,
    });
    flags.push(flag);
    return { ...page, blank: flag === 'pending' ? null : flag };
  });
  return { order, summary: blankSummaryOf(session.blankMode, flags) };
}

const frontOf = (
  page: PageSnapshot,
  group: MirrorPage['group'],
  sheet: number | null = null,
  addedSet: number | null = null,
): MirrorPage => ({
  key: page.key,
  sheet,
  angle: 0,
  lost: page.lost,
  addedSet,
  group,
  ofBacks: false,
});

const backOf = (
  page: PageSnapshot,
  pass: PassSnapshot,
  group: MirrorPage['group'],
  sheet: number | null = null,
  addedSet: number | null = null,
): MirrorPage => ({
  key: page.key,
  sheet,
  angle: pass.rotate180 ? 180 : 0,
  lost: page.lost,
  addedSet,
  group,
  ofBacks: true,
});

/** Блок набора «ДN» (M4.5): чередование при равном числе страниц, иначе подблоки лиц и оборотов. */
function setBlockOf(fronts: PassSnapshot, backs: PassSnapshot | null, set: number): MirrorPage[] {
  if (backs === null) {
    return fronts.pages.map((page) => frontOf(page, null, null, set));
  }
  if (backs.pages.length === fronts.pages.length) {
    const n = fronts.pages.length;
    return fronts.pages.flatMap((front, index) => {
      const back = backs.pages[n - 1 - index];
      return back === undefined
        ? [frontOf(front, null, index + 1, set)]
        : [frontOf(front, null, index + 1, set), backOf(back, backs, null, index + 1, set)];
    });
  }
  return [
    ...fronts.pages.map((page) => frontOf(page, null, null, set)),
    ...[...backs.pages].reverse().map((page) => backOf(page, backs, null, null, set)),
  ];
}

/** Блоки добавленных наборов — по якорю лиц, без якоря в конец; группа — группа якоря. */
function placeAdded(
  order: MirrorPage[],
  passes: readonly PassSnapshot[],
  end: 'fronts' | 'backs' | null,
  include: (set: number) => boolean = () => true,
): void {
  const byNumber = new Map(passes.map((pass) => [pass.number, pass]));
  for (const set of addedSetsOf(passes, hasPages)) {
    const fronts = byNumber.get(set.fronts);
    if (fronts === undefined || !include(set.set)) {
      continue;
    }
    const backs = set.backs === null ? null : (byNumber.get(set.backs) ?? null);
    const anchor =
      fronts.after === null ? -1 : order.findIndex((page) => page.key === fronts.after);
    const group = anchor === -1 ? end : (order[anchor]?.group ?? null);
    const block = setBlockOf(fronts, backs, set.set).map((page) => ({ ...page, group }));
    order.splice(anchor === -1 ? order.length : anchor + 1, 0, ...block);
  }
}

/** Осиротевшие обороты набора (лиц нет) — в конец стороной «оборот», порядком документа, без тега. */
function placeOrphans(
  order: MirrorPage[],
  passes: readonly PassSnapshot[],
  group: MirrorPage['group'],
): void {
  const paired = new Set(addedSetsOf(passes, hasPages).map((set) => set.backs));
  for (const pass of rolesOf(passes).addedBacks) {
    if (!paired.has(pass.number)) {
      order.push(...[...pass.pages].reverse().map((page) => backOf(page, pass, group)));
    }
  }
}

/** Отчёт по наборам «ДN» и набор, ждущий обороты, — как в ядре (M4.5, KTD5). */
function setsReportOf(passes: readonly PassSnapshot[]): {
  readonly sets: AddedSetReport[];
  readonly pendingSet: number | null;
} {
  const byNumber = new Map(passes.map((pass) => [pass.number, pass]));
  return {
    sets: addedSetsOf(passes, hasPages).map((set) =>
      addedSetReportOf(set, byNumber.get(set.fronts), byNumber.get(set.backs ?? -1) ?? null),
    ),
    pendingSet: pendingSetOf(passes, hasPages, (pass) => pass.state)?.set ?? null,
  };
}

/**
 * ТОЛЬКО ДЛЯ ТЕСТОВ renderer: упрощённое зеркало базового порядка ядра (M2, KTD-4; M3.5, KTD-2;
 * M3.6, KTD2; M4.5, KTD5) — пары: лицевые по порядку, обороты обратным порядком от последнего
 * листа, непарными остаются младшие листы, лишние обороты — в конце; раздельные наборы: лица,
 * затем обороты обратным порядком подачи, граница — число лиц; собрано: лента по записи, новые
 * ключи — за предыдущей страницей своего прохода, набор целиком вне записи — блоком по якорю,
 * иначе в конец; затем блоки добавленных наборов по номеру «ДN», каждый сразу за якорем лиц, без
 * якоря — в конец; двусторонний набор чередуется при равном числе страниц, иначе подблоки;
 * осиротевшие обороты набора — в конец. Правки не применяются: ленту с правками renderer
 * получает из снимка готовой (M3, KTD-2), и тесты с правками строят сборку сами. Настоящая
 * функция живёт в `src/core/scan/assembly.ts` и недоступна renderer'у границей слоёв;
 * расхождение ловит табличный тест `test/guards/assembly-fixture.test.ts` на одних данных.
 */
export function assemblyOf(
  session: SessionSnapshot,
  blank: BlankVerdicts = NO_VERDICTS,
): SessionAssembly {
  const { passes } = session;
  const { fronts: frontsPass, backs: backsPass } = rolesOf(passes);
  const fronts = frontsPass?.pages ?? [];
  const backs = backsPass?.pages ?? [];
  const n = fronts.length;
  const mode = modeOf(session);
  const report = {
    mode,
    fronts: n,
    backs: backs.length,
    backsState: backsPass?.state ?? null,
    backsDeclined: session.backsDeclined,
    mismatch: mode === 'sets',
    ...setsReportOf(passes),
  };

  const order: MirrorPage[] = [];
  let sets: SetsLayout | null = null;
  let placed: (MirrorPage & Pick<AssembledPage, 'side'>)[];
  if (mode === 'assembled') {
    const counted = passes.filter(hasPages);
    const known = new Map(
      counted.flatMap((pass) =>
        pass.pages.map((page, index) => [
          page.key,
          { pass, previous: pass.pages[index - 1]?.key ?? null, page },
        ]),
      ),
    );
    const addedSetByKey = new Map(
      addedSetsOf(passes, hasPages).flatMap((set) =>
        [set.fronts, set.backs].flatMap((number) =>
          (counted.find((pass) => pass.number === number)?.pages ?? []).map(
            (page): [string, number] => [page.key, set.set],
          ),
        ),
      ),
    );
    const pageOf = (key: string): MirrorPage => {
      const origin = known.get(key);
      const ofBacks = origin !== undefined && isBacksRole(origin.pass);
      return {
        key,
        sheet: null,
        angle: ofBacks && origin.pass.rotate180 ? 180 : 0,
        lost: origin?.page.lost ?? false,
        addedSet: addedSetByKey.get(key) ?? null,
        group: null,
        ofBacks,
      };
    };
    const record = (session.assembled ?? []).filter((key) => known.has(key));
    order.push(...record.map(pageOf));
    const inRecord = new Set(record);
    const outside = new Set(
      addedSetsOf(passes, hasPages)
        .filter((set) =>
          [set.fronts, set.backs].every(
            (number) =>
              number === null ||
              (counted.find((pass) => pass.number === number)?.pages ?? []).every(
                (page) => !inRecord.has(page.key),
              ),
          ),
        )
        .map((set) => set.set),
    );
    const blockPasses = new Set(
      addedSetsOf(passes, hasPages)
        .filter((set) => outside.has(set.set))
        .flatMap((set) => [set.fronts, set.backs]),
    );
    for (const pass of counted) {
      if (blockPasses.has(pass.number)) {
        continue;
      }
      for (const page of pass.pages) {
        if (order.some((one) => one.key === page.key)) {
          continue;
        }
        const previous = known.get(page.key)?.previous ?? null;
        const after = previous === null ? -1 : order.findIndex((one) => one.key === previous);
        const anchored = isAnchoredKind(pass.kind);
        const anchor =
          after === -1 && anchored && pass.after !== null
            ? order.findIndex((one) => one.key === pass.after)
            : after;
        order.splice(anchor === -1 ? order.length : anchor + 1, 0, pageOf(page.key));
      }
    }
    placeAdded(order, passes, null, (set) => outside.has(set));
    const positions = new Map(record.map((key, index) => [key, index]));
    placed = order.map((page) => {
      const position = positions.get(page.key);
      return position === undefined
        ? { ...page, side: page.ofBacks ? 'back' : 'front' }
        : {
            ...page,
            side: position % 2 === 0 ? 'front' : 'back',
            sheet: Math.floor(position / 2) + 1,
          };
    });
  } else if (mode === 'sets') {
    order.push(...fronts.map((page) => frontOf(page, 'fronts', page.number)));
    if (backsPass !== null) {
      order.push(...[...backs].reverse().map((page) => backOf(page, backsPass, 'backs')));
    }
    placeAdded(order, passes, 'backs');
    placeOrphans(order, passes, 'backs');
    const divider = order.filter((page) => page.group === 'fronts').length;
    sets = { fronts: divider, backs: order.length - divider, divider };
    placed = order.map((page, index) =>
      index < divider
        ? { ...page, side: 'front', sheet: index + 1 }
        : { ...page, side: 'back', sheet: index - divider + 1 },
    );
  } else {
    fronts.forEach((page, index) => {
      const sheet = index + 1;
      order.push(frontOf(page, null, sheet));
      const pair = backs[n - sheet];
      if (pair !== undefined && backsPass !== null) {
        order.push(backOf(pair, backsPass, null, sheet));
      }
    });
    if (backsPass !== null) {
      for (const extra of backs.slice(n)) {
        order.push(backOf(extra, backsPass, null));
      }
    }
    placeAdded(order, passes, null);
    placeOrphans(order, passes, null);
    placed = order.map((page) => ({ ...page, side: page.ofBacks ? 'back' : 'front' }));
  }

  const flagged = withBlankFlags(
    session,
    placed.map(({ key, side, sheet, angle, lost, addedSet, ofBacks }) => ({
      key,
      side,
      sheet,
      angle,
      lost,
      addedSet,
      blank: null,
      ofBacks,
    })),
    sets,
    blank,
  );
  return {
    order: flagged.order,
    documents: [{ name: '', start: 0, count: placed.length }],
    sets,
    orderEdited: false,
    hasEdits: passes.some((pass) => isBacksRole(pass) && hasPages(pass) && pass.rotate180),
    deleted: 0,
    report: { ...report, groups: sets },
    blank: flagged.summary,
  };
}

/**
 * ТОЛЬКО ДЛЯ ТЕСТОВ: сборка снимка с правками поверх зеркала — как `assembleSession` для
 * сессии с правками (M3, KTD-2; M3.6, R8–R11): явный порядок, затем остальное базовым порядком,
 * без удалённых; углы — базовый плюс ручной; в режиме наборов группы по границе (явная,
 * прижатая к ленте, иначе число видимых страниц базовой группы лиц), сторона и место — по
 * позиции; после сборки — лист по позиции среди не удалённых ключей записи; разрезы в режиме
 * наборов не живут. Расхождение с ядром ловит `test/guards/assembly-fixture.test.ts`.
 */
export function assemblyWithEditsOf(
  session: SessionSnapshot,
  blank: BlankVerdicts = NO_VERDICTS,
): SessionAssembly {
  const auto = assemblyOf(session);
  const { edits } = session;
  // Сторона по проходу — для флага пустого оборота: страница прохода оборотов и после правок она же.
  const backsKeys = new Set(
    session.passes.filter(isBacksRole).flatMap((pass) => pass.pages.map((page) => page.key)),
  );
  const byKey = new Map(auto.order.map((entry) => [entry.key, entry]));
  const explicit = edits.order.flatMap((key) => byKey.get(key) ?? []);
  const placed = new Set(explicit.map((entry) => entry.key));
  const removed = new Set(edits.deleted);
  const ordered = [...explicit, ...auto.order.filter((entry) => !placed.has(entry.key))]
    .filter((entry) => !removed.has(entry.key))
    .map((entry) => {
      const extra = edits.rotations[entry.key] ?? 0;
      return { ...entry, angle: ((entry.angle + extra) % 360) as AssembledPage['angle'] };
    });
  let sets = auto.sets;
  let order = ordered;
  if (auto.sets !== null) {
    const frontKeys = new Set(auto.order.slice(0, auto.sets.divider).map((entry) => entry.key));
    const autoDivider = ordered.filter((entry) => frontKeys.has(entry.key)).length;
    const divider =
      edits.divider === null
        ? autoDivider
        : Math.min(ordered.length, Math.max(0, Math.trunc(edits.divider)));
    sets = { fronts: divider, backs: ordered.length - divider, divider };
    order = ordered.map((entry, index) =>
      index < divider
        ? { ...entry, side: 'front', sheet: index + 1 }
        : { ...entry, side: 'back', sheet: index - divider + 1 },
    );
  } else if (session.assembled !== null) {
    const positions = new Map(
      session.assembled
        .filter((key) => byKey.has(key) && !removed.has(key))
        .map((key, index) => [key, index]),
    );
    order = ordered.map((entry) => {
      const position = positions.get(entry.key);
      return position === undefined
        ? entry
        : {
            ...entry,
            side: position % 2 === 0 ? 'front' : 'back',
            sheet: Math.floor(position / 2) + 1,
          };
    });
  }
  const alive = new Set(auto.order.map((entry) => entry.key));
  const deleted = edits.deleted.filter((key) => alive.has(key)).length;
  const flagged = withBlankFlags(
    session,
    order.map((entry) => ({ ...entry, ofBacks: backsKeys.has(entry.key) })),
    sets,
    blank,
  );
  return {
    ...auto,
    order: flagged.order,
    blank: flagged.summary,
    sets,
    report: { ...auto.report, groups: sets },
    documents:
      sets === null
        ? documentsOf(order.length, edits.cuts, edits.names)
        : documentsOf(order.length),
    orderEdited: edits.order.length > 0,
    hasEdits: auto.hasEdits || !sameEdits(edits, EMPTY_EDITS),
    deleted,
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
