import { EMPTY_EDITS, isBacksKind, sameEdits, type SessionEdits } from '@shared';
import { baseAssembly, baseKeysOf, editsContextOf } from '../scan/assembly';
import {
  normalizeEdits,
  rebaseEdits,
  rebaseOrder,
  remapCuts,
  visibleKeysOf,
  type EditsContext,
} from '../scan/edits';

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Явный порядок после завершения прохода оборотов (KTD-6 B-13): ключи `finished` изымаются из
 * `order` и расставляются `rebaseOrder` против итоговой базы `after`, как будто пришли все сразу
 * — оборот за своей парой. Разрезы и граница остаются перед той же страницей-последователем, не
 * входящей в проход: разрез перед подблоком оборотов не ложится внутрь чередования, а уходит
 * за лист; остальные ключи порядка не трогаются.
 */
function replaced(
  after: readonly string[],
  edits: SessionEdits,
  finished: ReadonlySet<string>,
  context: EditsContext,
): SessionEdits {
  const kept = (key: string): boolean => !finished.has(key);
  const shownBefore = visibleKeysOf(after, edits);
  const order = rebaseOrder(after.filter(kept), after, edits.order.filter(kept));
  const next = { ...edits, order };
  const shownAfter = visibleKeysOf(after, next);
  // Позиция разреза — среди страниц вне прохода: сколько их стояло до него.
  const keptBefore = shownBefore.filter(kept);
  const translate = (cuts: readonly number[]): number[] =>
    remapCuts(
      keptBefore,
      shownAfter,
      cuts.map((cut) => shownBefore.slice(0, cut).filter(kept).length),
    );
  const divider = edits.divider === null ? null : (translate([edits.divider])[0] ?? null);
  return normalizeEdits(after, { ...next, cuts: translate(edits.cuts), divider }, context);
}
import { NOTHING_LOST, pagesOf, passSnapshotsOf, passStateOf, type Journal } from './journal';

/**
 * Ключи проходов оборотов, вышедших из `running` между журналами (B-13, KTD-6; ADR 0004,
 * амендмент 2026-10-28): основной пачки и наборов. Пока проход шёл, его страницы вставали в явный
 * порядок за соседом по `settled`-проекции — подблоком; по завершении они расставляются заново
 * против итоговой сборки, как будто пришли все сразу, — чередованием. Проход, исчезнувший из
 * `next` («Остановить» на единственном сегменте), ключей не имеет. Проходы лиц не трогаются: их
 * блок одинаков в обеих проекциях. Сверка после сбоя передаёт журнал с диска (`running`) и
 * усыновлённый (`interrupted`) — перестановка один раз, следующий запуск перехода не видит.
 */
function finishedBacksKeys(previous: Journal, next: Journal): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const pass of previous.passes) {
    if (!isBacksKind(pass.kind) || passStateOf(pass) !== 'running') {
      continue;
    }
    const now = next.passes.find((it) => it.number === pass.number);
    if (now === undefined || passStateOf(now) === 'running') {
      continue;
    }
    for (const page of pagesOf(now)) {
      keys.add(page.key);
    }
  }
  return keys;
}

/**
 * Журнал с правками в каноническом виде против своих страниц (M3, KTD-3a, KTD-10; M3.6, R8).
 * Запись сборки чистится от исчезнувших ключей всегда — до раннего выхода. Если состав страниц
 * изменился относительно `previous` не через правку (досканирование, отброс сегмента, сверка),
 * разрезы и граница наборов переезжают вслед за страницами; правки исчезнувших ключей
 * вычищаются. Пустые правки уже канонические — на каждой странице прохода их не пересчитывают.
 * Единственное место нормализации: её зовёт `commit` хранилища и сверка при запуске.
 */
export function withRebasedEdits(previous: Journal | null, next: Journal): Journal {
  let cleaned = next;
  if (next.assembled !== null) {
    const alive = new Set(next.passes.flatMap((pass) => pagesOf(pass).map((page) => page.key)));
    const assembled = next.assembled.filter((key) => alive.has(key));
    if (assembled.length !== next.assembled.length) {
      cleaned = { ...next, assembled };
    }
  }
  if (sameEdits(cleaned.edits, EMPTY_EDITS)) {
    return cleaned;
  }
  // Ключи «до» и «после» — по раскладке, в которой лента окажется после идущего прохода
  // (`settled`): новый ключ встаёт в явный порядок за соседом по будущей группе. Контекст
  // нормализации — по настоящему режиму (идёт проход — переходный).
  const before =
    previous === null
      ? null
      : baseKeysOf(baseAssembly(passSnapshotsOf(previous, NOTHING_LOST), previous.assembled, true));
  const passes = passSnapshotsOf(cleaned, NOTHING_LOST);
  const base = baseAssembly(passes, cleaned.assembled);
  const after = baseKeysOf(baseAssembly(passes, cleaned.assembled, true));
  const context = editsContextOf(base, passes, cleaned.edits);
  const rebased = rebaseEdits(before, after, cleaned.edits, context);
  const finished = previous === null ? NO_KEYS : finishedBacksKeys(previous, cleaned);
  if (finished.size === 0 || rebased.order.length === 0) {
    return { ...cleaned, edits: rebased };
  }
  return { ...cleaned, edits: replaced(after, rebased, finished, context) };
}
