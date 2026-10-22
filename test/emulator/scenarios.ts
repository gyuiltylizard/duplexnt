// Сценарии эмулятора сканера (план M1, U9). Сценарий — данные: что лежит в лотке и где устройство
// ведёт себя не так, как в обычном проходе. Обычное поведение повторяет ET-3850 по журналу M1, U1
// и следам `test/fixtures/escl/et-3850/traces/`; отклонения от него — намеренные сбои.

/** Какой `Location` отдаёт ответ `201`. Задание при этом существует по настоящему адресу. */
export type LocationForm =
  /** Как у ET-3850: полный URL с хостом и портом. */
  | 'absolute'
  /** Только путь от корня. */
  | 'path'
  /** Относительный — от адреса коллекции заданий. */
  | 'relative'
  /** Полный URL с чужим хостом: клиент обязан взять из него только путь. */
  | 'foreign-host'
  /** Полный URL со схемой `http` при устройстве на HTTPS. */
  | 'http-scheme'
  /** Путь вне коллекции заданий — негодный. */
  | 'outside'
  /** Путь с точечным сегментом — негодный. */
  | 'traversal'
  /** Заголовка нет. */
  | 'missing';

/** Сбой при отдаче страницы. */
export type PageFault =
  /** Соединение закрыто без единого байта — сбой подачи при висящем запросе (журнал U1). */
  | 'reset-before-headers'
  /** `410 Gone` — сбой подачи между страницами (журнал U1). */
  | 'gone'
  /** Тело `chunked` обрывается посередине. */
  | 'reset-mid-body'
  /** Тело обрамлено закрытием соединения и кончается посреди страницы штатным закрытием. */
  | 'close-mid-body'
  /** `Content-Length` больше тела: тело короче заявленного. */
  | 'length-longer'
  /** `Content-Length` меньше тела: целой страницы в заявленной длине нет, остаток — мусор. */
  | 'length-shorter'
  /** Ответ `200`, тело — не JPEG. */
  | 'not-jpeg'
  /** Ответ `200` без тела. */
  | 'empty'
  /** Тело размером `oversizeBytes`. */
  | 'oversize'
  /** Половина тела, затем тишина. */
  | 'stall'
  /** Тело по байту раз в `dripIntervalMs`. */
  | 'drip';

/** Лист в лотке сценария: номер синтетической страницы или имя скана из `scans/`. */
export type TrayEntry = number | string;

export interface Scenario {
  /** Чьи capabilities отдаются: ET-3850 или синтетическое устройство без автоподачи. */
  readonly device: 'et-3850' | 'no-adf';
  /** Листов в лотке; `Infinity` — лоток не кончается. Лоток общий для всех заданий сценария. */
  readonly sheets: number;
  /**
   * Содержимое лотка по заданиям (M2, U4): листы на каждое задание по порядку создания; очередь
   * пополняется `reloadTray` без сброса сценария и заданий. Лист — номер синтетической страницы
   * `pages/page-NN.jpg` или имя настоящего скана из `scans/` (M4, U1: `'blank-gray-300'`).
   * `null` — прежнее поведение: общий лоток на `sheets` листов, страницы по сквозному номеру.
   * Двухпроходная пачка: лицевые прямым порядком, обороты — обратным (стопку развернули).
   */
  readonly trays: readonly (readonly TrayEntry[])[] | null;
  /** Что статус говорит о лотке в покое; `null` — правду, по числу листов. */
  readonly trayReportsLoaded: boolean | null;
  /** Сколько первых `POST` получают `503`; `Infinity` — занятость без конца. */
  readonly busyPosts: number;
  /** `POST` получает `409` при любых параметрах. */
  readonly rejectSettings: boolean;
  /** Сколько `503` отдаёт `NextDocument` после страницы: перед следующей и перед концом. */
  readonly notReady: { readonly betweenPages: number; readonly beforeEnd: number };
  readonly location: LocationForm;
  /** Сбой на листе с этим номером (счёт листов сквозной, с единицы); срабатывает один раз. */
  readonly fault: { readonly sheet: number; readonly kind: PageFault } | null;
  /** `DELETE` не получает ответа. */
  readonly deleteHangs: boolean;
  /** Пауза перед заголовками страницы — «лист едет через сканер». */
  readonly pageDelayMs: number;
  readonly dripIntervalMs: number;
  readonly oversizeBytes: number;
  /** Сколько после `DELETE` идущего задания `POST` получает `503`: устройство гонит остаток пачки. */
  readonly busyAfterCancelMs: number;
  /** Через сколько без обращений устройство само снимает брошенное задание. */
  readonly abandonAfterMs: number;
}

// Обычный проход ET-3850: `503` после каждой страницы, четыре — перед финальным `404`; брошенное
// задание устройство снимает через пять минут.
export const DEFAULT_SCENARIO: Scenario = {
  device: 'et-3850',
  sheets: 3,
  trays: null,
  trayReportsLoaded: null,
  busyPosts: 0,
  rejectSettings: false,
  notReady: { betweenPages: 1, beforeEnd: 4 },
  location: 'absolute',
  fault: null,
  deleteHangs: false,
  pageDelayMs: 0,
  dripIntervalMs: 60_000,
  oversizeBytes: 80 * 1024 * 1024,
  busyAfterCancelMs: 0,
  abandonAfterMs: 5 * 60_000,
};

/** Настоящий пустой скан ET-3850 (M4, KTD8) — оборот без содержимого. */
const BLANK = 'blank-gray-300';

/** Именованные сценарии — для `npm run emulator` и ручного смоука. Тесты задают поля напрямую. */
export const SCENARIOS = {
  pass: {},
  'pass-12': { sheets: 12 },
  'pass-30': { sheets: 30 },
  'busy-then-ok': { busyPosts: 5 },
  'busy-forever': { busyPosts: Infinity },
  'empty-tray': { sheets: 0 },
  'no-pages': { sheets: 0, trayReportsLoaded: true },
  'no-adf': { device: 'no-adf' },
  'settings-rejected': { rejectSettings: true },
  // Обрыв между страницами: 17 страниц целы, 18-й лист остаётся в лотке — как в примере AE5.
  'jam-after-17': {
    sheets: 30,
    notReady: { betweenPages: 1, beforeEnd: 4 },
    fault: { sheet: 18, kind: 'gone' },
  },
  'reset-at-first-page': { fault: { sheet: 1, kind: 'reset-before-headers' } },
  'reset-mid-page': { fault: { sheet: 2, kind: 'reset-mid-body' } },
  'stalled-page': { fault: { sheet: 2, kind: 'stall' } },
  'dripping-page': { fault: { sheet: 1, kind: 'drip' } },
  'oversize-page': { fault: { sheet: 1, kind: 'oversize' } },
  'not-jpeg': { fault: { sheet: 1, kind: 'not-jpeg' } },
  'empty-page': { fault: { sheet: 1, kind: 'empty' } },
  'close-mid-page': { fault: { sheet: 1, kind: 'close-mid-body' } },
  'length-longer': { fault: { sheet: 1, kind: 'length-longer' } },
  'length-shorter': { fault: { sheet: 1, kind: 'length-shorter' } },
  'endless-pages': { sheets: Infinity },
  // Двусторонняя пачка из 3 листов (M2): лица 1–3 — фикстуры 1..3, обороты — 4..6; разворот
  // на 180° подаёт обороты в обратном порядке: первым идёт оборот последнего листа.
  'two-pass': {
    trays: [
      [1, 2, 3],
      [6, 5, 4],
    ],
  },
  // «Ролик не взял лист» во втором проходе: оборотов на один меньше, без ошибки устройства —
  // просто меньше страниц; непарным остаётся лист №1.
  'two-pass-missing-sheet': {
    trays: [
      [1, 2, 3],
      [6, 5],
    ],
  },
  // Обрыв второго прохода посреди задания: сбой подачи на втором обороте (сквозной лист 5).
  'two-pass-jam': {
    trays: [
      [1, 2, 3],
      [6, 5, 4],
    ],
    fault: { sheet: 5, kind: 'gone' },
  },
  // Добавленные наборы (M3.5, U8): третье и дальнейшие задания — страницы поверх готовых пар.
  // Обороты [6, 5] — непарный лист №1; «один лист» после двух проходов — фикстура 7.
  'add-one-sheet': {
    trays: [[1, 2, 3], [6, 5], [7]],
  },
  'add-many': {
    trays: [
      [1, 2, 3],
      [6, 5, 4],
      [7, 8, 9],
    ],
  },
  'add-twice': {
    trays: [[1, 2, 3], [6, 5, 4], [7], [8]],
  },
  // Третий лоток пуст: «Начать скан» из `add` получает `scanNoPaper`, сессия цела (AE8).
  'add-empty-tray': {
    trays: [[1, 2, 3], [6, 5, 4], []],
  },
  // Замятие на втором листе добавленного набора (сквозной лист 8): плашка, `reloadTray`,
  // досканирование в конец блока набора (AE5).
  'add-jam': {
    trays: [
      [1, 2, 3],
      [6, 5, 4],
      [7, 8, 9],
    ],
    fault: { sheet: 8, kind: 'gone' },
  },
  // «Обороты не нужны», затем добавленный набор в конец (AE2).
  'add-after-declined': {
    trays: [[1, 2, 3], [7]],
  },
  // Раздельные наборы (M3.6, U7): проходы не сошлись — лента из двух групп до «Собрать документ».
  // Недостающий оборот в середине: обороты [6, 4] (нет оборота листа 2 — фикстуры 5); третий
  // лоток — «Один лист» с ним.
  'separate-sets-missing': {
    trays: [[1, 2, 3], [6, 4], [5]],
  },
  // Лишний оборот: двойной захват в первом проходе — лиц два, оборотов три.
  'separate-sets-extra': {
    trays: [
      [1, 2],
      [6, 5, 4],
    ],
  },
  // Обрыв прохода оборотов с несовпадением: замятие на втором обороте (сквозной лист 5) —
  // плашка над двумя наборами, «Собрать» недоступна до решения по плашке.
  'separate-sets-jam': {
    trays: [
      [1, 2, 3],
      [6, 5, 4],
    ],
    fault: { sheet: 5, kind: 'gone' },
  },
  // Пустые обороты (M4, U8): двусторонняя пачка из 12 листов, обороты обратным порядком; у листов
  // 4, 9 и 12 оборот — настоящий пустой скан (AE1–AE2, AE4–AE5): лица 1..12, обороты 13..24.
  'blank-backs': {
    trays: [
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      [BLANK, 23, 22, BLANK, 20, 19, 18, 17, BLANK, 15, 14, 13],
    ],
  },
  // Бледный карандаш на обороте листа 2 — не пусто (AE3).
  'blank-pencil': {
    trays: [
      [1, 2, 3],
      [6, 'pencil-faint-gray-300', 4],
    ],
  },
  // Наборы с пустыми (AE7): замятие на последнем обороте (сквозной лист 24 — оборот листа 1):
  // оборотов 11, из них пустые у листов 4 и 9; третий лоток — пустой скан для «+ Добавить».
  'blank-sets': {
    trays: [
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      [24, 23, 22, BLANK, 20, 19, 18, 17, BLANK, 15, 14, 13],
      [BLANK],
    ],
    fault: { sheet: 24, kind: 'gone' },
  },
  'delete-hangs': { deleteHangs: true },
  'location-path': { location: 'path' },
  'location-foreign-host': { location: 'foreign-host' },
  'location-missing': { location: 'missing' },
} as const satisfies Record<string, Partial<Scenario>>;

type ScenarioName = keyof typeof SCENARIOS;

export const isScenarioName = (name: string): name is ScenarioName =>
  Object.hasOwn(SCENARIOS, name);

export function scenarioOf(overrides: Partial<Scenario> = {}): Scenario {
  return { ...DEFAULT_SCENARIO, ...overrides };
}
