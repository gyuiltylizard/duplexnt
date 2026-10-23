import {
  addedSetsOf,
  blankFlagOf,
  blankSummaryOf,
  NO_VERDICTS,
  passesByKind,
  pendingSetOf,
  type AddedSetReport,
  type AssembledPage,
  type BlankFlag,
  type BlankVerdicts,
  type AssemblyMode,
  type AssemblyReport,
  type PageSnapshot,
  type PassSnapshot,
  type SessionAssembly,
  type SessionEdits,
  type SessionSnapshot,
  type SetsLayout,
} from '@shared';
import {
  documentsOf,
  hasEdits,
  normalizeEdits,
  pageAngle,
  PAIRS_CONTEXT,
  setsContext,
  TRANSIT_CONTEXT,
  visibleKeysOf,
  type EditsContext,
} from './edits';

// Сборка проходов (план M2, U2; KTD-4), добавленные наборы по якорям (план M3.5, U2; KTD-2),
// режимы при несовпадении проходов (план M3.6, U2; KTD2–KTD4), двусторонние добавленные наборы
// (план M4.5, U3; KTD5) и правки поверх (план M3, U2): чистая функция над снимком сессии. Лента,
// документы и отчёт — производное, в журнал не пишутся (ADR 0004); запись сборки `assembled` —
// решение пользователя, из журнала.
//
// Три режима базового порядка (R4), предикат считается на каждом снимке и отдельно не хранится:
// - «пары»: проходов оборотов нет, числа равны или проход оборотов ещё идёт — правило пар, физика
//   разворота (техбаза §5): обороты приходят в обратном порядке, первая страница прохода оборотов
//   — оборот ПОСЛЕДНЕГО листа лицевого прохода; при нехватке непарны младшие листы, лишние обороты
//   идут в конец и не выбрасываются;
// - «раздельные наборы»: обороты есть и числа не равны — лица по порядку, затем обороты обратным
//   порядком подачи, без пар; граница между группами — `edits.divider` или число видимых лиц;
// - «собрано»: `assembled` записана — лента по записи, ключи вне её встают по правилам R6.
//
// Роль прохода — `kind` из журнала (M3.5; ADR 0004, амендмент 2026-10-07), не позиция и не
// чётность номера; роль есть только у прохода со страницами. Блок двустороннего набора (M4.5)
// встаёт по якорю прохода его лиц в любом режиме и внутри себя чередуется тем же правилом пар.

const hasPages = (pass: PassSnapshot): boolean => pass.pages.length > 0;

/** Роли проходов снимка: роль только у прохода со страницами (shared `passesByKind`, KTD-4). */
const rolesOf = (passes: readonly PassSnapshot[]) => passesByKind(passes, hasPages);

/** Роль «обороты» — основной пачки или набора: флаг 180° и оценка детектора (M4.5, KTD4, KTD6). */
const isBacksRole = (pass: PassSnapshot): boolean =>
  pass.kind === 'backs' || pass.kind === 'addedBacks';

/** Есть включённый поворот у какого-либо прохода оборотов со страницами — «Вернуть» его сбросит. */
const rotatedOf = (passes: readonly PassSnapshot[]): boolean =>
  passes.some((pass) => isBacksRole(pass) && hasPages(pass) && pass.rotate180);

type Group = 'fronts' | 'backs';

/** Страница базового порядка: до правок, без угла ручного поворота. */
interface BasePage {
  readonly key: string;
  /** Сторона по проходу: страница прохода роли «обороты» — оборот (в режимах пар и «собрано» для новых ключей). */
  readonly side: 'front' | 'back';
  /**
   * Номер листа по проходу (режим пар) или внутри добавленного набора при чередовании (M4.5);
   * пометка непарного считается по нему во всех режимах.
   */
  readonly sheet: number | null;
  /** Страница прохода роли «обороты»: оценивается детектором (KTD9) в любом режиме. */
  readonly ofBacks: boolean;
  /** Флаг 180° прохода страницы (KTD-2; M4.5, KTD4 — у каждой пары свой); у лиц всегда `false`. */
  readonly rotate180: boolean;
  readonly lost: boolean;
  /** Группа базового порядка в режиме раздельных наборов; в остальных режимах — `null`. */
  readonly group: Group | null;
}

export interface BaseAssembly {
  readonly mode: AssemblyMode;
  readonly pages: readonly BasePage[];
  readonly report: Pick<AssemblyReport, 'fronts' | 'backs' | 'backsState' | 'sets' | 'pendingSet'>;
  /** Хоть один проход оборотов повёрнут: «Вернуть» есть что сбрасывать (R8, R9). */
  readonly rotated: boolean;
  /** Номер добавленного набора «ДN» по ключу страницы; у лиц и оборотов основной пачки записи нет. */
  readonly addedSetOf: ReadonlyMap<string, number>;
}

/**
 * Режим сессии (R4): запись сборки — «собрано»; иначе проход оборотов со страницами, который не
 * идёт, с числом страниц не равным лицевому — «раздельные наборы»; иначе — «пары». Идущий проход
 * режим не включает: его числа меняются с каждой страницей. `settled` — режим, каким он стал бы,
 * кончись идущий проход прямо сейчас: по нему перебазируются правки посреди досканирования.
 * Пары добавленных наборов на режим сессии не влияют (M4.5): их несовпадение живёт в блоке.
 */
export function modeOf(
  passes: readonly PassSnapshot[],
  assembled: readonly string[] | null,
  settled = false,
): AssemblyMode {
  if (assembled !== null) {
    return 'assembled';
  }
  const { fronts, backs } = rolesOf(passes);
  if (backs === null || (backs.state === 'running' && !settled)) {
    return 'pairs';
  }
  return backs.pages.length === (fronts?.pages.length ?? 0) ? 'pairs' : 'sets';
}

/**
 * Отчёт о проходах — один для всех режимов: правки и режим на числа проходов не влияют (KTD-7).
 * Наборы «ДN» — по `addedSetsOf` (M4.5, KTD5): числа и состояние их проходов, решение,
 * несовпадение; набор, ждущий обороты, — по общему правилу `pendingSetOf`.
 */
function passReport(passes: readonly PassSnapshot[]): BaseAssembly['report'] {
  const { fronts, backs } = rolesOf(passes);
  const byNumber = new Map(passes.map((pass) => [pass.number, pass]));
  const sets = addedSetsOf(passes, hasPages).map((set): AddedSetReport => {
    const setFronts = byNumber.get(set.fronts)?.pages.length ?? 0;
    const setBacks = set.backs === null ? null : (byNumber.get(set.backs) ?? null);
    const setBacksCount = setBacks?.pages.length ?? 0;
    return {
      set: set.set,
      fronts: setFronts,
      backs: setBacksCount,
      backsState: setBacks?.state ?? null,
      decision: set.decision,
      mismatch: setBacksCount > 0 && setBacksCount !== setFronts,
      sides: set.sides,
    };
  });
  return {
    fronts: fronts?.pages.length ?? 0,
    backs: backs?.pages.length ?? 0,
    backsState: backs?.state ?? null,
    sets,
    pendingSet: pendingSetOf(passes, hasPages, (pass) => pass.state)?.set ?? null,
  };
}

const frontPage = (page: PageSnapshot, sheet: number | null, group: Group | null): BasePage => ({
  key: page.key,
  side: 'front',
  sheet,
  ofBacks: false,
  rotate180: false,
  lost: page.lost,
  group,
});

const backPage = (
  page: PageSnapshot,
  pass: PassSnapshot,
  sheet: number | null,
  group: Group | null,
): BasePage => ({
  key: page.key,
  side: 'back',
  sheet,
  ofBacks: true,
  rotate180: pass.rotate180,
  lost: page.lost,
  group,
});

/**
 * Блок добавленного набора без группы (её ставит `placeAdded`). Односторонний или ждущий
 * обороты — лица подряд. Двусторонний (M4.5, KTD5): при равном числе страниц — чередование
 * «лицо i, оборот i» (оборот листа i — страница F−1−i прохода оборотов: физика разворота, как у
 * основной пачки), лист — номер внутри набора; иначе — подблок лиц в порядке сканирования, затем
 * подблок оборотов в порядке документа (обратном подаче), без листов. `settled`-проекция идущего
 * прохода оборотов набора — всегда подблоки (R12; ревью M3.6, #1): новый оборот при явном порядке
 * встаёт за соседом по проходу, не за лицом из чередования.
 */
function setBlockOf(
  fronts: PassSnapshot,
  backs: PassSnapshot | null,
  settled: boolean,
): BasePage[] {
  if (backs === null) {
    return fronts.pages.map((page) => frontPage(page, null, null));
  }
  const interleaved =
    backs.pages.length === fronts.pages.length && !(settled && backs.state === 'running');
  if (interleaved) {
    return fronts.pages.flatMap((front, index) => {
      const back = backs.pages[fronts.pages.length - 1 - index];
      return back === undefined
        ? [frontPage(front, index + 1, null)]
        : [frontPage(front, index + 1, null), backPage(back, backs, index + 1, null)];
    });
  }
  return [
    ...fronts.pages.map((page) => frontPage(page, null, null)),
    ...[...backs.pages].reverse().map((page) => backPage(page, backs, null, null)),
  ];
}

/**
 * Блоки добавленных наборов по номеру «ДN» (порядок номера прохода лиц): блок встаёт буквально
 * сразу за якорем прохода лиц — перед наборами, прикреплёнными к нему раньше; якорь внутри чужого
 * блока — сразу за ним; якоря нет (`null`, страница ушла из сессии, ключ более позднего прохода) —
 * в конец. Досканированный сегмент — в конце своего прохода (страницы прохода идут подряд).
 * Удалённая правкой или потерянная страница якорем быть может: правки накладываются позже,
 * потерянная стоит на своём месте. Группа блока — группа якоря; без якоря — последняя. `include`
 * отбирает наборы (режим «собрано» ставит блоком только наборы целиком вне записи).
 */
function placeAdded(
  pages: BasePage[],
  passes: readonly PassSnapshot[],
  groupOfEnd: Group | null,
  settled: boolean,
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
      fronts.after === null ? -1 : pages.findIndex((page) => page.key === fronts.after);
    const group = anchor === -1 ? groupOfEnd : (pages[anchor]?.group ?? null);
    const block = setBlockOf(fronts, backs, settled).map((page) => ({ ...page, group }));
    pages.splice(anchor === -1 ? pages.length : anchor + 1, 0, ...block);
  }
}

/**
 * Осиротевшие обороты набора (M4.5; ADR 0004, амендмент 2026-10-23): ссылка пары ведёт к проходу,
 * которого среди лиц со страницами нет (сегмент отброшен, журнал пересобран) — в конец ленты
 * стороной «оборот», в порядке документа, без тега набора. Ничего не выбрасывается.
 */
function placeOrphans(
  pages: BasePage[],
  passes: readonly PassSnapshot[],
  group: Group | null,
): void {
  const paired = new Set(addedSetsOf(passes, hasPages).map((set) => set.backs));
  for (const pass of rolesOf(passes).addedBacks) {
    if (!paired.has(pass.number)) {
      pages.push(...[...pass.pages].reverse().map((page) => backPage(page, pass, null, group)));
    }
  }
}

/** Номер набора «ДN» по ключу страницы — лиц и оборотов набора (M4.5, R13). */
function addedSetMapOf(passes: readonly PassSnapshot[]): ReadonlyMap<string, number> {
  const byNumber = new Map(passes.map((pass) => [pass.number, pass]));
  const addedSetOf = new Map<string, number>();
  for (const set of addedSetsOf(passes, hasPages)) {
    for (const number of [set.fronts, set.backs]) {
      for (const page of byNumber.get(number ?? -1)?.pages ?? []) {
        addedSetOf.set(page.key, set.set);
      }
    }
  }
  return addedSetOf;
}

/** Режим пар (M2, KTD-4): лицо i, оборот i; лишние обороты — в конец; добавленные — по якорям. */
function pairsBase(passes: readonly PassSnapshot[], settled: boolean): BaseAssembly {
  const { fronts: frontsPass, backs: backsPass } = rolesOf(passes);
  const fronts = frontsPass?.pages ?? [];
  const backs = backsPass?.pages ?? [];
  const pages: BasePage[] = [];
  for (const [index, front] of fronts.entries()) {
    pages.push(frontPage(front, front.number, null));
    // Оборот листа i (с нуля) — страница F−1−i прохода оборотов: пары от его начала.
    const back = backs[fronts.length - 1 - index];
    if (back !== undefined && backsPass !== null) {
      pages.push(backPage(back, backsPass, front.number, null));
    }
  }
  // Лишние обороты — в конец набора, в порядке получения; их листы неизвестны.
  if (backsPass !== null) {
    for (const extra of backs.slice(fronts.length)) {
      pages.push(backPage(extra, backsPass, null, null));
    }
  }
  placeAdded(pages, passes, null, settled);
  placeOrphans(pages, passes, null);
  return {
    mode: 'pairs',
    pages,
    report: passReport(passes),
    rotated: rotatedOf(passes),
    addedSetOf: addedSetMapOf(passes),
  };
}

/**
 * Режим раздельных наборов (M3.6, R5): лица в порядке сканирования, затем обороты обратным
 * порядком подачи (оборот последнего листа — первый, досканированный сегмент — в начале показанной
 * группы); добавленные наборы — по якорю в группе якоря, без якоря — в конец группы оборотов.
 * Номер листа по проходу остаётся у лиц ради пометки непарного; сторону и номер в наборе лента
 * считает по позиции против границы.
 */
function setsBase(passes: readonly PassSnapshot[], settled: boolean): BaseAssembly {
  const { fronts: frontsPass, backs: backsPass } = rolesOf(passes);
  const pages: BasePage[] = [
    ...(frontsPass?.pages ?? []).map((page) => frontPage(page, page.number, 'fronts')),
    ...(backsPass === null
      ? []
      : [...backsPass.pages].reverse().map((page) => backPage(page, backsPass, null, 'backs'))),
  ];
  placeAdded(pages, passes, 'backs', settled);
  placeOrphans(pages, passes, 'backs');
  return {
    mode: 'sets',
    pages,
    report: passReport(passes),
    rotated: rotatedOf(passes),
    addedSetOf: addedSetMapOf(passes),
  };
}

/**
 * Режим «собрано» (M3.6, R6): лента — запись сборки без исчезнувших ключей. Ключи вне записи:
 * страница вслед за предыдущей страницей своего прохода (досканированный сегмент) — сразу за ней;
 * добавленный набор целиком вне записи — блоком по якорю лиц (правило M3.5; пара — с чередованием,
 * M4.5 KTD5); первая страница набора, которого запись коснулась, — по якорю, остальное — за
 * предыдущей; иначе — в конец. Сторона — по проходу; лист считается по позиции в записи
 * (`assembleSession`), у блока пары вне записи — внутри набора.
 */
function assembledBase(passes: readonly PassSnapshot[], record: readonly string[]): BaseAssembly {
  const counted = passes.filter(hasPages);
  const origin = new Map(
    counted.flatMap((pass) =>
      pass.pages.map((page, index) => [
        page.key,
        { pass, previous: pass.pages[index - 1]?.key ?? null, lost: page.lost },
      ]),
    ),
  );
  const pageOf = (key: string): BasePage => {
    const known = origin.get(key);
    const ofBacks = known !== undefined && isBacksRole(known.pass);
    return {
      key,
      side: ofBacks ? 'back' : 'front',
      sheet: null,
      ofBacks,
      rotate180: known !== undefined && ofBacks && known.pass.rotate180,
      lost: known?.lost ?? false,
      group: null,
    };
  };

  const placed = new Set<string>();
  const pages: BasePage[] = [];
  for (const key of record) {
    if (origin.has(key) && !placed.has(key)) {
      placed.add(key);
      pages.push(pageOf(key));
    }
  }
  // Наборы, ни одной страницы которых в записи нет, встают блоком; их проходы ниже пропускаются.
  const byNumber = new Map(passes.map((pass) => [pass.number, pass]));
  const outside = new Set(
    addedSetsOf(passes, hasPages)
      .filter((set) =>
        [set.fronts, set.backs].every(
          (number) =>
            number === null ||
            (byNumber.get(number)?.pages ?? []).every((page) => !placed.has(page.key)),
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
      if (placed.has(page.key)) {
        continue;
      }
      const previous = origin.get(page.key)?.previous ?? null;
      const after = previous === null ? -1 : pages.findIndex((one) => one.key === previous);
      const anchor =
        after === -1 &&
        (pass.kind === 'added' || pass.kind === 'addedFronts') &&
        pass.after !== null
          ? pages.findIndex((one) => one.key === pass.after)
          : after;
      placed.add(page.key);
      pages.splice(anchor === -1 ? pages.length : anchor + 1, 0, pageOf(page.key));
    }
  }
  placeAdded(pages, passes, null, false, (set) => outside.has(set));
  return {
    mode: 'assembled',
    pages,
    report: passReport(passes),
    rotated: rotatedOf(passes),
    addedSetOf: addedSetMapOf(passes),
  };
}

/**
 * Базовый порядок по режиму — то, против чего нормализуются правки (хранилище, сверка). С
 * `settled` идущий проход оборотов раскладывается так, как ляжет по его окончании при нынешних
 * числах (R9; ревью M3.6, #1): новый оборот при явном порядке встаёт за своим соседом по проходу —
 * в группу оборотов, — а не за лицом из чередования пар.
 */
export function baseAssembly(
  passes: readonly PassSnapshot[],
  assembled: readonly string[] | null,
  settled = false,
): BaseAssembly {
  switch (modeOf(passes, assembled, settled)) {
    case 'assembled':
      return assembledBase(passes, assembled ?? []);
    case 'sets':
      return setsBase(passes, settled);
    default:
      return pairsBase(passes, settled);
  }
}

export const baseKeysOf = (base: BaseAssembly): string[] => base.pages.map((page) => page.key);

/**
 * Автоматическая граница наборов (KTD3): число видимых страниц группы лиц по базовому порядку;
 * `null` вне режима раздельных наборов. Ручной порядок на неё не влияет — только удаления.
 */
export function autoDividerOf(base: BaseAssembly, edits: SessionEdits): number | null {
  if (base.mode !== 'sets') {
    return null;
  }
  const fronts = new Set(
    base.pages.filter((page) => page.group === 'fronts').map((page) => page.key),
  );
  return visibleKeysOf(baseKeysOf(base), edits).filter((key) => fronts.has(key)).length;
}

/**
 * Контекст нормализации правок (R8): раздельные наборы — с авто-границей; идущий проход оборотов
 * — переходный (режим «пары», правки не обрезаются); иначе — пары.
 */
export function editsContextOf(
  base: BaseAssembly,
  passes: readonly PassSnapshot[],
  edits: SessionEdits,
  auto: number | null = autoDividerOf(base, edits),
): EditsContext {
  if (auto !== null) {
    return setsContext(auto);
  }
  return base.mode === 'pairs' && rolesOf(passes).backs?.state === 'running'
    ? TRANSIT_CONTEXT
    : PAIRS_CONTEXT;
}

/**
 * Группы видимой ленты (R10): граница — явная из правок или автоматическая (`auto`); вне
 * режима раздельных наборов — `null`. Одно правило на снимок и на команду «Собрать документ».
 */
export function setsLayoutOf(
  visible: readonly string[],
  edits: SessionEdits,
  auto: number | null,
): SetsLayout | null {
  if (auto === null) {
    return null;
  }
  const divider = edits.divider ?? auto;
  return { fronts: divider, backs: visible.length - divider, divider };
}

/**
 * Запись сборки (R7, KTD4): чередование _лицо i, оборот i_ по видимым страницам групп в их
 * текущем порядке (остаток большей группы — в конец); каждая удалённая правкой страница — сразу
 * после ближайшего видимого предшественника в полном порядке ленты (с удалёнными), без
 * предшественника — перед первой. Так «Вернуть» и Ctrl+Z после сборки вернут её на место, а не в
 * конец. Группа удалённой — позиционная, как у видимых.
 */
export function frozenSequenceOf(
  baseKeys: readonly string[],
  edits: SessionEdits,
  divider: number,
): string[] {
  const visible = visibleKeysOf(baseKeys, edits);
  const fronts = visible.slice(0, divider);
  const backs = visible.slice(divider);
  const sequence: string[] = [];
  for (let index = 0; index < Math.max(fronts.length, backs.length); index += 1) {
    for (const key of [fronts[index], backs[index]]) {
      if (key !== undefined) {
        sequence.push(key);
      }
    }
  }
  // Удалённые — в полном порядке ленты; обход с конца ставит соседей по одному предшественнику в
  // порядке ленты.
  const shown = new Set(visible);
  const full = visibleKeysOf(baseKeys, { ...edits, deleted: [] });
  for (let index = full.length - 1; index >= 0; index -= 1) {
    const key = full[index] ?? '';
    if (shown.has(key)) {
      continue;
    }
    let at = 0;
    for (let back = index - 1; back >= 0; back -= 1) {
      const previous = full[back] ?? '';
      if (shown.has(previous)) {
        at = sequence.indexOf(previous) + 1;
        break;
      }
    }
    sequence.splice(at, 0, key);
  }
  return sequence;
}

/**
 * Сборка сессии: базовый порядок по режиму, поверх него правки (M3, U2), документы по разрезам
 * или группы по границе и отчёт. Отчёт о проходах — о сканировании, не о ленте: правки его не
 * меняют (KTD-7); группы — живые счётчики видимой ленты (R10).
 *
 * Пустые обороты (M4, R10, KTD4, KTD9; M4.5, KTD6): флаг получает только страница прохода роли
 * «обороты» — основной пачки или набора — по вердикту детектора и режиму сессии; пометка «не
 * пустая» (`edits.notBlank`) флаг снимает; в режиме раздельных наборов скрытие не действует —
 * только метка (в подблоках несовпавшего набора скрытие действует: сборки впереди нет). Лента,
 * разрезы, граница и номера листов считаются по полной видимой ленте: скрытие их не двигает,
 * показ — фильтр renderer. Потерянная страница не оценивается: не пуста и оценки не ждёт.
 */
export function assembleSession(
  session: SessionSnapshot,
  blank: BlankVerdicts = NO_VERDICTS,
): SessionAssembly {
  const base = baseAssembly(session.passes, session.assembled);
  const byKey = new Map(base.pages.map((page) => [page.key, page]));
  const baseKeys = [...byKey.keys()];
  // Снимок уже несёт канонические правки (их нормализует хранилище); повтор дешёв и страхует
  // сборку от мёртвых ключей при любом источнике снимка.
  const autoDivider = autoDividerOf(base, session.edits);
  const edits = normalizeEdits(
    baseKeys,
    session.edits,
    editsContextOf(base, session.passes, session.edits, autoDivider),
  );
  const visible = visibleKeysOf(baseKeys, edits);
  const sets = setsLayoutOf(visible, edits, autoDivider);
  const divider = sets?.divider ?? null;
  // Режим «собрано»: сторона и лист — по позиции в видимом чередовании записи (R11): удалённые
  // позиций не занимают, ключи вне записи — лист по блоку (пара набора) или без листа.
  const hidden = new Set(edits.deleted);
  const recorded = new Set(session.assembled ?? []);
  const recordPosition = new Map(
    (base.mode === 'assembled' ? baseKeys : [])
      .filter((key) => recorded.has(key) && !hidden.has(key))
      .map((key, index) => [key, index]),
  );

  // Флаг пустого оборота — общее правило с зеркалом renderer'а (`blankFlagOf`); ожидание
  // считается в сводку, в ленте такая страница обычная.
  const { blankMode } = session;
  const notBlank = new Set(edits.notBlank);
  const blankFlags: (BlankFlag | 'pending')[] = [];
  const flagOf = (page: BasePage): BlankFlag => {
    const flag = blankFlagOf({
      mode: blankMode,
      ofBacks: page.ofBacks,
      lost: page.lost,
      verdict: blank.get(page.key),
      notBlank: notBlank.has(page.key),
      inSets: sets !== null,
    });
    blankFlags.push(flag);
    return flag === 'pending' ? null : flag;
  };

  const order: AssembledPage[] = visible.flatMap((key, index) => {
    const page = byKey.get(key);
    if (page === undefined) {
      return [];
    }
    const position = recordPosition.get(key);
    const placed =
      divider !== null
        ? // Раздельные наборы: по группе — лицо или оборот, номер в наборе от 1.
          index < divider
          ? { side: 'front' as const, sheet: index + 1 }
          : { side: 'back' as const, sheet: index - divider + 1 }
        : position !== undefined
          ? {
              side: position % 2 === 0 ? ('front' as const) : ('back' as const),
              sheet: Math.floor(position / 2) + 1,
            }
          : { side: page.side, sheet: page.sheet };
    return [
      {
        key,
        ...placed,
        angle: pageAngle(edits.rotations[key], page.rotate180),
        lost: page.lost,
        addedSet: base.addedSetOf.get(key) ?? null,
        blank: flagOf(page),
      },
    ];
  });

  return {
    order,
    documents: documentsOf(order.length, edits),
    sets,
    orderEdited: edits.order.length > 0,
    hasEdits: hasEdits(edits, base.rotated),
    deleted: edits.deleted.length,
    report: {
      ...base.report,
      mode: base.mode,
      groups: sets,
      backsDeclined: session.backsDeclined,
      mismatch: base.mode === 'sets',
    },
    blank: blankSummaryOf(blankMode, blankFlags),
  };
}
