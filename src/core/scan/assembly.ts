import {
  passesByKind,
  type AssembledPage,
  type AssemblyMode,
  type AssemblyReport,
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
// режимы при несовпадении проходов (план M3.6, U2; KTD2–KTD4) и правки поверх (план M3, U2):
// чистая функция над снимком сессии. Лента, документы и отчёт — производное, в журнал не пишутся
// (ADR 0004); запись сборки `assembled` — решение пользователя, из журнала.
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
// чётность номера; роль есть только у прохода со страницами.

/** Роли проходов снимка: роль только у прохода со страницами (shared `passesByKind`, KTD-4). */
const rolesOf = (passes: readonly PassSnapshot[]) =>
  passesByKind(passes, (pass) => pass.pages.length > 0);

type Group = 'fronts' | 'backs';

/** Страница базового порядка: до правок, без угла ручного поворота. */
interface BasePage {
  readonly key: string;
  /** Сторона по проходу: страница прохода оборотов — оборот (в режимах пар и «собрано» для новых ключей). */
  readonly side: 'front' | 'back';
  /** Номер листа по проходу (режим пар); пометка непарного считается по нему во всех режимах. */
  readonly sheet: number | null;
  /** Страница прохода оборотов: на неё ложится его флаг 180° (KTD-2) в любом режиме. */
  readonly ofBacks: boolean;
  readonly lost: boolean;
  /** Группа базового порядка в режиме раздельных наборов; в остальных режимах — `null`. */
  readonly group: Group | null;
}

export interface BaseAssembly {
  readonly mode: AssemblyMode;
  readonly pages: readonly BasePage[];
  readonly report: Pick<AssemblyReport, 'fronts' | 'backs' | 'backsState'>;
  readonly rotateBacks: boolean;
  /** Номер добавленного набора по ключу страницы (от 1); у лиц и оборотов записи нет. */
  readonly addedSetOf: ReadonlyMap<string, number>;
}

/**
 * Режим сессии (R4): запись сборки — «собрано»; иначе проход оборотов со страницами, который не
 * идёт, с числом страниц не равным лицевому — «раздельные наборы»; иначе — «пары». Идущий проход
 * режим не включает: его числа меняются с каждой страницей. `settled` — режим, каким он стал бы,
 * кончись идущий проход прямо сейчас: по нему перебазируются правки посреди досканирования.
 */
function modeOf(
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

/** Отчёт о проходах — один для всех режимов: правки и режим на числа проходов не влияют (KTD-7). */
function passReport(passes: readonly PassSnapshot[]): BaseAssembly['report'] {
  const { fronts, backs } = rolesOf(passes);
  return {
    fronts: fronts?.pages.length ?? 0,
    backs: backs?.pages.length ?? 0,
    backsState: backs?.state ?? null,
  };
}

/**
 * Блоки добавленных наборов по возрастанию номера прохода: блок встаёт буквально сразу за
 * якорем — перед наборами, прикреплёнными к нему раньше; якорь внутри чужого блока — сразу за
 * ним; якоря нет (`null`, страница ушла из сессии, ключ более позднего прохода) — в конец.
 * Досканированный сегмент — в конце блока своего прохода (страницы прохода идут подряд).
 * Удалённая правкой или потерянная страница якорем быть может: правки накладываются позже,
 * потерянная стоит на своём месте. Группа блока — группа якоря; без якоря — последняя.
 */
function placeAdded(
  pages: BasePage[],
  added: readonly PassSnapshot[],
  groupOfEnd: Group | null,
): ReadonlyMap<string, number> {
  const addedSetOf = new Map<string, number>();
  added.forEach((pass, index) => {
    const anchor = pass.after === null ? -1 : pages.findIndex((page) => page.key === pass.after);
    const group = anchor === -1 ? groupOfEnd : (pages[anchor]?.group ?? null);
    const block = pass.pages.map((page): BasePage => ({
      key: page.key,
      side: 'front',
      sheet: null,
      ofBacks: false,
      lost: page.lost,
      group,
    }));
    for (const page of block) {
      addedSetOf.set(page.key, index + 1);
    }
    pages.splice(anchor === -1 ? pages.length : anchor + 1, 0, ...block);
  });
  return addedSetOf;
}

/** Режим пар (M2, KTD-4): лицо i, оборот i; лишние обороты — в конец; добавленные — по якорям. */
function pairsBase(passes: readonly PassSnapshot[]): BaseAssembly {
  const { fronts: frontsPass, backs: backsPass, added } = rolesOf(passes);
  const fronts = frontsPass?.pages ?? [];
  const backs = backsPass?.pages ?? [];
  const pages: BasePage[] = [];
  for (const [index, front] of fronts.entries()) {
    pages.push({
      key: front.key,
      side: 'front',
      sheet: front.number,
      ofBacks: false,
      lost: front.lost,
      group: null,
    });
    // Оборот листа i (с нуля) — страница F−1−i прохода оборотов: пары от его начала.
    const back = backs[fronts.length - 1 - index];
    if (back !== undefined) {
      pages.push({
        key: back.key,
        side: 'back',
        sheet: front.number,
        ofBacks: true,
        lost: back.lost,
        group: null,
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
      group: null,
    });
  }
  const addedSetOf = placeAdded(pages, added, null);
  return {
    mode: 'pairs',
    pages,
    report: passReport(passes),
    rotateBacks: backsPass?.rotate180 ?? false,
    addedSetOf,
  };
}

/**
 * Режим раздельных наборов (M3.6, R5): лица в порядке сканирования, затем обороты обратным
 * порядком подачи (оборот последнего листа — первый, досканированный сегмент — в начале показанной
 * группы); добавленные наборы — по якорю в группе якоря, без якоря — в конец группы оборотов.
 * Номер листа по проходу остаётся у лиц ради пометки непарного; сторону и номер в наборе лента
 * считает по позиции против границы.
 */
function setsBase(passes: readonly PassSnapshot[]): BaseAssembly {
  const { fronts: frontsPass, backs: backsPass, added } = rolesOf(passes);
  const pages: BasePage[] = [
    ...(frontsPass?.pages ?? []).map((page): BasePage => ({
      key: page.key,
      side: 'front',
      sheet: page.number,
      ofBacks: false,
      lost: page.lost,
      group: 'fronts',
    })),
    ...[...(backsPass?.pages ?? [])].reverse().map((page): BasePage => ({
      key: page.key,
      side: 'back',
      sheet: null,
      ofBacks: true,
      lost: page.lost,
      group: 'backs',
    })),
  ];
  const addedSetOf = placeAdded(pages, added, 'backs');
  return {
    mode: 'sets',
    pages,
    report: passReport(passes),
    rotateBacks: backsPass?.rotate180 ?? false,
    addedSetOf,
  };
}

/**
 * Режим «собрано» (M3.6, R6): лента — запись сборки без исчезнувших ключей. Ключи вне записи:
 * страница вслед за предыдущей страницей своего прохода (досканированный сегмент) — сразу за ней;
 * первая страница добавленного набора без предыдущей в записи — блок по якорю (правило M3.5);
 * иначе — в конец. Сторона — по проходу; лист считается по позиции в записи (`assembleSession`).
 */
function assembledBase(passes: readonly PassSnapshot[], record: readonly string[]): BaseAssembly {
  const { backs: backsPass, added } = rolesOf(passes);
  const counted = passes.filter((pass) => pass.pages.length > 0);
  const origin = new Map(
    counted.flatMap((pass) =>
      pass.pages.map((page, index) => [
        page.key,
        { pass, previous: pass.pages[index - 1]?.key ?? null, lost: page.lost },
      ]),
    ),
  );
  const addedSetOf = new Map<string, number>();
  added.forEach((pass, index) => {
    for (const page of pass.pages) {
      addedSetOf.set(page.key, index + 1);
    }
  });
  const pageOf = (key: string): BasePage => {
    const known = origin.get(key);
    const ofBacks = known?.pass.kind === 'backs';
    return {
      key,
      side: ofBacks ? 'back' : 'front',
      sheet: null,
      ofBacks,
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
  for (const pass of counted) {
    for (const page of pass.pages) {
      if (placed.has(page.key)) {
        continue;
      }
      const previous = origin.get(page.key)?.previous ?? null;
      const after = previous === null ? -1 : pages.findIndex((one) => one.key === previous);
      const anchor =
        after === -1 && pass.kind === 'added' && pass.after !== null
          ? pages.findIndex((one) => one.key === pass.after)
          : after;
      placed.add(page.key);
      pages.splice(anchor === -1 ? pages.length : anchor + 1, 0, pageOf(page.key));
    }
  }
  return {
    mode: 'assembled',
    pages,
    report: passReport(passes),
    rotateBacks: backsPass?.rotate180 ?? false,
    addedSetOf,
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
      return setsBase(passes);
    default:
      return pairsBase(passes);
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
 */
export function assembleSession(session: SessionSnapshot): SessionAssembly {
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
  // позиций не занимают, ключи вне записи — без листа.
  const hidden = new Set(edits.deleted);
  const recorded = new Set(session.assembled ?? []);
  const recordPosition = new Map(
    (base.mode === 'assembled' ? baseKeys : [])
      .filter((key) => recorded.has(key) && !hidden.has(key))
      .map((key, index) => [key, index]),
  );

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
          : { side: page.side, sheet: base.mode === 'assembled' ? null : page.sheet };
    return [
      {
        key,
        ...placed,
        angle: pageAngle(edits.rotations[key], page.ofBacks && base.rotateBacks),
        lost: page.lost,
        addedSet: base.addedSetOf.get(key) ?? null,
      },
    ];
  });

  return {
    order,
    documents: documentsOf(order.length, edits),
    sets,
    orderEdited: edits.order.length > 0,
    hasEdits: hasEdits(edits, base.rotateBacks),
    deleted: edits.deleted.length,
    report: {
      ...base.report,
      mode: base.mode,
      groups: sets,
      backsDeclined: session.backsDeclined,
      mismatch: base.mode === 'sets',
    },
  };
}
