import { isIPv4 } from 'node:net';
import { fail, type DomainError, type Result } from '@shared';
import type { UuidCandidate, UuidSearch, UuidSearchOptions } from '../discovery/find-by-uuid';
import {
  probeScanner,
  realProbeClock,
  type ConnectedScanner,
  type ConnectorOptions,
} from '../escl/connect';
import { classifyProbe, type ProbeClass } from './probe-outcome';
import { profileOf, type StoredScanner } from './stored-scanner';

// Где запомненный сканер (M5, U4): проба сохранённого адреса и, если там молчат или отвечает
// чужой, — поиск по UUID с пробой кандидатов запомненным профилем (High-Level Technical Design
// плана). UUID — только ключ поиска; «то же устройство» доказывает отпечаток в пробе (R3).
// Настроек модуль не пишет: новый адрес запоминает слот сканера (KTD5).

/** Старый адрес не дал HTTP-ответа за столько — ищем (KTD3): здоровая проба ET-3850 — ~0,8 с. */
export const SEARCH_THRESHOLD_MS = 1500;
/** Жёсткий срок проверки с поиском от её старта (R6). */
export const CHECK_DEADLINE_MS = 10_000;

export type StartUuidSearch = (options: UuidSearchOptions) => UuidSearch;

/** Исход проверки; `relocated` — сканер подтверждён на новом адресе, его надо запомнить. */
export type Located =
  | { readonly state: 'ready'; readonly connected: ConnectedScanner; readonly relocated: boolean }
  | { readonly state: 'unreachable'; readonly error: DomainError }
  /** `error` — чем выдало себя другое устройство; `null` — исправный сканер с другим UUID. */
  | { readonly state: 'otherDevice'; readonly error: DomainError | null };

// Поиск — на молчание и ответ чужого (R4); занятость, невнятный ответ и отмену он не лечит.
const SEARCHED: ReadonlySet<ProbeClass> = new Set<ProbeClass>(['silent', 'foreign']);

// Слот по классу исхода (KTD1): ответ чужого — «другое устройство», остальное — «не отвечает».
function locatedBy(scanner: StoredScanner, probed: Result<ConnectedScanner>): Located {
  const outcome = classifyProbe(scanner, probed);
  if (!probed.ok) {
    return { state: outcome === 'foreign' ? 'otherDevice' : 'unreachable', error: probed.error };
  }
  return outcome === 'foreign'
    ? { state: 'otherDevice', error: null }
    : { state: 'ready', connected: probed.value, relocated: false };
}

// Ключ поиска или `null`, когда искать нельзя (R5): у HTTP нечем доказать устройство, без UUID
// нечего искать, имя хоста переезд переживает само.
function searchKey({ scheme, fingerprint, host, uuid }: StoredScanner): string | null {
  return scheme === 'https' && fingerprint !== null && isIPv4(host) ? uuid : null;
}

// Следующим — кандидат на сохранённом порту (KTD4): запись на чужом порту для HTTPS бесполезна.
function takeNext(queue: UuidCandidate[], port: number): UuidCandidate | undefined {
  const index = queue.findIndex((candidate) => candidate.port === port);
  return queue.splice(index === -1 ? 0 : index, 1)[0];
}

/**
 * Проверка запомненного сканера. Без поиска (`search` не дан или профиль не подходит, R5) — одна
 * проба сохранённого адреса, как до M5.
 */
export async function locateRemembered(
  scanner: StoredScanner,
  connector: ConnectorOptions = {},
  signal?: AbortSignal,
  search?: StartUuidSearch,
): Promise<Located> {
  const uuid = searchKey(scanner);
  if (search === undefined || uuid === null) {
    const probe = signal === undefined ? {} : { signal };
    return locatedBy(scanner, await probeScanner(profileOf(scanner), connector, probe));
  }
  return locateWithSearch(scanner, uuid, connector, search, signal);
}

async function locateWithSearch(
  scanner: StoredScanner,
  uuid: string,
  connector: ConnectorOptions,
  startSearch: StartUuidSearch,
  signal: AbortSignal | undefined,
): Promise<Located> {
  const clock = connector.clock ?? realProbeClock;
  const timers = new AbortController();
  // Проба старого адреса прерывается отдельно: занятый сканер, уже ответивший там, жёсткий срок
  // не обрывает — он держит «проверяем…» до потолка ожидания (KTD3).
  const oldProbe = new AbortController();
  const candidateProbes = new AbortController();
  const cancel = (): void => {
    oldProbe.abort();
    candidateProbes.abort();
  };
  const seen = { answered: false, expired: false, ended: false };
  if (signal?.aborted === true) {
    cancel();
  } else {
    signal?.addEventListener('abort', cancel, { once: true });
  }
  void clock.sleep(CHECK_DEADLINE_MS, timers.signal).then(() => {
    if (timers.signal.aborted) {
      return;
    }
    seen.expired = true;
    candidateProbes.abort();
    if (!seen.answered) {
      oldProbe.abort();
    }
  });
  // Обрыв по жёсткому сроку — «не отвечает» по таймауту; `canceled` — только внешняя отмена (KTD1).
  const timedOut = (probed: Result<ConnectedScanner>): Result<ConnectedScanner> =>
    !probed.ok && probed.error.code === 'canceled' && seen.expired && signal?.aborted !== true
      ? fail('scannerUnreachable', { reason: 'timeout' })
      : probed;
  // Ответ старого адреса после старта поиска поиск останавливает; до старта — ничего не делает.
  let stopSearch = (): void => undefined;
  const atOld = probeScanner(profileOf(scanner), connector, {
    signal: oldProbe.signal,
    // Любой HTTP-ответ, и `503` тоже, — сканер на месте: поиск не нужен (KTD3, R4).
    onResponse: () => {
      seen.answered = true;
      stopSearch();
    },
  }).then(timedOut);

  try {
    const early = await Promise.race([
      atOld,
      clock.sleep(SEARCH_THRESHOLD_MS, timers.signal).then(() => null),
    ]);
    if (early === null ? seen.answered : !SEARCHED.has(classifyProbe(scanner, early))) {
      return locatedBy(scanner, early ?? (await atOld));
    }

    const queue: UuidCandidate[] = [];
    let wake = (): void => undefined;
    const search = startSearch({
      uuid,
      // Сохранённые адрес и порт уже проверены — их исход известен (KTD4).
      onCandidate: (candidate) => {
        if (candidate.address !== scanner.host || candidate.port !== scanner.port) {
          queue.push(candidate);
          wake();
        }
      },
      signal: candidateProbes.signal,
      clock,
    });
    // Сбой поиска проверку не роняет: остаётся исход старого адреса.
    const searched = search.done
      .catch(() => undefined)
      .then(() => {
        seen.ended = true;
        wake();
      });
    const state: { old: Result<ConnectedScanner> | null; foreign: Located | null } = {
      old: early,
      foreign: null,
    };
    // Чужой — на старом адресе или у кандидата — запоминается на случай, если наш не найдётся.
    const noteForeign = (probed: Result<ConnectedScanner>): void => {
      if (classifyProbe(scanner, probed) === 'foreign') {
        state.foreign ??= locatedBy(scanner, probed);
      }
    };
    if (early !== null) {
      noteForeign(early);
    }
    // Старый адрес ответил, пока шёл поиск: сканер не переезжал, итог — его, даже «занят» (KTD3,
    // R4). Поиск и начатая проба кандидата обрываются сразу, чужой кандидат итог не перебивает.
    const stayed = (): boolean => early === null && seen.answered;
    stopSearch = () => {
      search.stop();
      candidateProbes.abort();
      wake();
    };
    const settled =
      early !== null
        ? Promise.resolve()
        : atOld.then((probed) => {
            state.old = probed;
            noteForeign(probed);
            wake();
          });

    // Кандидаты — по одному; начатая проба не прерывается новым кандидатом (KTD4).
    let confirmed: ConnectedScanner | null = null;
    while (!stayed()) {
      const next = candidateProbes.signal.aborted ? undefined : takeNext(queue, scanner.port);
      if (next !== undefined) {
        // Профиль запомненного с адресом кандидата; «занят» не пережидается — следующий (KTD4).
        const probed = await probeScanner(
          { ...profileOf(scanner), host: next.address, port: next.port },
          connector,
          { signal: candidateProbes.signal, waitBusy: false },
        );
        if (probed.ok && classifyProbe(scanner, probed) === 'ok') {
          confirmed = probed.value;
          break;
        }
        noteForeign(probed);
        continue;
      }
      if (seen.ended && state.old !== null) {
        break;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    // Сокеты закрыты во всех исходах: поиск остановлен, пробы прерваны и дождались. Ответившую
    // старую пробу не обрываем — она держит «проверяем…» до потолка ожидания (KTD3).
    search.stop();
    candidateProbes.abort();
    if (!seen.answered) {
      oldProbe.abort();
    }
    await Promise.all([searched, settled]);

    if (signal?.aborted === true) {
      return locatedBy(scanner, fail('canceled'));
    }
    const old = state.old ?? fail('canceled');
    if (stayed()) {
      return locatedBy(scanner, old);
    }
    if (confirmed !== null) {
      return { state: 'ready', connected: confirmed, relocated: true };
    }
    return state.foreign ?? locatedBy(scanner, old);
  } finally {
    timers.abort();
    signal?.removeEventListener('abort', cancel);
  }
}
