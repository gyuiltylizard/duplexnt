// Снимок состояния — то, из чего интерфейс выводит экран (план M1, KTD-23; ADR 0005). Renderer
// своей копии состояния сессии не ведёт. Сессию отдаёт хранилище сессии (`SessionSnapshot`);
// сканер, параметры, ход прохода, режим отказа и уведомления запуска добавляет служба прохода
// (`Snapshot`).
//
// В снимке нет абсолютных путей и адресов заданий (KTD-39): страница адресуется ключом.

import type { SessionEdits } from './edits';
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

/**
 * Роль прохода, записанная в журнале явно (M3.5; ADR 0004, амендмент 2026-10-07): лицевые,
 * обороты или добавленный однопроходный набор. Роль действует только у прохода хотя бы с одной
 * страницей: пустой (прерванный до первой страницы) роли не имеет при любом `kind`.
 */
export const PASS_KINDS = ['fronts', 'backs', 'added'] as const;
export type PassKind = (typeof PASS_KINDS)[number];

export interface PassSnapshot {
  readonly number: number;
  readonly kind: PassKind;
  /**
   * Якорь вставки добавленного набора: ключ страницы, после которой встают его страницы в
   * автопорядке; `null` — в конец ленты. Осмыслен только у `added`, у остальных всегда `null`.
   */
  readonly after: string | null;
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
   * оборотов (`kind: 'backs'`); исходники не меняются.
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
  /**
   * Ручные правки — дословно, как записаны в журнал после нормализации ядром (M3, KTD-3):
   * от них редактор строит следующий жест и перебазирует вершину undo-стека.
   */
  readonly edits: SessionEdits;
}

/** Угол страницы при показе и в PDF по часовой стрелке (M3, KTD-4). */
export type PageAngle = 0 | 90 | 180 | 270;

/**
 * Страница видимой ленты (M2, KTD-4; M3, KTD-2). Роли «лицо/оборот» — по роли прохода (`kind`);
 * угол и непарность считает ядро.
 */
export interface AssembledPage {
  readonly key: string;
  readonly side: 'front' | 'back';
  /** Номер листа — позиция в лицевом проходе; у лишнего оборота листа нет (`null`). */
  readonly sheet: number | null;
  /** Ручной поворот плюс 180° прохода оборотов, по модулю 360; исходник не меняется. */
  readonly angle: PageAngle;
  /** Запись есть, файла нет: место в порядке сохраняется. */
  readonly lost: boolean;
  /** Лист без оборота по отчёту пар (KTD-7): пометка в ленте. */
  readonly unpaired: boolean;
  /**
   * Страница добавленного набора (M3.5, R16): порядковый номер набора от 1 среди добавленных
   * проходов со страницами — тег на миниатюре; `null` — лицевые и обороты. Номер стабилен: набор
   * исчезает только до первой страницы.
   */
  readonly addedSet: number | null;
}

/** Документ ленты: отрезок `order` от `start` длиной `count` (M3, R10). */
export interface AssembledDocument {
  /** Имя из правок; пустое — имя по умолчанию, его подставляет интерфейс. */
  readonly name: string;
  readonly start: number;
  readonly count: number;
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
 * Сборка сессии: видимая лента с правками, документы и отчёт пар. Производное от снимка
 * сессии — в журнал не пишется (ADR 0004).
 */
export interface SessionAssembly {
  /** Видимая лента: порядок с правками, без удалённых. */
  readonly order: readonly AssembledPage[];
  /** Документы по разрезам; их всегда хотя бы один, пустых нет (кроме пустой ленты). */
  readonly documents: readonly AssembledDocument[];
  /** Порядок задан вручную: автосортировка выключена (M3, R8). */
  readonly orderEdited: boolean;
  /** Есть что откатывать «Вернуть»: любая правка или поворот оборотов (M3, R8, R9). */
  readonly hasEdits: boolean;
  /** Удалённых страниц, которые вернёт Ctrl+Z или «Вернуть». */
  readonly deleted: number;
  /** Отчёт о сканировании — по проходам, правки на него не влияют (M3, KTD-7). */
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
   * Ожидаемое число страниц (M2, R2): у прохода оборотов — страницы лицевого; `null` — лицевой
   * проход, общее число неизвестно. Счётчик может перевалить за него и не подрезается.
   */
  readonly expected: number | null;
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
