import { z } from 'zod';
import {
  fail,
  ok,
  type DomainError,
  type Result,
  type ScanParams,
  type StartupNotice,
} from '@shared';
import { probeScanner, type ConnectedScanner, type ConnectorOptions } from '../escl/connect';
import { resolveScanParams } from '../escl/scan-settings';
import { scanParamsSchema } from './journal';
import { layoutOf } from './layout';
import { ioOf, serialQueue, storageFailure, type StorageOptions } from './storage-fs';
import {
  profileOf,
  sameScanner,
  storedScannerOf,
  storedScannerSchema,
  type StoredScanner,
} from './stored-scanner';
import { fitsSchema, readVersioned, setAside, writeVersioned } from './versioned-file';

// Настройки и запомненный сканер (план M1, U15, R5, R18). Живут отдельным файлом в корне данных:
// закрытие сессии их не трогает (ADR 0004).
//
// Файл более новой версии не переписывается: приложение работает со значениями по умолчанию в
// памяти и сообщает об этом (KTD-35). Нечитаемый файл отодвигается, а не удаляется.

export const SETTINGS_VERSION = 1;

const settingsSchema = z.strictObject({
  version: z.literal(SETTINGS_VERSION),
  /** Последний подключённый сканер: адрес, имя, идентичность, отпечаток сертификата (KTD-40). */
  scanner: storedScannerSchema.nullable(),
  /** Параметры сканирования, выбранные последними; с устройством сверяются по KTD-13. */
  params: scanParamsSchema.nullable(),
});

export interface Settings {
  readonly scanner: StoredScanner | null;
  readonly params: ScanParams | null;
}

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
}

export async function openSettingsStore(
  dataRoot: string,
  options: StorageOptions = {},
): Promise<SettingsStore> {
  const { root, settingsFile } = layoutOf(dataRoot);
  const io = ioOf(options);
  const { fs } = io;

  let settings: Settings = { scanner: null, params: null };
  let notice: SettingsStore['notice'] = null;
  // Файл, который не переписывается до конца работы: более новой версии или не прочитанный вовсе.
  let frozen = false;
  try {
    const read = await readVersioned(fs, settingsFile, settingsSchema, SETTINGS_VERSION);
    if (read.kind === 'ok') {
      settings = { scanner: read.value.scanner, params: read.value.params };
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
      settings = { scanner: document.scanner, params: document.params };
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

// «Не отвечает», а не «другое устройство»: сбой сети, отмена, ответ `5xx` (сканер занят или
// просыпается) и ответ, который не дочитался или не разобрался, — так ведёт себя и тот же сканер.
function isSilence({ code, details }: DomainError): boolean {
  if (code === 'scannerUnreachable' || code === 'canceled' || code === 'scannerBadResponse') {
    return true;
  }
  const status = details?.status;
  return code === 'notEsclScanner' && typeof status === 'number' && status >= 500;
}

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
  const probed = await probeScanner(profileOf(scanner), options, signal);
  if (!probed.ok) {
    const { error } = probed;
    // Всё, кроме молчания, — ответ кого-то другого: чужой сертификат, не сканер, сканер без
    // автоподачи.
    return { state: isSilence(error) ? 'unreachable' : 'otherDevice', scanner, error };
  }
  if (!sameScanner(scanner, storedScannerOf(probed.value))) {
    return { state: 'otherDevice', scanner, error: null };
  }
  return {
    state: 'ready',
    connected: probed.value,
    params: resolveScanParams(settings.params, probed.value.options),
  };
}
