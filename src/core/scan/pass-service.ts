import { setTimeout as delay } from 'node:timers/promises';
import {
  fail,
  ok,
  type DomainError,
  sessionConflict,
  type PassProgress,
  type PassReport,
  type Result,
  type ScanParams,
  type SessionConflictReason,
  type ScannerState,
  type Snapshot,
  type StartupNotice,
} from '@shared';
import type { ConnectedScanner, ConnectorOptions } from '../escl/connect';
import { jobPathFromLocation } from '../escl/device-path';
import {
  closeScanJob,
  runScanJob,
  SCAN_JOB_LIMITS,
  type ScanJobClock,
  type ScanJobEnd,
  type ScanJobLimits,
} from '../escl/scan-job';
import { buildScanSettings, resolveScanParams } from '../escl/scan-settings';
import { parseStatus } from '../escl/status';
import { createTransport, type ScannerTransport } from '../escl/transport';
import type { PassOrigin } from '../storage/journal';
import { openSessionStore } from '../storage/reconcile';
import type { PageInfo, SessionStore, SessionStoreOptions } from '../storage/session-store';
import {
  checkRememberedScanner,
  openSettingsStore,
  type SettingsStore,
} from '../storage/settings-store';
import {
  sameScanner,
  scannerInfoOf,
  storedScannerOf,
  type StoredScanner,
} from '../storage/stored-scanner';
import { storageFailure } from '../storage/storage-fs';
import { pagePixelLimit } from '../storage/thumbnails';
import { openUnclosedJobs, type UnclosedJobs } from '../storage/unclosed-jobs';

// Служба прохода (план M1, U17): связывает клиент сканера, хранилище сессии, настройки и
// незакрытые задания в один сценарий и выдаёт снимок, из которого интерфейс выводит экран
// (KTD-23). Состояние прохода — по диаграмме плана:
//
//   идёт → завершён        `404` после страниц
//   идёт → прерван         сбой, таймаут, закрытие окна
//   идёт → (нет)           «Остановить» в первом сегменте или ноль страниц
//   прерван → идёт         досканировать остаток — с параметрами и сканером прохода (KTD-27)
//   идёт → прерван         «Остановить» при досканировании: удалён только идущий сегмент
//   прерван → принят       оставить как есть
//
// Старт прохода по шагам: закрыть незакрытые задания этого сканера (KTD-11) → прочитать лоток
// (R9) → записать сегмент «идёт» в журнал (KTD-17) → `POST`. Исход сегмента пишется до `DELETE`:
// обработчик `onEnd` задания переводит его в хранилище, и только потом задание закрывается.
//
// В M1 проход один: новый проход начинается только без сессии; при прерванном — досканирование.

export interface PassServiceOptions extends SessionStoreOptions {
  /** Транспорт и его пределы — подмена для тестов, как у подключения. */
  readonly connector?: ConnectorOptions;
  readonly jobLimits?: Partial<ScanJobLimits>;
  readonly clock?: ScanJobClock;
  /** Снимок изменился; `seq` — его номер. */
  readonly onChange?: (seq: number) => void;
}

export interface PassService {
  snapshot(): Snapshot;
  /** Проверка запомненного сканера при запуске; исход — в снимке. */
  checkRememberedScanner(signal?: AbortSignal): Promise<void>;
  /** Сканер подключён явным действием пользователя: запоминается, параметры сверяются (KTD-13). */
  useScanner(connected: ConnectedScanner): Promise<Result<void>>;
  setParams(params: ScanParams): Promise<Result<void>>;
  /**
   * Новый проход или досканирование прерванного. Возвращается, когда задание закрыто. Отказ —
   * проход не начался или не оставил ни страницы, ни сессии.
   */
  startPass(): Promise<Result<PassReport>>;
  /** «Остановить». Встаёт за идущей записью страницы; возвращается, когда задание закрыто. */
  stopPass(): Promise<Result<void>>;
  /** «Оставить как есть». */
  acceptPass(): Promise<Result<void>>;
  /** «Новая пачка». */
  closeSession(): Promise<Result<void>>;
  /**
   * Закрытие окна во время прохода (KTD-26): задание обрывается, проход помечается прерванным,
   * `DELETE` уходит в пределах срока. Возвращается не позже срока.
   */
  interrupt(deadlineMs: number): Promise<void>;
  /** Страницы текущей сессии — для схемы изображений и миниатюр. */
  pageInfo(key: string): PageInfo | null;
  readPage(key: string): Promise<Result<Uint8Array>>;
}

interface Dependencies {
  readonly store: SessionStore;
  readonly settings: SettingsStore;
  readonly unclosedJobs: UnclosedJobs;
  readonly notices: readonly StartupNotice[];
}

type ScannerSlot =
  | { readonly kind: 'none' }
  | { readonly kind: 'checking'; readonly stored: StoredScanner }
  | { readonly kind: 'ready'; readonly connected: ConnectedScanner; readonly params: ScanParams }
  | { readonly kind: 'unreachable'; readonly stored: StoredScanner; readonly error: DomainError }
  | {
      readonly kind: 'otherDevice';
      readonly stored: StoredScanner;
      readonly error: DomainError | null;
    };

/** Идущий запуск прохода. */
interface Run {
  readonly controller: AbortController;
  readonly resumed: boolean;
  phase: PassProgress['phase'];
  pages: number;
  /** Чем оборван: «Остановить» удаляет сегмент, закрытие окна оставляет его прерванным. */
  intent: 'stop' | 'shutdown' | null;
  /** Итог запуска — для «Остановить», которое его дожидается. */
  done: Promise<Result<PassReport>>;
}

const conflict = (reason: SessionConflictReason): Result<never> => ({
  ok: false,
  error: sessionConflict(reason),
});

/** Причина обрыва задания — кодом: отказ устройства как есть, отказ приёмника — через хранилище. */
export function interruptionError(end: ScanJobEnd): DomainError | null {
  if (end.kind !== 'interrupted') {
    return null;
  }
  return end.reason.source === 'device' ? end.reason.error : storageFailure(end.reason.error);
}

function unsupportedField(
  params: ScanParams,
  options: ConnectedScanner['options'],
): 'colorMode' | 'resolution' | 'paperSize' | null {
  if (!options.colorModes.includes(params.colorMode)) {
    return 'colorMode';
  }
  if (!options.resolutions.includes(params.resolution)) {
    return 'resolution';
  }
  return options.paperSizes.includes(params.paperSize) ? null : 'paperSize';
}

export function createPassService(
  { store, settings, unclosedJobs, notices }: Dependencies,
  options: PassServiceOptions = {},
): PassService {
  const jobLimits: ScanJobLimits = { ...SCAN_JOB_LIMITS, ...options.jobLimits };
  const connector = options.connector ?? {};
  const newTransport = (profile: ConnectedScanner['profile']): ScannerTransport =>
    (connector.createTransport ?? createTransport)(profile, connector.limits);

  let scanner: ScannerSlot = { kind: 'none' };
  let run: Run | null = null;
  let seq = 0;

  const notify = (): void => {
    seq += 1;
    options.onChange?.(seq);
  };

  const scannerState = (): ScannerState => {
    switch (scanner.kind) {
      case 'none':
        return { kind: 'none' };
      case 'checking':
        return { kind: 'checking', scanner: scannerInfoOf(scanner.stored) };
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
        };
      case 'otherDevice':
        return {
          kind: 'otherDevice',
          scanner: scannerInfoOf(scanner.stored),
          error: scanner.error,
        };
    }
  };

  // Досканировать можно только тот же сканер, что вёл проход (KTD-27).
  function resumeTarget(): Result<PassOrigin> {
    const target = store.resumeTarget();
    if (!target.ok || scanner.kind !== 'ready') {
      return target;
    }
    return sameScanner(target.value.scanner, storedScannerOf(scanner.connected))
      ? target
      : conflict('otherScanner');
  }

  function snapshot(): Snapshot {
    const session = store.snapshot();
    const last = session?.passes.at(-1);
    return {
      seq,
      scanner: scannerState(),
      session,
      pass: run === null ? null : { phase: run.phase, resumed: run.resumed, pages: run.pages },
      canResume: run === null && scanner.kind === 'ready' && resumeTarget().ok,
      canAccept: run === null && last?.state === 'interrupted',
      storage: { incompatible: store.incompatible, unsaved: store.unsaved() },
      notices,
    };
  }

  // Исход сегмента — в хранилище, до `DELETE` (KTD-17). «Завершён» и «прерван» хранилище
  // принимает и при отказе записи журнала; тогда запись повторяется здесь же, пока задание ещё
  // не закрыто. Ноль страниц в новом проходе — не проход (R9): сегмент убирается, сессии нет.
  async function settleSegment(
    end: ScanJobEnd,
    pages: number,
    current: Run,
  ): Promise<DomainError | null> {
    const discard = async (): Promise<DomainError | null> => {
      const discarded = await store.discardSegment();
      return discarded.ok ? null : discarded.error;
    };
    const finish = async (outcome: 'completed' | 'interrupted'): Promise<null> => {
      await store.endSegment(outcome);
      if (store.unsaved()) {
        await store.flush();
      }
      return null;
    };
    switch (end.kind) {
      case 'completed':
        return finish('completed');
      case 'empty':
        return discard();
      case 'canceled':
        return current.intent === 'shutdown' ? finish('interrupted') : discard();
      case 'interrupted':
        return pages === 0 && !current.resumed ? discard() : finish('interrupted');
    }
  }

  // Незакрытые задания этого сканера закрываются перед `POST` (KTD-11): путь из файла заново
  // проходит проверку KTD-7. Затем читается лоток (R9): пустой — отказ до задания.
  async function prepare(
    transport: ScannerTransport,
    stored: StoredScanner,
    signal: AbortSignal,
  ): Promise<Result<void>> {
    const { basePath } = stored;
    for (const path of unclosedJobs.jobsOf(stored)) {
      // Молчащий сканер держал бы «Остановить» и закрытие окна на каждом задании.
      if (signal.aborted) {
        return fail('canceled');
      }
      const jobPath = jobPathFromLocation(path, basePath);
      if (
        jobPath === null ||
        (await closeScanJob(transport, jobPath, jobLimits.deleteDeadlineMs))
      ) {
        await unclosedJobs.remove(stored, path);
      }
    }
    if (signal.aborted) {
      return fail('canceled');
    }
    const response = await transport.request({
      method: 'GET',
      path: `${basePath}/ScannerStatus`,
      signal,
    });
    if (!response.ok) {
      return response;
    }
    if (response.value.status !== 200) {
      return fail('scannerBadResponse', { reason: 'status', status: response.value.status });
    }
    const status = parseStatus(response.value.body);
    if (!status.ok) {
      return status;
    }
    return status.value.adfState === 'ScannerAdfEmpty' ? fail('scanNoPaper') : ok(undefined);
  }

  async function runPass(
    current: Run,
    connected: ConnectedScanner,
    origin: PassOrigin,
  ): Promise<Result<PassReport>> {
    const stored = origin.scanner;
    const settingsXml = buildScanSettings(origin.params, connected.capabilities);
    if (!settingsXml.ok) {
      return settingsXml;
    }
    const transport = newTransport(connected.profile);
    try {
      const prepared = await prepare(transport, stored, current.controller.signal);
      if (!prepared.ok) {
        // «Остановить» до задания: ни сегмента, ни страниц — останавливать нечего.
        return prepared.error.code === 'canceled' && current.intent === 'stop'
          ? ok({ end: 'stopped', pages: 0, error: null })
          : prepared;
      }
      const begun = current.resumed ? await store.resumePass() : await store.beginPass(origin);
      if (!begun.ok) {
        return begun;
      }
      notify();

      // Исход, записанный обработчиком задания; `null` — обработчик не вызывался (задание не
      // создано, адрес негоден, отмена до `POST`), и исход переводится по отчёту. Поле объекта,
      // а не переменная: присваивание идёт из обработчика, и сужение типа иначе его не видит.
      const settled: { value: { readonly error: DomainError | null } | null } = { value: null };
      const result = await runScanJob({
        transport,
        basePath: stored.basePath,
        settings: settingsXml.value,
        signal: current.controller.signal,
        limits: jobLimits,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        sink: async ({ body }) => {
          await store.acceptPage(body);
          current.pages += 1;
          notify();
        },
        onPhase: (phase) => {
          // «Остановить» уже нажато: фаза остаётся «останавливаем», пока задание не закрыто.
          if (current.intent !== null) {
            return;
          }
          current.phase = phase;
          notify();
        },
        onJobCreated: async (jobPath) => {
          await unclosedJobs.add(stored, jobPath);
        },
        onEnd: async (end, pages) => {
          settled.value = { error: await settleSegment(end, pages, current) };
        },
      });

      if (!result.ok) {
        // `POST` не прошёл: задания нет, сегмент «идёт» убирается из журнала.
        await store.discardSegment();
        return result;
      }
      const report = result.value;
      const { job } = report;
      if (job !== null && job.path !== null) {
        await (job.closed
          ? unclosedJobs.remove(stored, job.path)
          : unclosedJobs.add(stored, job.path));
      }
      const settleError =
        settled.value === null
          ? await settleSegment(report.end, report.pages, current)
          : settled.value.error;

      const { end } = report;
      if (end.kind === 'completed') {
        return ok({ end: 'completed', pages: report.pages, error: null });
      }
      if (end.kind === 'empty') {
        return fail('scanNoPaper');
      }
      if (end.kind === 'canceled' && current.intent !== 'shutdown') {
        // «Остановить», которое не удалось довести: сегмент остался прерванным, страницы целы.
        return settleError === null
          ? ok({ end: 'stopped', pages: 0, error: null })
          : ok({ end: 'interrupted', pages: report.pages, error: settleError });
      }
      const error =
        end.kind === 'canceled' ? { code: 'canceled' as const } : interruptionError(end);
      // Ни страницы, ни сессии не осталось — проход не состоялся.
      return store.snapshot() === null
        ? { ok: false, error: error ?? { code: 'canceled' } }
        : ok({ end: 'interrupted', pages: report.pages, error });
    } finally {
      transport.close();
    }
  }

  async function startPass(): Promise<Result<PassReport>> {
    if (run !== null) {
      return conflict('passRunning');
    }
    if (store.incompatible) {
      return fail('storageIncompatible');
    }
    if (scanner.kind !== 'ready') {
      return fail('scannerNotConnected');
    }
    const { connected, params } = scanner;
    const stored = storedScannerOf(connected);

    // Сессия есть — только досканирование: новый проход в M1 начинается без сессии.
    let origin: PassOrigin;
    let resumed = false;
    if (store.snapshot() === null) {
      origin = { scanner: stored, params, pixelLimit: pagePixelLimit(connected.capabilities.adf) };
    } else {
      const target = resumeTarget();
      if (!target.ok) {
        return target;
      }
      origin = target.value;
      resumed = true;
    }

    const current: Run = {
      controller: new AbortController(),
      resumed,
      phase: 'starting',
      pages: 0,
      intent: null,
      done: Promise.resolve(fail('canceled')),
    };
    run = current;
    current.done = runPass(current, connected, origin).finally(() => {
      run = null;
      notify();
    });
    notify();
    const outcome = await current.done;
    if (!outcome.ok && outcome.error.code === 'scannerCertificateChanged') {
      // По адресу другое устройство (KTD-40): новый отпечаток запомнит только повторное подключение.
      scanner = { kind: 'otherDevice', stored, error: outcome.error };
      notify();
    }
    return outcome;
  }

  return {
    snapshot,

    async checkRememberedScanner(signal) {
      const remembered = settings.get().scanner;
      if (remembered === null) {
        return;
      }
      const checking: ScannerSlot = { kind: 'checking', stored: remembered };
      scanner = checking;
      notify();
      const checked = await checkRememberedScanner(settings.get(), connector, signal);
      // Пока шла проверка, пользователь подключил сканер сам: его выбор не перезаписывается.
      if (scanner !== checking) {
        return;
      }
      switch (checked.state) {
        case 'none':
          scanner = { kind: 'none' };
          break;
        case 'ready':
          scanner = { kind: 'ready', connected: checked.connected, params: checked.params };
          break;
        case 'unreachable':
          scanner = { kind: 'unreachable', stored: checked.scanner, error: checked.error };
          break;
        case 'otherDevice':
          scanner = { kind: 'otherDevice', stored: checked.scanner, error: checked.error };
          break;
      }
      notify();
    },

    async useScanner(connected) {
      if (run !== null) {
        return conflict('passRunning');
      }
      scanner = {
        kind: 'ready',
        connected,
        params: resolveScanParams(settings.get().params, connected.options),
      };
      notify();
      // Отказ записи настроек подключения не отменяет: сканер остаётся в памяти до конца работы.
      await settings.rememberScanner(storedScannerOf(connected));
      return ok(undefined);
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

    startPass,

    async stopPass() {
      const current = run;
      if (current === null) {
        return conflict('noRunningPass');
      }
      if (current.intent !== null) {
        return conflict('stopping');
      }
      current.intent = 'stop';
      current.phase = 'stopping';
      current.controller.abort();
      notify();
      const outcome = await current.done;
      return outcome.ok
        ? outcome.value.error === null
          ? ok(undefined)
          : { ok: false, error: outcome.value.error }
        : outcome;
    },

    async acceptPass() {
      if (run !== null) {
        return conflict('passRunning');
      }
      const accepted = await store.acceptPass();
      notify();
      return accepted;
    },

    async closeSession() {
      if (run !== null) {
        return conflict('passRunning');
      }
      const closed = await store.closeSession();
      notify();
      return closed;
    },

    async interrupt(deadlineMs) {
      const current = run;
      if (current === null) {
        return;
      }
      if (current.intent === null) {
        current.intent = 'shutdown';
        current.controller.abort();
      }
      await Promise.race([current.done, delay(deadlineMs)]);
    },

    pageInfo: (key) => store.pageInfo(key),
    readPage: (key) => store.readPage(key),
  };
}

/** Сверка при запуске, хранилища и служба над ними — то, что main создаёт один раз. */
export async function openPassService(
  dataRoot: string,
  options: PassServiceOptions = {},
): Promise<PassService> {
  const { store, notices } = await openSessionStore(dataRoot, options);
  const settings = await openSettingsStore(dataRoot, options);
  const unclosedJobs = await openUnclosedJobs(dataRoot, options);
  return createPassService(
    {
      store,
      settings,
      unclosedJobs,
      notices: settings.notice === null ? notices : [...notices, settings.notice],
    },
    options,
  );
}
