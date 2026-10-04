// Снимок состояния — то, из чего интерфейс выводит экран (план M1, KTD-23; ADR 0005). Renderer
// своей копии состояния сессии не ведёт. Сессию отдаёт хранилище сессии (`SessionSnapshot`);
// сканер, параметры, ход прохода, режим отказа и уведомления запуска добавляет служба прохода
// (`Snapshot`).
//
// В снимке нет абсолютных путей и адресов заданий (KTD-39): страница адресуется ключом.

import type { DomainError } from './errors';
import type { ScanOptions, ScanParams } from './scan-params';

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
  /** Сканер, на котором шёл проход (KTD-27); `null`, когда параметры неизвестны. */
  readonly scanner: ScannerInfo | null;
  /**
   * Повернуть страницы прохода на 180° при показе и в PDF (M2, KTD-2). Осмыслен на проходе
   * оборотов — втором уцелевшем (роль, не чётность номера — KTD-4); исходники не меняются.
   */
  readonly rotate180: boolean;
  readonly pages: readonly PageSnapshot[];
}

export interface SessionSnapshot {
  readonly id: string;
  /** «Обороты не нужны»: односторонний набор, `flip` больше не показывается (M2, KTD-6). */
  readonly backsDeclined: boolean;
  /** Набор сохранён в PDF и с тех пор не менялся (M2, R12): кормит индикацию несохранённого. */
  readonly saved: boolean;
  readonly passes: readonly PassSnapshot[];
}

/**
 * Страница в собранном порядке (M2, KTD-4). Роли «лицо/оборот» выводятся из позиции прохода
 * среди уцелевших, не из чётности номера.
 */
export interface AssembledPage {
  readonly key: string;
  readonly side: 'front' | 'back';
  /** Номер листа — позиция в лицевом проходе; у лишнего оборота листа нет (`null`). */
  readonly sheet: number | null;
  /** Повернуть на 180° при показе и в PDF — флаг прохода оборотов (KTD-2). */
  readonly rotate180: boolean;
  /** Запись есть, файла нет: место в порядке сохраняется. */
  readonly lost: boolean;
}

/** Отчёт сборки — кормит статусную строку `merge`, модалку `mismatch` и пометки в ленте. */
export interface AssemblyReport {
  /** Страниц лицевого прохода (= листов). */
  readonly fronts: number;
  /** Страниц прохода оборотов; 0 — прохода нет. */
  readonly backs: number;
  /** Совпавших пар «лицо + оборот». */
  readonly pairs: number;
  /** Номера листов без оборота, по возрастанию: при нехватке оборотов — младшие (KTD-4). */
  readonly unpairedSheets: readonly number[];
  /** Лишних оборотов сверх числа лиц: лежат в конце набора, не выбрасываются. */
  readonly extraBacks: number;
  /** Состояние прохода оборотов; `null` — прохода нет. «Принят» — сборка по фактическим парам. */
  readonly backsState: PassState | null;
  /** «Обороты не нужны» (KTD-6). */
  readonly backsDeclined: boolean;
  /** Проходы не сошлись: есть листы без оборота или лишние обороты. Показ модалки — KTD-8. */
  readonly mismatch: boolean;
}

/**
 * Сборка сессии: порядок по умолчанию и отчёт. Производное от снимка сессии — в журнал не
 * пишется (ADR 0004).
 */
export interface SessionAssembly {
  readonly order: readonly AssembledPage[];
  readonly report: AssemblyReport;
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

/** Сканер, как его показывает строка устройства: адрес виден всегда (журнал M1, сессия 4). */
export interface ScannerInfo {
  readonly name: string | null;
  /** Схема видна: по HTTP отпечатка сертификата нет (KTD-8, KTD-40). */
  readonly scheme: 'https' | 'http';
  readonly host: string;
  readonly port: number;
}

/** Сканер в приложении: подключённый или запомненный, с исходом его проверки при запуске. */
export type ScannerState =
  /** Сканер ещё не подключали. */
  | { readonly kind: 'none' }
  /**
   * Запомненный сканер проверяется запросом capabilities. `params` — запомненные параметры:
   * ряды настройки недоступны, но показывают их, а не пустоту и не дефолты (S2–S4).
   */
  | { readonly kind: 'checking'; readonly scanner: ScannerInfo; readonly params: ScanParams }
  /** Подключён; варианты параметров — из его capabilities, параметры — выбранные (KTD-13). */
  | {
      readonly kind: 'ready';
      readonly scanner: ScannerInfo;
      readonly options: ScanOptions;
      readonly params: ScanParams;
    }
  /** Запомненный сканер молчит, занят или отвечает невнятно; причина — кодом. */
  | {
      readonly kind: 'unreachable';
      readonly scanner: ScannerInfo;
      readonly error: DomainError;
      readonly params: ScanParams;
    }
  /**
   * По адресу отвечает другое устройство: чужой сертификат, не сканер, сканер без автоподачи;
   * `error` — `null`, когда это исправный сканер с другим UUID.
   */
  | {
      readonly kind: 'otherDevice';
      readonly scanner: ScannerInfo;
      readonly error: DomainError | null;
      readonly params: ScanParams;
    };

/** Идущий проход — то, что показывает экран `scan`. */
export interface PassProgress {
  readonly phase:
    /** Задание ещё не создано: закрываются незакрытые задания, читается лоток. */
    | 'starting'
    /** Устройство занято: ждём, пока примет задание (R7). */
    | 'busy'
    /** Задание принято, идут страницы. */
    | 'scanning'
    /** «Остановить» нажато: ждём, пока устройство закроет задание. */
    | 'stopping';
  /** Досканирование прерванного прохода, а не новый проход. */
  readonly resumed: boolean;
  /**
   * Параметры, с которыми идёт проход. При досканировании — параметры прохода из журнала:
   * после перезапуска они могут отличаться от текущих параметров настройки.
   */
  readonly params: ScanParams;
  /** Страниц, принятых этим запуском. */
  readonly pages: number;
}

/** Итог запуска прохода — ответ команды `startPass`; состояние после него — в снимке. */
export interface PassReport {
  readonly end:
    | 'completed'
    /** Проход прерван; страницы на месте, причина — в `error`. */
    | 'interrupted'
    /** «Остановить»: страницы этого запуска удалены. */
    | 'stopped';
  /** Страниц, принятых этим запуском и оставшихся на диске. */
  readonly pages: number;
  readonly error: DomainError | null;
}

export interface Snapshot {
  /** Номер снимка: событие несёт его, интерфейс берёт позднейший. */
  readonly seq: number;
  readonly scanner: ScannerState;
  readonly session: SessionSnapshot | null;
  /** Сборка текущей сессии (M2); `null` — сессии нет. */
  readonly assembly: SessionAssembly | null;
  /** `null` — проход не идёт. */
  readonly pass: PassProgress | null;
  /** Последний проход прерван, и его можно досканировать: параметры известны, сканер тот же. */
  readonly canResume: boolean;
  /** Последний проход прерван, и его можно оставить как есть. */
  readonly canAccept: boolean;
  readonly storage: {
    /** Данные более новой версии: ни прохода, ни «Новой пачки» (KTD-35). */
    readonly incompatible: boolean;
    /** Журнал в памяти новее записанного: последняя запись на диск не удалась. */
    readonly unsaved: boolean;
  };
  /** Уведомления запуска; читаются без сброса, интерфейс показывает их один раз сам. */
  readonly notices: readonly StartupNotice[];
}
