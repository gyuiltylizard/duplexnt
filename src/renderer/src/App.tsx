import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AddedPassIntent,
  DomainError,
  SessionSnapshot,
  StartPassRequest,
  StartupNotice,
} from '@shared';
import { NoticesBar } from './components/NoticesBar';
import { Toast, type ToastAction } from './components/Toast';
import { DeviceModal } from './modals/DeviceModal';
import { MismatchModal } from './modals/MismatchModal';
import { EditorScreen } from './screens/EditorScreen';
import { FlipScreen } from './screens/FlipScreen';
import { IncompatibleScreen } from './screens/IncompatibleScreen';
import { MergeScreen, MERGE_PAUSE_DECLINED_MS, MERGE_PAUSE_MS } from './screens/MergeScreen';
import { ScanScreen } from './screens/ScanScreen';
import { SetupScreen } from './screens/SetupScreen';
import { assemblyLanded, mismatchDue } from './state/assembly-outcome';
import { errorTextInline } from './state/error-text';
import { createSnapshotStore } from './state/snapshot-store';
import { screenOf, type Screen } from './state/screen';
import './app.css';

// Каркас интерфейса M1 (U20): экран выводится из снимка, своего состояния сессии у renderer
// нет (KTD-23). Здесь живёт то, что переживает смену экрана: закрытые уведомления запуска,
// единственный тост (новый гасит предыдущий сменой `key`), модалка `device`, отказ последнего
// запуска прохода (экран на время запуска уходит и возвращается, S6), пауза `merge` поверх
// `screenOf` (M2, KTD-5), подтверждение модалки `mismatch` (M2, KTD-8) и память о последнем
// запуске прохода — ради посадки добавленного набора (M3.5, KTD-7).

interface ToastState {
  /** Идентичность тоста — `key` элемента: новый ключ перезапускает срок показа. */
  readonly key: string;
  readonly text: string;
  readonly durationMs: number | undefined;
  readonly action: ToastAction | undefined;
}

/** Тост отказа запуска из `add` — 6 с, как у ошибок сохранения (handoff M3.5, S10). */
const ADD_FAILED_TOAST_MS = 6000;

/**
 * Отказ последнего запуска прохода — с адресатом: запуск с `setup` показывается плашкой S6,
 * досканирование — строкой в плашке S17, запуск оборотов — плашкой на `flip` (M2, S2: потолок
 * ретрая занятости приходит сюда же). Отказ не переезжает между экранами: после «Нового
 * сканирования» плашка `editor` не всплывает на `setup` (ревью сессии 9). Отказ запуска из
 * модалки `add` идёт тостом, не плашкой (M3.5, KTD-6) — сюда не попадает.
 */
interface LaunchFailure {
  readonly error: DomainError;
  readonly target: 'setup' | 'editor' | 'flip';
}

/** Посадка запуска: лента получила страницы. `key` — первая добавленная, `added` — сколько. */
interface Landing {
  readonly key: string | null;
  readonly added: number;
}

/**
 * Последний запуск прохода (M3.5, KTD-7): какая сессия и какие страницы были до него. По нему
 * App узнаёт добавленный набор, когда снимок возвращает в `editor`, — независимо от того, дошёл
 * ли кадр `scan` (снимки приходят пачкой) и от ответа команды (он может прийти раньше снимка).
 */
interface Launch {
  /** Порядковый номер запуска за процесс — ключ `EditorScreen` после посадки. */
  readonly epoch: number;
  /** Намерение запуска: добавленный набор или проход по политике ядра (`null`). */
  readonly kind: AddedPassIntent['kind'] | null;
  /** `null` — запуск без сессии (с `setup`): посадки не будет. */
  readonly sessionId: string | null;
  readonly keysBefore: ReadonlySet<string>;
  /** `null` — ждём страниц; запуск без страниц (отказ, «Остановить») садится пустым. */
  readonly landed: Landing | null;
}

const NO_LANDING: Landing = { key: null, added: 0 };

/** Место посадки набора: с какого запуска и на какой странице `EditorScreen` смонтирован. */
interface Seat {
  readonly epoch: number;
  readonly key: string;
}

const keysOf = (session: SessionSnapshot): ReadonlySet<string> =>
  new Set(session.passes.flatMap((pass) => pass.pages.map((page) => page.key)));

export function App(): ReactNode {
  const { t } = useTranslation();
  // Подписку на мост хранилище включает с первым подписчиком и выключает с последним —
  // размонтирование и повторное монтирование StrictMode оно переживает само.
  const [store] = useState(() => createSnapshotStore(window.api));
  const snapshot = useSyncExternalStore(store.subscribe, store.get);

  const [dismissed, setDismissed] = useState<ReadonlySet<StartupNotice>>(new Set());
  const dismissNotice = useCallback((notice: StartupNotice) => {
    setDismissed((previous) => new Set(previous).add(notice));
  }, []);

  const [toast, setToast] = useState<ToastState | null>(null);
  const expireToast = useCallback(() => {
    setToast(null);
  }, []);
  // Номер растёт: новый тост со сменой `key` перезапускает срок показа.
  const toastSeq = useRef(0);
  const showToast = useCallback((text: string, durationMs?: number, action?: ToastAction) => {
    toastSeq.current += 1;
    setToast({ key: `toast:${String(toastSeq.current)}`, text, durationMs, action });
  }, []);

  // Память о запуске (KTD-7): ставится в `startPass`, посадка — корректировкой при рендере.
  const [launch, setLaunch] = useState<Launch | null>(null);
  // Место посадки живёт отдельно от запуска: следующий запуск не должен перемонтировать
  // `editor`, пока тот на экране (отказ до снимка оставляет редактор как был).
  const [seat, setSeat] = useState<Seat | null>(null);

  // Пауза `merge` (KTD-5): эфемерное состояние поверх `screenOf`, живёт только в renderer и
  // после перезапуска не повторяется — на старте процесса предыдущего экрана нет, переход
  // не срабатывает. Переход ловится корректировкой состояния при рендере (react.dev «You
  // Might Not Need an Effect», как `known` в SetupScreen) — это идемпотентно и переживает
  // StrictMode double-render. Условие читает отчёт, а не промежуточные экраны: снимки могут
  // прийти пачкой, и кадр `scan` между `flip` и `editor` легко пропустить. После добавленного
  // прохода паузы нет (M3.5, R15): по роли последнего прохода сессии (досканирование набора
  // идёт без намерения) и по намерению запуска — проход без страниц ядро из журнала
  // выбрасывает, и последним снова становится проход оборотов.
  const [mergeHoldMs, setMergeHoldMs] = useState<number | null>(null);
  // Ожидание оценок пустых оборотов (M4, KTD6; handoff M4, S12; решение автора 2026-10-22):
  // по истечении паузы экран держится, пока `blank.pending` не станет 0, — без потолка. Флаг
  // ставится вместе с паузой и снимается корректировкой при рендере, как только ждать нечего.
  const [mergeBlankWait, setMergeBlankWait] = useState(false);
  const [previousScreen, setPreviousScreen] = useState<Screen | null>(null);
  const screen = snapshot === null ? null : screenOf(snapshot);
  const session = snapshot?.session ?? null;
  const lastPass = session?.passes.at(-1);
  if (screen !== previousScreen) {
    setPreviousScreen(screen);
    const transitionReport = snapshot?.assembly?.report;
    if (
      screen === 'editor' &&
      (previousScreen === 'scan' || previousScreen === 'flip') &&
      transitionReport !== undefined &&
      assemblyLanded(transitionReport) &&
      lastPass?.kind !== 'added' &&
      !(launch?.kind === 'added' && launch.sessionId === session?.id)
    ) {
      setMergeHoldMs(transitionReport.backsDeclined ? MERGE_PAUSE_DECLINED_MS : MERGE_PAUSE_MS);
      // Ждать оценок есть смысл, когда они прячут страницы: в режиме наборов ничего не скрыто
      // (R15), статус про пустые там не рисуется — держать экран нечем объяснить (ревью).
      setMergeBlankWait(transitionReport.mode !== 'sets');
    }
  }
  const blankPending = snapshot?.assembly?.blank.pending ?? 0;
  if (mergeBlankWait && blankPending === 0) {
    setMergeBlankWait(false);
  }

  // Посадка добавленного набора (KTD-7; handoff S9–S10): в `editor` той же сессии появились
  // страницы, которых до запуска не было. Проход добавленного набора завершён или остановлен с
  // принятыми страницами — текущая на первой добавленной (ключ `EditorScreen` меняется — экран
  // монтируется заново, как и после кадра `scan`) и тост «Добавлено N»; ключ тоста — номер
  // запуска, поэтому повторный рендер той же посадки (StrictMode) тост не перезапускает.
  // Прерван — тоста нет, его место занимает плашка S4; у прохода другой роли посадки нет — там
  // пауза `merge`. Пока страниц нет (кадр до первой страницы) — запуск ждёт снимка или ответа.
  if (
    launch !== null &&
    launch.landed === null &&
    screen === 'editor' &&
    session !== null &&
    session.id === launch.sessionId &&
    lastPass !== undefined
  ) {
    const fresh =
      snapshot?.assembly?.order
        .map((entry) => entry.key)
        .filter((key) => !launch.keysBefore.has(key)) ?? [];
    if (fresh.length > 0) {
      const added = lastPass.kind === 'added' && lastPass.state !== 'interrupted';
      const key = fresh[0] ?? null;
      setLaunch({ ...launch, landed: added ? { key, added: fresh.length } : NO_LANDING });
      if (added && key !== null) {
        setSeat({ epoch: launch.epoch, key });
      }
      if (added) {
        setToast({
          key: `added:${String(launch.epoch)}`,
          text: t('toast.added', { count: fresh.length }),
          durationMs: undefined,
          action: undefined,
        });
      }
    }
  }

  useEffect(() => {
    if (mergeHoldMs === null) {
      return;
    }
    const timer = setTimeout(() => {
      setMergeHoldMs(null);
    }, mergeHoldMs);
    return () => {
      clearTimeout(timer);
    };
  }, [mergeHoldMs]);

  // Подтверждение `mismatch` — на время жизни процесса и на конкретную сессию (KTD-8):
  // после перезапуска модалка показывается снова, новая сессия начинает с чистого листа.
  const [mismatchConfirmedFor, setMismatchConfirmedFor] = useState<string | null>(null);

  const [deviceModal, setDeviceModal] = useState<{ readonly initialAddress?: string } | null>(null);
  const [launchFailure, setLaunchFailure] = useState<LaunchFailure | null>(null);

  const openDevice = useCallback((initialAddress?: string) => {
    // Открытие модалки снимает плашку отказа запуска (S6).
    setLaunchFailure(null);
    setDeviceModal(initialAddress === undefined ? {} : { initialAddress });
  }, []);
  const closeDevice = useCallback(() => {
    setDeviceModal(null);
  }, []);
  const deviceConnected = useCallback(
    (label: string) => {
      showToast(t('toast.connected', { name: label }));
    },
    [showToast, t],
  );

  const startInFlight = useRef(false);
  const startPass = useCallback(
    (request: StartPassRequest) => {
      // Повторный клик до ответа не шлёт второй запуск: тот вернул бы `passRunning`, и плашка
      // отказа повисла бы над удавшимся проходом (находка simplify-ревью сессии 9).
      if (startInFlight.current) {
        return;
      }
      startInFlight.current = true;
      setLaunchFailure(null);
      const before = store.get()?.session ?? null;
      setLaunch((previous) => ({
        epoch: (previous?.epoch ?? 0) + 1,
        kind: request === null ? null : request.kind,
        sessionId: before?.id ?? null,
        keysBefore: before === null ? new Set() : keysOf(before),
        landed: null,
      }));
      // Ответ придёт, когда задание закрыто; экран тем временем сменится по снимку. Отказ до
      // первой страницы возвращает на экран-источник — плашка ждёт его здесь, с адресатом.
      // Запуск из `add` — тостом (KTD-6): и отказ до старта, и обрыв до первой страницы (ядро
      // отбрасывает пустой проход и отвечает «прерван, 0 стр.» с причиной).
      window.api.startPass(request).then(
        (result) => {
          startInFlight.current = false;
          if (result.ok && result.value.pages > 0) {
            return;
          }
          // Страниц этот запуск не дал: ждать посадки по снимку нечего (снимок мог и опередить).
          setLaunch((previous) =>
            previous?.landed === null ? { ...previous, landed: NO_LANDING } : previous,
          );
          const error = result.ok ? result.value.error : result.error;
          if (request !== null) {
            if (error !== null) {
              showToast(
                t('toast.addFailed', { error: errorTextInline(t, error) }),
                ADD_FAILED_TOAST_MS,
              );
            }
            return;
          }
          if (!result.ok) {
            // Адресат отказа — экран, на который снимок вернул после отказа: он и есть
            // экран-источник запуска (`setup`, `flip` или `editor` при досканировании).
            const returned = store.get();
            const screen = returned === null ? 'setup' : screenOf(returned);
            const target = screen === 'flip' || screen === 'editor' ? screen : 'setup';
            setLaunchFailure({ error: result.error, target });
          }
        },
        (error: unknown) => {
          startInFlight.current = false;
          console.error('[renderer] запуск прохода не ответил', error);
        },
      );
    },
    [store, showToast, t],
  );
  const startNext = useCallback(() => {
    startPass(null);
  }, [startPass]);
  const startAdded = useCallback(
    (after: string | null) => {
      startPass({ kind: 'added', after });
    },
    [startPass],
  );

  const stopPass = useCallback(() => {
    // Исход остановки виден по снимку; отдельного текста заслуживает только несмытый сегмент:
    // страницы остались, проход прерван (S15 → тост).
    window.api.stopPass().then(
      (result) => {
        if (!result.ok && result.error.code === 'sessionCloseFailed') {
          showToast(t('toast.stopCloseFailed'));
        }
      },
      (error: unknown) => {
        console.error('[renderer] остановка прохода не ответила', error);
      },
    );
  }, [showToast, t]);

  if (snapshot === null || screen === null) {
    // Первый снимок ещё не пришёл: main отвечает за миллисекунды, рисовать нечего.
    return null;
  }

  if (screen === 'incompatible') {
    // Единственный экран: ни уведомлений, ни тостов, ни модалок над ним (S22).
    return (
      <div className="app">
        <IncompatibleScreen />
      </div>
    );
  }

  // `pagesLost` показывается, только когда потерянные страницы правда видны в ленте (S20).
  const anyLost = session?.passes.some((pass) => pass.pages.some((page) => page.lost)) ?? false;
  const notices = snapshot.notices.filter(
    (notice) => !dismissed.has(notice) && (notice !== 'pagesLost' || anyLost),
  );

  const assembly = snapshot.assembly;
  // Пауза `merge` — поверх выведенного экрана `editor` (KTD-5); после неё — ожидание оценок
  // пустых оборотов (M4, S12).
  const merging =
    screen === 'editor' &&
    assembly !== null &&
    (mergeHoldMs !== null || (mergeBlankWait && blankPending > 0));
  // `mismatch` (KTD-8; M3.6, R20): первый вход в editor за процесс при неподтверждённом
  // режиме раздельных наборов — включая вход через «Оставить как есть» и после перезапуска;
  // условие уместности — общий предикат `mismatchDue` (добавленные наборы показ не отменяют,
  // после сборки модалки нет). Подтверждение — на сессию, id сужается здесь же.
  const mismatchSessionId =
    screen === 'editor' &&
    !merging &&
    assembly !== null &&
    session !== null &&
    mismatchDue(assembly.report)
      ? session.id
      : null;
  const showMismatch = mismatchSessionId !== null && mismatchConfirmedFor !== mismatchSessionId;

  return (
    <div className="app">
      {screen !== 'scan' && !merging && <NoticesBar notices={notices} onDismiss={dismissNotice} />}
      {screen === 'setup' && (
        <SetupScreen
          snapshot={snapshot}
          launchFailure={launchFailure?.target === 'setup' ? launchFailure.error : null}
          onStart={startNext}
          onOpenDevice={openDevice}
        />
      )}
      {screen === 'scan' && snapshot.pass !== null && (
        <ScanScreen snapshot={snapshot} pass={snapshot.pass} onStop={stopPass} />
      )}
      {screen === 'flip' && (
        <FlipScreen
          snapshot={snapshot}
          pass={snapshot.pass}
          launchFailure={launchFailure?.target === 'flip' ? launchFailure.error : null}
          onStart={startNext}
          onOpenDevice={openDevice}
        />
      )}
      {merging && <MergeScreen assembly={assembly} />}
      {screen === 'editor' && !merging && session !== null && (
        <EditorScreen
          key={seat?.epoch ?? 0}
          snapshot={snapshot}
          session={session}
          initialCurrent={seat?.key ?? null}
          resumeFailure={launchFailure?.target === 'editor' ? launchFailure.error : null}
          onResume={startNext}
          onAdd={startAdded}
          onOpenDevice={openDevice}
          onToast={showToast}
        />
      )}
      {showMismatch && assembly !== null && (
        <MismatchModal
          report={assembly.report}
          onClose={() => {
            setMismatchConfirmedFor(mismatchSessionId);
          }}
        />
      )}
      {/* `device` открывается и из `editor` (ссылка в плашке S17), и из `flip` (плашка
          отказа запуска оборотов — иначе из него не выбраться к подключению). */}
      {deviceModal !== null && (screen === 'setup' || screen === 'editor' || screen === 'flip') && (
        <DeviceModal
          initialAddress={deviceModal.initialAddress}
          onClose={closeDevice}
          onConnected={deviceConnected}
        />
      )}
      {toast !== null && (
        <Toast
          key={toast.key}
          text={toast.text}
          durationMs={toast.durationMs}
          action={toast.action}
          onExpire={expireToast}
        />
      )}
    </div>
  );
}
