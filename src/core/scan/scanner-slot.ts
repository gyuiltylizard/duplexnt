import {
  fail,
  ok,
  type DomainError,
  type Result,
  type ScanParams,
  type ScannerState,
} from '@shared';
import type { ConnectedScanner, ConnectorOptions } from '../escl/connect';
import { DEFAULT_SCAN_PARAMS, resolveScanParams, unsupportedField } from '../escl/scan-settings';
import type { StartUuidSearch } from '../storage/remembered-search';
import { checkRememberedScanner, type SettingsStore } from '../storage/settings-store';
import { scannerInfoOf, storedScannerOf, type StoredScanner } from '../storage/stored-scanner';

// Слот сканера службы прохода (M5, KTD5): какой сканер у службы сейчас и как он туда попал —
// проверкой запомненного при запуске или подключением пользователя. Вынесен из службы прохода,
// чтобы та не росла сверх ориентира R21; проход и снимок читают слот через `current()`.

export type ScannerSlotState =
  | { readonly kind: 'none' }
  | { readonly kind: 'checking'; readonly stored: StoredScanner }
  | { readonly kind: 'ready'; readonly connected: ConnectedScanner; readonly params: ScanParams }
  | { readonly kind: 'unreachable'; readonly stored: StoredScanner; readonly error: DomainError }
  | {
      readonly kind: 'otherDevice';
      readonly stored: StoredScanner;
      readonly error: DomainError | null;
    };

export interface ScannerSlotDependencies {
  readonly settings: SettingsStore;
  readonly connector: ConnectorOptions;
  /** Поиск запомненного по UUID, когда сохранённый адрес молчит (M5, KTD9). */
  readonly search: StartUuidSearch;
  /** Снимок изменился. */
  readonly notify: () => void;
  /** Идёт проход: проверка его не трогает. */
  readonly isPassRunning: () => boolean;
}

export interface ScannerSlot {
  current(): ScannerSlotState;
  /** Сканер для снимка. */
  state(): ScannerState;
  /**
   * Проверка запомненного сканера; исход — в слоте. Найденный на новом адресе запоминается.
   * Вызов во время идущей проверки возвращает её же (KTD5).
   */
  check(signal?: AbortSignal): Promise<void>;
  /**
   * Сканер подключён явным действием пользователя: запоминается, параметры сверяются (KTD-13).
   * Отказ во время прохода — у службы.
   */
  use(connected: ConnectedScanner): Promise<void>;
  setParams(params: ScanParams): Promise<Result<void>>;
  /** По адресу сканера прохода ответило другое устройство (KTD-40). */
  markOtherDevice(stored: StoredScanner, error: DomainError): void;
}

export function createScannerSlot({
  settings,
  connector,
  search,
  notify,
  isPassRunning,
}: ScannerSlotDependencies): ScannerSlot {
  let scanner: ScannerSlotState = { kind: 'none' };
  let running: Promise<void> | null = null;

  // Запомненные параметры — для рядов настройки, пока сканер не подтверждён (S2–S4).
  const rememberedParams = (): ScanParams => settings.get().params ?? DEFAULT_SCAN_PARAMS;

  const state = (): ScannerState => {
    switch (scanner.kind) {
      case 'none':
        return { kind: 'none' };
      case 'checking':
        return {
          kind: 'checking',
          scanner: scannerInfoOf(scanner.stored),
          params: rememberedParams(),
        };
      case 'ready':
        return {
          kind: 'ready',
          scanner: scannerInfoOf(storedScannerOf(scanner.connected)),
          options: scanner.connected.options,
          params: scanner.params,
        };
      case 'unreachable':
        return {
          kind: 'unreachable',
          scanner: scannerInfoOf(scanner.stored),
          error: scanner.error,
          params: rememberedParams(),
        };
      case 'otherDevice':
        return {
          kind: 'otherDevice',
          scanner: scannerInfoOf(scanner.stored),
          error: scanner.error,
          params: rememberedParams(),
        };
    }
  };

  async function verify(
    checking: ScannerSlotState,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const checked = await checkRememberedScanner(settings.get(), connector, signal, search);
    // Пока шла проверка, пользователь подключил сканер сам: его выбор не перезаписывается (R8).
    if (scanner !== checking) {
      return;
    }
    let relocated: Promise<unknown> | null = null;
    switch (checked.state) {
      case 'none':
        scanner = { kind: 'none' };
        break;
      case 'ready':
        scanner = { kind: 'ready', connected: checked.connected, params: checked.params };
        // Новый адрес встаёт в очередь настроек в том же тике, что сверка слота: очередь FIFO,
        // и ручное подключение, пришедшее позже, всегда побеждает (KTD5, KTD7). После закрытия
        // приложения настройки не пишутся (R9).
        if (checked.relocated && signal?.aborted !== true) {
          relocated = settings.rememberScanner(storedScannerOf(checked.connected));
        }
        break;
      case 'unreachable':
        scanner = { kind: 'unreachable', stored: checked.scanner, error: checked.error };
        break;
      case 'otherDevice':
        scanner = { kind: 'otherDevice', stored: checked.scanner, error: checked.error };
        break;
    }
    notify();
    // Отказ записи, как у подключения, не отменяет «готов»: адрес остаётся в памяти.
    await relocated;
  }

  return {
    current: () => scanner,
    state,

    check(signal) {
      // Повторная проверка не трогает ни идущий проход, ни рабочее подключение (ревью
      // сессии 9): интерфейс зовёт её только из «не отвечает», но ядро проверяет само.
      if (isPassRunning() || scanner.kind === 'ready') {
        return Promise.resolve();
      }
      // Второй поиск рядом с идущим не нужен: исход у них один (KTD5).
      if (running !== null && scanner.kind === 'checking') {
        return running;
      }
      const remembered = settings.get().scanner;
      if (remembered === null) {
        return Promise.resolve();
      }
      const checking: ScannerSlotState = { kind: 'checking', stored: remembered };
      scanner = checking;
      notify();
      const current = verify(checking, signal).finally(() => {
        if (running === current) {
          running = null;
        }
      });
      running = current;
      return current;
    },

    async use(connected) {
      scanner = {
        kind: 'ready',
        connected,
        params: resolveScanParams(settings.get().params, connected.options),
      };
      notify();
      // Отказ записи настроек подключения не отменяет: сканер остаётся в памяти до конца работы.
      await settings.rememberScanner(storedScannerOf(connected));
    },

    async setParams(params) {
      if (scanner.kind !== 'ready') {
        return fail('scannerNotConnected');
      }
      const field = unsupportedField(params, scanner.connected.options);
      if (field !== null) {
        return fail('scanParamsUnsupported', { field });
      }
      scanner = { ...scanner, params };
      notify();
      await settings.setParams(params);
      return ok(undefined);
    },

    markOtherDevice(stored, error) {
      scanner = { kind: 'otherDevice', stored, error };
      notify();
    },
  };
}
