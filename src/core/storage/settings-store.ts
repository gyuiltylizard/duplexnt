import { z } from 'zod';
import {
  BLANK_MODES,
  DEFAULT_BLANK_MODE,
  fail,
  ok,
  type BlankMode,
  type DomainError,
  type Result,
  type ScanParams,
  type StartupNotice,
} from '@shared';
import { probeScanner, type ConnectedScanner, type ConnectorOptions } from '../escl/connect';
import { resolveScanParams, scanParamsSchema } from '../escl/scan-settings';
import { layoutOf } from './layout';
import { classifyProbe } from './probe-outcome';
import { ioOf, isMissing, serialQueue, storageFailure, type StorageOptions } from './storage-fs';
import { profileOf, storedScannerSchema, type StoredScanner } from './stored-scanner';
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

export const SETTINGS_VERSION = 3;

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

const settingsSchema = settingsV2Schema.extend({
  version: z.literal(SETTINGS_VERSION),
  /** Режим пустых оборотов, выбранный последним (M4, R1); решение приложения, не устройства. */
  blankMode: z.enum(BLANK_MODES),
});

export interface Settings {
  readonly scanner: StoredScanner | null;
  readonly params: ScanParams | null;
  readonly saveFolder: string | null;
  readonly blankMode: BlankMode;
}

/** Разбор файла настроек: версия 1 поднимается до 2 без папки, версия 2 — до 3 с режимом по умолчанию. */
function parseSettings(bytes: Uint8Array): VersionedRead<Settings> {
  const marker = readVersionMarker(bytes);
  if (marker === 1) {
    const v1 = parseVersioned(bytes, settingsV1Schema, 1);
    return v1.kind === 'ok'
      ? { kind: 'ok', value: { ...v1.value, saveFolder: null, blankMode: DEFAULT_BLANK_MODE } }
      : v1;
  }
  if (marker === 2) {
    const v2 = parseVersioned(bytes, settingsV2Schema, 2);
    return v2.kind === 'ok'
      ? { kind: 'ok', value: { ...v2.value, blankMode: DEFAULT_BLANK_MODE } }
      : v2;
  }
  return parseVersioned(bytes, settingsSchema, SETTINGS_VERSION);
}

const settingsOf = ({ scanner, params, saveFolder, blankMode }: Settings): Settings => ({
  scanner,
  params,
  saveFolder,
  blankMode,
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
  /** Папка, выбранная в модалке `save` (M3): предлагается при следующем запуске. */
  rememberSaveFolder(folder: string): Promise<Result<void>>;
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
    rememberSaveFolder: (saveFolder) => update({ saveFolder }),
  };
}

/** Что с запомненным сканером при запуске. */
export type RememberedScanner =
  /** Сканер ещё не подключали. */
  | { readonly state: 'none' }
  /** Отвечает то же устройство; параметры уже сверены с его capabilities (KTD-13). */
  | {
      readonly state: 'ready';
      readonly connected: ConnectedScanner;
      readonly params: ScanParams;
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
 * исходе: другое устройство на том же адресе запомненное не подменяет (R5) — новый отпечаток
 * запоминает только повторное подключение.
 */
export async function checkRememberedScanner(
  settings: Settings,
  options: ConnectorOptions = {},
  signal?: AbortSignal,
): Promise<RememberedScanner> {
  const { scanner } = settings;
  if (scanner === null) {
    return { state: 'none' };
  }
  const probed = await probeScanner(
    profileOf(scanner),
    options,
    signal === undefined ? {} : { signal },
  );
  // Слот по классу исхода (M5, KTD1): ответ чужого — «другое устройство», молчание, занятость,
  // невнятный ответ и отмена — «не отвечает», так ведёт себя и тот же сканер.
  const outcome = classifyProbe(scanner, probed);
  if (!probed.ok) {
    const { error } = probed;
    return { state: outcome === 'foreign' ? 'otherDevice' : 'unreachable', scanner, error };
  }
  if (outcome === 'foreign') {
    return { state: 'otherDevice', scanner, error: null };
  }
  return {
    state: 'ready',
    connected: probed.value,
    params: resolveScanParams(settings.params, probed.value.options),
  };
}
