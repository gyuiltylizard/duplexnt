import { z } from 'zod';
import {
  BLANK_MODES,
  DEFAULT_BLANK_MODE,
  DEFAULT_STRAIGHTEN_MODE,
  HINTS,
  LOCALES,
  STRAIGHTEN_MODES,
  fail,
  ok,
  type BlankMode,
  type DomainError,
  type HintId,
  type Locale,
  type Result,
  type ScanParams,
  type StartupNotice,
  type StraightenMode,
} from '@shared';
import type { ConnectedScanner, ConnectorOptions } from '../escl/connect';
import { resolveScanParams, scanParamsSchema } from '../escl/scan-settings';
import { layoutOf } from './layout';
import { locateRemembered, type StartUuidSearch } from './remembered-search';
import { ioOf, isMissing, serialQueue, storageFailure, type StorageOptions } from './storage-fs';
import { storedScannerSchema, type StoredScanner } from './stored-scanner';
import {
  fitsSchema,
  parseVersioned,
  readVersionMarker,
  setAside,
  writeVersioned,
  type VersionedRead,
} from './versioned-file';

// Настройки и запомненный сканер (план M1, U15, R5, R18). Живут отдельным файлом в корне данных:
// закрытие сессии их не трогает (ADR 0004).
//
// Файл более новой версии не переписывается: приложение работает со значениями по умолчанию в
// памяти и сообщает об этом (KTD-35). Нечитаемый файл отодвигается, а не удаляется.
//
// Версия 2 (M3, решение автора на приёмке): папка сохранения помнится между запусками. Файл
// версии 1 читается и поднимается до 2; переписывается только при следующей записи.

//
// Версия 3 (M4, R1): режим пустых оборотов помнится между запусками; файлы версий 1 и 2
// читаются с режимом по умолчанию и переписываются только при следующей записи.
//
// Версия 4 (B-4): какие подсказки уже показаны с привлечением внимания (`seenHints`); файлы
// версий 1–3 читаются с пустым списком и переписываются только при следующей записи.
//
// Версия 5 (M6, R13): режим выравнивания перекоса помнится между запусками; файлы версий 1–4
// читаются с режимом по умолчанию и переписываются только при следующей записи. Приложение до
// M6 видит файл v5 как несовместимый и работает на дефолтах без записи (KTD-35).
//
// Версия 6 (B-41): язык интерфейса — явный выбор пользователя или `null` («следовать системе»);
// файлы версий 1–5 читаются с `null` и переписываются только при следующей записи. Системный
// язык ядро не знает: эффективный считает служба прохода из выбора и опции main.

export const SETTINGS_VERSION = 6;

const settingsV1Schema = z.strictObject({
  version: z.literal(1),
  /** Последний подключённый сканер: адрес, имя, идентичность, отпечаток сертификата (KTD-40). */
  scanner: storedScannerSchema.nullable(),
  /** Параметры сканирования, выбранные последними; с устройством сверяются по KTD-13. */
  params: scanParamsSchema.nullable(),
});

const settingsV2Schema = settingsV1Schema.extend({
  version: z.literal(2),
  /** Папка, выбранная последней в модалке `save`; `null` — не выбирали, «Документы». */
  saveFolder: z.string().min(1).nullable(),
});

const settingsV3Schema = settingsV2Schema.extend({
  version: z.literal(3),
  /** Режим пустых оборотов, выбранный последним (M4, R1); решение приложения, не устройства. */
  blankMode: z.enum(BLANK_MODES),
});

const settingsV4Schema = settingsV3Schema.extend({
  version: z.literal(4),
  /** Подсказки, уже показанные с привлечением внимания (B-4) — без повторов. */
  seenHints: z
    .array(z.enum(HINTS))
    .max(HINTS.length)
    .refine((hints) => new Set(hints).size === hints.length),
});

const settingsV5Schema = settingsV4Schema.extend({
  version: z.literal(5),
  /** Режим выравнивания перекоса, выбранный последним (M6, R13); решение приложения. */
  straightenMode: z.enum(STRAIGHTEN_MODES),
});

const settingsSchema = settingsV5Schema.extend({
  version: z.literal(SETTINGS_VERSION),
  /** Язык интерфейса (B-41): явный выбор пользователя; `null` — следовать системе. */
  language: z.enum(LOCALES).nullable(),
});

export interface Settings {
  readonly scanner: StoredScanner | null;
  readonly params: ScanParams | null;
  readonly saveFolder: string | null;
  readonly blankMode: BlankMode;
  readonly seenHints: readonly HintId[];
  readonly straightenMode: StraightenMode;
  readonly language: Locale | null;
}

/**
 * Разбор файла настроек: версия 1 поднимается без папки, версия 2 — с режимом пустых по
 * умолчанию, версии 1–3 — с пустым списком показанных подсказок, версии 1–4 — с режимом
 * выравнивания по умолчанию, версии 1–5 — с языком «следовать системе».
 */
function parseSettings(bytes: Uint8Array): VersionedRead<Settings> {
  const marker = readVersionMarker(bytes);
  const straightenMode = DEFAULT_STRAIGHTEN_MODE;
  const language = null;
  if (marker === 1) {
    const v1 = parseVersioned(bytes, settingsV1Schema, 1);
    return v1.kind === 'ok'
      ? {
          kind: 'ok',
          value: {
            ...v1.value,
            saveFolder: null,
            blankMode: DEFAULT_BLANK_MODE,
            seenHints: [],
            straightenMode,
            language,
          },
        }
      : v1;
  }
  if (marker === 2) {
    const v2 = parseVersioned(bytes, settingsV2Schema, 2);
    return v2.kind === 'ok'
      ? {
          kind: 'ok',
          value: {
            ...v2.value,
            blankMode: DEFAULT_BLANK_MODE,
            seenHints: [],
            straightenMode,
            language,
          },
        }
      : v2;
  }
  if (marker === 3) {
    const v3 = parseVersioned(bytes, settingsV3Schema, 3);
    return v3.kind === 'ok'
      ? { kind: 'ok', value: { ...v3.value, seenHints: [], straightenMode, language } }
      : v3;
  }
  if (marker === 4) {
    const v4 = parseVersioned(bytes, settingsV4Schema, 4);
    return v4.kind === 'ok' ? { kind: 'ok', value: { ...v4.value, straightenMode, language } } : v4;
  }
  if (marker === 5) {
    const v5 = parseVersioned(bytes, settingsV5Schema, 5);
    return v5.kind === 'ok' ? { kind: 'ok', value: { ...v5.value, language } } : v5;
  }
  return parseVersioned(bytes, settingsSchema, SETTINGS_VERSION);
}

const settingsOf = ({
  scanner,
  params,
  saveFolder,
  blankMode,
  seenHints,
  straightenMode,
  language,
}: Settings): Settings => ({
  scanner,
  params,
  saveFolder,
  blankMode,
  seenHints,
  straightenMode,
  language,
});

export interface SettingsStore {
  /** Почему работают значения по умолчанию; `null` — файл прочитан или его ещё не было. */
  readonly notice: Extract<StartupNotice, 'settingsIncompatible' | 'settingsUnreadable'> | null;
  get(): Settings;
  /**
   * Запоминает сканер — после подключения, то есть явного действия пользователя. Отказ записи
   * значение не теряет: до конца работы оно остаётся в памяти.
   */
  rememberScanner(scanner: StoredScanner): Promise<Result<void>>;
  setParams(params: ScanParams): Promise<Result<void>>;
  /** Режим пустых оборотов (M4, R1): помнится между запусками. */
  setBlankMode(mode: BlankMode): Promise<Result<void>>;
  /** Режим выравнивания перекоса (M6, R13): помнится между запусками. */
  setStraightenMode(mode: StraightenMode): Promise<Result<void>>;
  /** Язык интерфейса (B-41): явный выбор помнится между запусками. */
  setLanguage(locale: Locale): Promise<Result<void>>;
  /** Папка, выбранная в модалке `save` (M3): предлагается при следующем запуске. */
  rememberSaveFolder(folder: string): Promise<Result<void>>;
  /** Подсказка показана с привлечением внимания (B-4): больше не мигает. Повтор — без изменений. */
  markHintSeen(hint: HintId): Promise<Result<void>>;
}

export async function openSettingsStore(
  dataRoot: string,
  options: StorageOptions = {},
): Promise<SettingsStore> {
  const { root, settingsFile } = layoutOf(dataRoot);
  const io = ioOf(options);
  const { fs } = io;

  let settings: Settings = {
    scanner: null,
    params: null,
    saveFolder: null,
    blankMode: DEFAULT_BLANK_MODE,
    seenHints: [],
    straightenMode: DEFAULT_STRAIGHTEN_MODE,
    language: null,
  };
  let notice: SettingsStore['notice'] = null;
  const readSettings = async (): Promise<VersionedRead<Settings>> => {
    try {
      return parseSettings(await fs.readFile(settingsFile));
    } catch (error) {
      if (isMissing(error)) {
        return { kind: 'missing' };
      }
      throw error;
    }
  };
  // Файл, который не переписывается до конца работы: более новой версии или не прочитанный вовсе.
  let frozen = false;
  try {
    const read = await readSettings();
    if (read.kind === 'ok') {
      settings = settingsOf(read.value);
    } else if (read.kind === 'incompatible') {
      notice = 'settingsIncompatible';
      frozen = true;
    } else if (read.kind === 'unreadable') {
      notice = 'settingsUnreadable';
      await setAside(settingsFile, io);
    }
  } catch {
    // Файл не открылся или не отодвинулся: что в нём, неизвестно — запись его затёрла бы.
    notice = 'settingsUnreadable';
    frozen = true;
  }

  const enqueue = serialQueue();
  const update = (change: Partial<Settings>): Promise<Result<void>> =>
    enqueue(async (): Promise<Result<void>> => {
      // Негодное значение не попадает ни в файл, ни в память: схема та же, которой файл читается.
      const document = { version: SETTINGS_VERSION, ...settings, ...change };
      if (!fitsSchema(settingsSchema, document)) {
        return fail('storageFailed', { reason: 'schema' });
      }
      settings = settingsOf(document);
      if (frozen) {
        return ok(undefined);
      }
      try {
        await fs.mkdir(root);
        await writeVersioned(settingsFile, settingsSchema, SETTINGS_VERSION, document, io);
        return ok(undefined);
      } catch (error) {
        return { ok: false, error: storageFailure(error) };
      }
    });

  return {
    notice,
    get: () => settings,
    rememberScanner: (scanner) => update({ scanner }),
    setParams: (params) => update({ params }),
    setBlankMode: (blankMode) => update({ blankMode }),
    setStraightenMode: (straightenMode) => update({ straightenMode }),
    setLanguage: (language) => update({ language }),
    rememberSaveFolder: (saveFolder) => update({ saveFolder }),
    markHintSeen: (hint) =>
      settings.seenHints.includes(hint)
        ? Promise.resolve(ok(undefined))
        : update({ seenHints: [...settings.seenHints, hint] }),
  };
}

/** Что с запомненным сканером при запуске. */
export type RememberedScanner =
  /** Сканер ещё не подключали. */
  | { readonly state: 'none' }
  /**
   * Отвечает то же устройство; параметры уже сверены с его capabilities (KTD-13). `relocated` —
   * найдено поиском на новом адресе, его запоминает вызывающий (M5, KTD5).
   */
  | {
      readonly state: 'ready';
      readonly connected: ConnectedScanner;
      readonly params: ScanParams;
      readonly relocated: boolean;
    }
  /** Сканер молчит, занят или отвечает невнятно; причина — кодом. */
  | { readonly state: 'unreachable'; readonly scanner: StoredScanner; readonly error: DomainError }
  /**
   * По адресу отвечает другое устройство. `error` — чем оно себя выдало: чужой сертификат, не
   * сканер, сканер без автоподачи; `null` — исправный сканер с другим UUID.
   */
  | {
      readonly state: 'otherDevice';
      readonly scanner: StoredScanner;
      readonly error: DomainError | null;
    };

/**
 * Проверка запомненного сканера запросом capabilities. Идёт по запомненной схеме: закрытый порт
 * HTTPS — «не отвечает», а не повод попробовать HTTP (KTD-8). Настройки не меняет ни при каком
 * исходе: другое устройство на том же адресе запомненное не подменяет (R5). С `search` молчащий
 * или чужой адрес ведёт к поиску по UUID (M5, ./remembered-search.ts); найденный адрес
 * запоминает вызывающий.
 */
export async function checkRememberedScanner(
  settings: Settings,
  options: ConnectorOptions = {},
  signal?: AbortSignal,
  search?: StartUuidSearch,
): Promise<RememberedScanner> {
  const { scanner } = settings;
  if (scanner === null) {
    return { state: 'none' };
  }
  const located = await locateRemembered(scanner, options, signal, search);
  return located.state === 'ready'
    ? { ...located, params: resolveScanParams(settings.params, located.connected.options) }
    : { ...located, scanner };
}
