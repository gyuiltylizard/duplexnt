// Снимок состояния — то, из чего интерфейс выводит экран (план M1, KTD-23; ADR 0005). Renderer
// своей копии состояния сессии не ведёт. Сессию отдаёт хранилище сессии (`SessionSnapshot`);
// сканер, параметры, ход прохода, режим отказа и уведомления запуска добавляет служба прохода
// (`Snapshot`).
//
// В снимке нет абсолютных путей и адресов заданий (KTD-39): страница адресуется ключом.

import type { BlankMode } from './blank';
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

export interface PassesByKind<T> {
  readonly fronts: T | null;
  readonly backs: T | null;
  /** Добавленные наборы в порядке проходов (по возрастанию номера). */
  readonly added: readonly T[];
}

/**
 * Проходы по ролям — единственное место правила (M3.5, KTD-4) для журнала, снимка и renderer:
 * роль читается из `kind`, не из позиции, и только у прохода хотя бы с одной страницей
 * (`hasPages`) — пустой проход (прерван до первой страницы) роли не занимает при любом `kind`,
 * иначе он блокировал бы «обороты не нужны». Лицевых и оборотов со страницами не больше одного
 * (схема журнала); `passes` идут по возрастанию номера.
 */
export function passesByKind<T extends { readonly kind: PassKind }>(
  passes: readonly T[],
  hasPages: (pass: T) => boolean,
): PassesByKind<T> {
  const counted = passes.filter(hasPages);
  return {
    fronts: counted.find((pass) => pass.kind === 'fronts') ?? null,
    backs: counted.find((pass) => pass.kind === 'backs') ?? null,
    added: counted.filter((pass) => pass.kind === 'added'),
  };
}

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
  /**
   * Запись сборки (M3.6; ADR 0004, амендмент 2026-10-19): последовательность ключей страниц,
   * зафиксированная командой «Собрать документ» при несовпадении проходов; `null` — не собрано.
   * Режим сессии из неё выводит ядро, renderer читает его из отчёта сборки.
   */
  readonly assembled: readonly string[] | null;
  /**
   * Режим пустых оборотов сессии (M4; ADR 0004, амендмент 2026-10-22): заморожен при старте
   * первого прохода, в редакторе не меняется; сессии журнала v5 — «оставлять».
   */
  readonly blankMode: BlankMode;
}

/** Угол страницы при показе и в PDF по часовой стрелке (M3, KTD-4). */
export type PageAngle = 0 | 90 | 180 | 270;

/**
 * Режим сборки (M3.6, R4; ADR 0004, амендмент 2026-10-19): «пары» — правило пар M2–M3.5;
 * «раздельные наборы» — проходы не сошлись, лента из двух групп до команды «Собрать документ»;
 * «собрано» — лента по записи сборки. Выводится ядром из снимка на каждом шаге.
 */
export type AssemblyMode = 'pairs' | 'sets' | 'assembled';

/** Группы ленты в режиме раздельных наборов: видимые счётчики и позиция границы (R10). */
export interface SetsLayout {
  /** Видимых страниц в наборе лиц — равно `divider`. */
  readonly fronts: number;
  /** Видимых страниц в наборе оборотов. */
  readonly backs: number;
  /** Позиция границы в видимой ленте: страницы с неё и дальше — набор оборотов. */
  readonly divider: number;
}

/**
 * Страница видимой ленты (M2, KTD-4; M3, KTD-2; M3.6, R11). Сторона и номер — по режиму: в режиме
 * пар — по роли прохода и позиции в лицевом проходе; в режиме раздельных наборов — по группе и
 * позиции в наборе от 1; после сборки — по позиции в видимом чередовании записи, ключи вне записи
 * — сторона по проходу, без листа. Угол считает ядро.
 */
export interface AssembledPage {
  readonly key: string;
  readonly side: 'front' | 'back';
  /** Номер листа или номер в наборе (см. выше); `null` — листа нет. */
  readonly sheet: number | null;
  /** Ручной поворот плюс 180° прохода оборотов, по модулю 360; исходник не меняется. */
  readonly angle: PageAngle;
  /** Запись есть, файла нет: место в порядке сохраняется. */
  readonly lost: boolean;
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
  /** Режим сборки (M3.6, R4). */
  readonly mode: AssemblyMode;
  /** Группы ленты в режиме раздельных наборов — живые счётчики (R10); иначе `null`. */
  readonly groups: SetsLayout | null;
  /** Страниц лицевого прохода (= листов). */
  readonly fronts: number;
  /** Страниц прохода оборотов; 0 — прохода нет. */
  readonly backs: number;
  /** Состояние прохода оборотов; `null` — прохода нет. «Принят» — сборка по фактическим парам. */
  readonly backsState: PassState | null;
  /** «Обороты не нужны» (KTD-6). */
  readonly backsDeclined: boolean;
  /** Проходы не сошлись и документ не собран — режим раздельных наборов (R10). Показ модалки — KTD-8. */
  readonly mismatch: boolean;
}

/**
 * Сборка сессии: видимая лента с правками, документы и отчёт пар. Производное от снимка
 * сессии — в журнал не пишется (ADR 0004).
 */
export interface SessionAssembly {
  /** Видимая лента: порядок с правками, без удалённых. */
  readonly order: readonly AssembledPage[];
  /**
   * Документы по разрезам; их всегда хотя бы один, пустых нет (кроме пустой ленты). В режиме
   * раздельных наборов — один на всю ленту: разрезов до сборки нет.
   */
  readonly documents: readonly AssembledDocument[];
  /** Группы ленты в режиме раздельных наборов (M3.6, R10); иначе `null`. То же, что `report.groups`. */
  readonly sets: SetsLayout | null;
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
  /** Роль идущего прохода (M3.5, KTD-4): экран `scan` строит тег и счётчик по ней. */
  readonly kind: PassKind;
  /**
   * Ожидаемое число страниц (M2, R2): у прохода оборотов — страницы лицевого; `null` — лицевой
   * или добавленный проход, общее число неизвестно. Счётчик может перевалить за него и не
   * подрезается.
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
  /**
   * Режим пустых оборотов из настроек (M4, R1) — для ряда «Пустые обороты» в `setup`. Режим
   * текущей сессии — в `session.blankMode`: он заморожен и может отличаться.
   */
  readonly blankMode: BlankMode;
}
