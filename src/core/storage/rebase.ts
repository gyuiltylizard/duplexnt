import { EMPTY_EDITS, isBacksKind, sameEdits } from '@shared';
import { baseAssembly, baseKeysOf, editsContextOf } from '../scan/assembly';
import { rebaseEdits } from '../scan/edits';
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
  // нормализации — по настоящему режиму (идёт проход — переходный). Ключи завершившегося прохода
  // оборотов изымаются из «до» и из порядка: для перебазирования они новые (KTD-6 B-13).
  const finished = previous === null ? null : finishedBacksKeys(previous, cleaned);
  const settledBefore =
    previous === null
      ? null
      : baseKeysOf(baseAssembly(passSnapshotsOf(previous, NOTHING_LOST), previous.assembled, true));
  const before =
    settledBefore === null || finished === null || finished.size === 0
      ? settledBefore
      : settledBefore.filter((key) => !finished.has(key));
  const stripped =
    finished === null || finished.size === 0
      ? cleaned.edits
      : { ...cleaned.edits, order: cleaned.edits.order.filter((key) => !finished.has(key)) };
  const passes = passSnapshotsOf(cleaned, NOTHING_LOST);
  const base = baseAssembly(passes, cleaned.assembled);
  const edits = rebaseEdits(
    before,
    baseKeysOf(baseAssembly(passes, cleaned.assembled, true)),
    stripped,
    editsContextOf(base, passes, stripped),
  );
  return { ...cleaned, edits };
}
