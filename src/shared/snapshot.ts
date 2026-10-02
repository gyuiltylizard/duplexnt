// Снимок состояния — то, из чего интерфейс выводит экран (план M1, KTD-23; ADR 0005). Renderer
// своей копии состояния сессии не ведёт. Здесь — часть снимка, которую отдаёт хранилище сессии;
// сканер, параметры и ход прохода добавляет служба прохода.
//
// В снимке нет абсолютных путей и адресов заданий (KTD-39): страница адресуется ключом.

/**
 * Состояние прохода (ADR 0004, амендмент): идёт, завершён, прерван, прерван и принят как есть.
 */
export type PassState = 'running' | 'completed' | 'interrupted' | 'accepted';

export interface PageSnapshot {
  /** Устойчивый ключ страницы; по нему же запрашивается изображение. */
  readonly key: string;
  /** Номер в проходе, с единицы, в порядке получения через все сегменты. */
  readonly number: number;
  /** Запись есть, файла нет: страница показывается потерянной на своём месте. */
  readonly lost: boolean;
}

export interface PassSnapshot {
  readonly number: number;
  readonly state: PassState;
  /**
   * `false` — журнал пересобран по именам файлов: сканер и параметры прохода неизвестны,
   * досканировать его нельзя.
   */
  readonly paramsKnown: boolean;
  readonly pages: readonly PageSnapshot[];
}

export interface SessionSnapshot {
  readonly id: string;
  readonly passes: readonly PassSnapshot[];
}

/** Что сверка при запуске нашла и о чём интерфейс сообщает один раз. */
export type StartupNotice =
  /** Журнал не читался: отодвинут, сессия пересобрана по именам файлов. */
  | 'journalRebuilt'
  /** У части записей журнала нет файлов: страницы показаны потерянными. */
  | 'pagesLost'
  /** Настройки записаны более новой версией: не переписываются, работают значения по умолчанию. */
  | 'settingsIncompatible'
  /** Файл настроек не читался: отодвинут, работают значения по умолчанию. */
  | 'settingsUnreadable';
