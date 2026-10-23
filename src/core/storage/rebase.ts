import { EMPTY_EDITS, sameEdits } from '@shared';
import { baseAssembly, baseKeysOf, editsContextOf } from '../scan/assembly';
import { rebaseEdits } from '../scan/edits';
import { NOTHING_LOST, pagesOf, passSnapshotsOf, type Journal } from './journal';

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
  const edits = rebaseEdits(
    before,
    baseKeysOf(baseAssembly(passes, cleaned.assembled, true)),
    cleaned.edits,
    editsContextOf(base, passes, cleaned.edits),
  );
  return { ...cleaned, edits };
}
