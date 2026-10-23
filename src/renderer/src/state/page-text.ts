import type { AssembledPage, AssemblyMode, PassKind } from '@shared';
import type { TFunction } from 'i18next';

// Словарь страницы ленты — общий для инспектора, экрана и модалки `add` (ревью сессий 3–4):
// тон документа и «что это за страница» теми же словами в ДЕТАЛЯХ, подписи миниатюры и сводке
// якоря. С M3.6 (KTD9) слова зависят от режима сборки: до сборки — сторона по группе и место в
// наборе, после — лист по записи сборки; тег «об»/«Д1» — происхождение (R11), его здесь нет.
// С M4.5 (R13) страница двустороннего набора называет сторону и лист внутри набора: пара ли
// это, говорит происхождение страницы (`addedFronts` / `addedBacks`) — у страницы ленты
// одностороннего и несовпавшего набора одинаковые `side` и `sheet: null`.

/** Тон документа по номеру с нуля: четыре цвета по кругу (handoff M3, Anatomy). */
export const toneOf = (document: number): string => `doc-tone--${String((document % 4) + 1)}`;

/** Страница двустороннего набора — по роли её прохода (M4.5). */
export const isPairKind = (origin: PassKind | null): boolean =>
  origin === 'addedFronts' || origin === 'addedBacks';

/**
 * Что это за страница — заголовок ДЕТАЛЕЙ без «Стр. N —»; теми же словами подпись миниатюры и
 * сводка модалки `add` называют якорь. Режим наборов: «лицевая, 3-я в наборе лиц», «оборотная,
 * 4-я в наборе оборотов», «добавленный набор 1, в наборе оборотов» (`sheet` — место в группе).
 * Пары и собрано: «лицо листа 4», «оборот листа 4», «добавленный набор 1»; страница пары —
 * «оборот листа 2 набора Д1», в подблоках несовпавшего набора — «оборотная набора Д1» (M4.5);
 * страница без листа (новая после сборки) — «лицевая, без листа»: «листа 0» не бывает.
 */
export function whatOf(
  t: TFunction,
  entry: Pick<AssembledPage, 'side' | 'sheet' | 'addedSet'>,
  mode: AssemblyMode,
  origin: PassKind | null = null,
): string {
  const back = entry.side === 'back';
  if (mode === 'sets') {
    if (entry.addedSet !== null) {
      return t(back ? 'inspector.what.setAddedBacks' : 'inspector.what.setAddedFronts', {
        set: entry.addedSet,
      });
    }
    return t(back ? 'inspector.what.setBack' : 'inspector.what.setFront', {
      position: entry.sheet ?? 0,
    });
  }
  if (entry.addedSet !== null) {
    if (!isPairKind(origin)) {
      return t('inspector.what.added', { set: entry.addedSet });
    }
    if (entry.sheet === null) {
      return t(back ? 'inspector.what.addedBackLoose' : 'inspector.what.addedFrontLoose', {
        set: entry.addedSet,
      });
    }
    return t(back ? 'inspector.what.addedBack' : 'inspector.what.addedFront', {
      set: entry.addedSet,
      sheet: entry.sheet,
    });
  }
  if (entry.sheet === null) {
    return t(back ? 'inspector.what.backLoose' : 'inspector.what.frontLoose');
  }
  return t(back ? 'inspector.what.back' : 'inspector.what.front', { sheet: entry.sheet });
}

/**
 * Пояснение ДЕТАЛЕЙ — по самому важному: потеря, затем режим. Наборы: «документ не собран… станет
 * лицом листа N» (N — место в группе, та же арифметика, что сборка), страница добавленного набора
 * — про набор. Пары и собрано: страница двустороннего набора — про пару или подблоки (M4.5),
 * добавленный набор, оборот, односторонний лист, лицо.
 */
export function noteOf(
  t: TFunction,
  entry: AssembledPage,
  mode: AssemblyMode,
  frontsOnly: boolean,
  origin: PassKind | null = null,
): string {
  if (entry.lost) {
    return t('inspector.note.lost');
  }
  if (mode === 'sets') {
    if (entry.addedSet !== null) {
      return t('inspector.note.setAdded');
    }
    return t(entry.side === 'back' ? 'inspector.note.setBack' : 'inspector.note.setFront', {
      position: entry.sheet ?? 0,
    });
  }
  if (entry.addedSet !== null) {
    if (isPairKind(origin)) {
      return t(entry.sheet === null ? 'inspector.note.addedPairLoose' : 'inspector.note.addedPair');
    }
    return t('inspector.note.added');
  }
  const sheet = entry.sheet ?? 0;
  if (entry.side === 'back') {
    return t('inspector.note.back', { sheet });
  }
  if (frontsOnly) {
    return t('inspector.note.frontsOnly');
  }
  return t('inspector.note.front', { sheet });
}
