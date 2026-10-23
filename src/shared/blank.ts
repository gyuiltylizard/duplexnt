// Режим пустых оборотов (M4; ADR 0004, амендмент 2026-10-22): решение приложения о ленте, не
// параметр устройства — в `ScanParams` не входит, по capabilities не сверяется. Выбирается в
// `setup`, помнится в настройках и замораживается в журнале сессии при старте первого прохода.

export const BLANK_MODES = ['hide', 'mark', 'keep'] as const;

/** «Скрывать» · «Помечать» · «Оставлять» (UI_SPEC §2). */
export type BlankMode = (typeof BLANK_MODES)[number];

/** По умолчанию — скрывать (UI_SPEC §2); «Сбросить параметры» возвращает его. */
export const DEFAULT_BLANK_MODE: BlankMode = 'hide';

/**
 * Флаг страницы ленты (R10): «скрыта» — режим «Скрывать», детектор счёл пустой, пометки нет,
 * лента не в режиме раздельных наборов; «помечена» — режим «Помечать» или «Скрывать» в режиме
 * наборов; `null` — обычная страница (в том числе при «Оставлять» и пока оценки нет).
 */
export type BlankFlag = 'hidden' | 'marked' | null;

/**
 * Вердикты детектора по ключу страницы: `true` — пусто. Ключа нет — оценка ещё не пришла
 * (страница прохода оборотов при режиме ≠ «Оставлять» считается ожидающей). Сбой детектора
 * кладётся как `false`: такая страница не пуста и не ожидает (R6).
 */
export type BlankVerdicts = ReadonlyMap<string, boolean>;

export const NO_VERDICTS: BlankVerdicts = new Map();

/** Сводка по пустым оборотам видимой ленты (KTD4) — для подвала, тостов и гардов записи. */
export interface BlankSummary {
  /** Режим сессии — заморожен в журнале (R2). */
  readonly mode: BlankMode;
  /** Страниц с флагом — скрытых и помеченных. */
  readonly found: number;
  /** Скрытых: их нет в файле и в показанной ленте, пока переключатель выключен. */
  readonly hidden: number;
  /** Страниц прохода оборотов без оценки при режиме ≠ «Оставлять»; запись ждёт нуля. */
  readonly pending: number;
}

/** Что нужно знать о странице, чтобы поставить флаг (R10, KTD9). */
export interface BlankFlagInput {
  /** Режим сессии. */
  readonly mode: BlankMode;
  /** Страница прохода оборотов — по роли прохода, не по позиции. */
  readonly ofBacks: boolean;
  /** Файла нет: не оценивается, не пуста и оценки не ждёт. */
  readonly lost: boolean;
  /** Вердикт детектора; `undefined` — ещё не пришёл. */
  readonly verdict: boolean | undefined;
  /** Пользователь пометил «это не пустая страница» (`edits.notBlank`). */
  readonly notBlank: boolean;
  /** Лента в режиме раздельных наборов: скрытие не действует, только метка. */
  readonly inSets: boolean;
}

/**
 * Флаг страницы или «ждёт оценки» — одно правило на ядро и зеркало renderer'а (R10, KTD4, KTD9):
 * при «Оставлять», у лиц, добавленных и потерянных флага нет; пометка «не пустая» снимает и
 * флаг, и ожидание — решение пользователя важнее оценки; без вердикта — ожидание; «Скрывать»
 * в режиме наборов даёт метку, не скрытие.
 */
export function blankFlagOf(page: BlankFlagInput): BlankFlag | 'pending' {
  if (page.mode === 'keep' || !page.ofBacks || page.lost || page.notBlank) {
    return null;
  }
  if (page.verdict === undefined) {
    return 'pending';
  }
  if (!page.verdict) {
    return null;
  }
  return page.mode === 'hide' && !page.inSets ? 'hidden' : 'marked';
}

/** Сводка по флагам видимой ленты: найдено (скрытые и помеченные), скрыто, ждут. */
export function blankSummaryOf(
  mode: BlankMode,
  flags: readonly (BlankFlag | 'pending')[],
): BlankSummary {
  let found = 0;
  let hidden = 0;
  let pending = 0;
  for (const flag of flags) {
    if (flag === 'pending') {
      pending += 1;
    } else if (flag !== null) {
      found += 1;
      if (flag === 'hidden') {
        hidden += 1;
      }
    }
  }
  return { mode, found, hidden, pending };
}
