import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { DomainError, StartupNotice } from '@shared';
import { NoticesBar } from './components/NoticesBar';
import { Toast } from './components/Toast';
import { DeviceModal } from './modals/DeviceModal';
import { MismatchModal } from './modals/MismatchModal';
import { EditorScreen } from './screens/EditorScreen';
import { FlipScreen } from './screens/FlipScreen';
import { IncompatibleScreen } from './screens/IncompatibleScreen';
import { MergeScreen, MERGE_PAUSE_DECLINED_MS, MERGE_PAUSE_MS } from './screens/MergeScreen';
import { ScanScreen } from './screens/ScanScreen';
import { SetupScreen } from './screens/SetupScreen';
import { createSnapshotStore } from './state/snapshot-store';
import { screenOf, type Screen } from './state/screen';
import './app.css';

// Каркас интерфейса M1 (U20): экран выводится из снимка, своего состояния сессии у renderer
// нет (KTD-23). Здесь живёт то, что переживает смену экрана: закрытые уведомления запуска,
// единственный тост (новый гасит предыдущий сменой `key`), модалка `device`, отказ последнего
// запуска прохода (экран на время запуска уходит и возвращается, S6), пауза `merge` поверх
// `screenOf` (M2, KTD-5) и подтверждение модалки `mismatch` (M2, KTD-8).

interface ToastState {
  readonly id: number;
  readonly text: string;
  readonly durationMs: number | undefined;
}

/**
 * Отказ последнего запуска прохода — с адресатом: запуск с `setup` показывается плашкой S6,
 * досканирование — строкой в плашке S17, запуск оборотов — плашкой на `flip` (M2, S2: потолок
 * ретрая занятости приходит сюда же). Отказ не переезжает между экранами: после «Нового
 * сканирования» плашка `editor` не всплывает на `setup` (ревью сессии 9).
 */
interface LaunchFailure {
  readonly error: DomainError;
  readonly target: 'setup' | 'editor' | 'flip';
}

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
  // Номер растёт от предыдущего: новый тост со сменой `key` перезапускает срок показа.
  const showToast = useCallback((text: string, durationMs?: number) => {
    setToast((previous) => ({ id: (previous?.id ?? 0) + 1, text, durationMs }));
  }, []);

  // Пауза `merge` (KTD-5): эфемерное состояние поверх `screenOf`, живёт только в renderer и
  // после перезапуска не повторяется — на старте процесса предыдущего экрана нет, переход
  // не срабатывает. Переход ловится корректировкой состояния при рендере (react.dev «You
  // Might Not Need an Effect», как `known` в SetupScreen) — это идемпотентно и переживает
  // StrictMode double-render. Условие читает отчёт, а не промежуточные экраны: снимки могут
  // прийти пачкой, и кадр `scan` между `flip` и `editor` легко пропустить.
  const [mergeHoldMs, setMergeHoldMs] = useState<number | null>(null);
  const [previousScreen, setPreviousScreen] = useState<Screen | null>(null);
  const currentScreen = snapshot === null ? null : screenOf(snapshot);
  if (currentScreen !== previousScreen) {
    setPreviousScreen(currentScreen);
    if (
      currentScreen === 'editor' &&
      (previousScreen === 'scan' || previousScreen === 'flip') &&
      snapshot !== null
    ) {
      const transitionReport = snapshot.assembly?.report;
      // Пауза — только когда сборка «состоялась»: проход оборотов завершён или обороты не
      // нужны. Обрыв и «Остановить» ведут в editor без неё — там говорит плашка прерванного.
      if (transitionReport?.backsState === 'completed') {
        setMergeHoldMs(MERGE_PAUSE_MS);
      } else if (transitionReport?.backsDeclined === true) {
        setMergeHoldMs(MERGE_PAUSE_DECLINED_MS);
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
  const startPass = useCallback(() => {
    // Повторный клик до ответа не шлёт второй запуск: тот вернул бы `passRunning`, и плашка
    // отказа повисла бы над удавшимся проходом (находка simplify-ревью сессии 9).
    if (startInFlight.current) {
      return;
    }
    startInFlight.current = true;
    setLaunchFailure(null);
    // Ответ придёт, когда задание закрыто; экран тем временем сменится по снимку. Отказ до
    // первой страницы возвращает на экран-источник — плашка ждёт его здесь, с адресатом.
    window.api.startPass().then(
      (result) => {
        startInFlight.current = false;
        if (!result.ok) {
          // Адресат отказа — экран, на который снимок вернул после отказа: он и есть
          // экран-источник запуска (`setup`, `flip` или `editor` при досканировании).
          const current = store.get();
          const screen = current === null ? 'setup' : screenOf(current);
          const target = screen === 'flip' || screen === 'editor' ? screen : 'setup';
          setLaunchFailure({ error: result.error, target });
        }
      },
      (error: unknown) => {
        startInFlight.current = false;
        console.error('[renderer] запуск прохода не ответил', error);
      },
    );
  }, [store]);

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

  if (snapshot === null || currentScreen === null) {
    // Первый снимок ещё не пришёл: main отвечает за миллисекунды, рисовать нечего.
    return null;
  }

  const screen = currentScreen;
  if (screen === 'incompatible') {
    // Единственный экран: ни уведомлений, ни тостов, ни модалок над ним (S22).
    return (
      <div className="app">
        <IncompatibleScreen />
      </div>
    );
  }

  // `pagesLost` показывается, только когда потерянные страницы правда видны в ленте (S20).
  const anyLost =
    snapshot.session?.passes.some((pass) => pass.pages.some((page) => page.lost)) ?? false;
  const notices = snapshot.notices.filter(
    (notice) => !dismissed.has(notice) && (notice !== 'pagesLost' || anyLost),
  );

  const report = snapshot.assembly?.report;
  // Пауза `merge` — поверх выведенного экрана `editor` (KTD-5).
  const merging = screen === 'editor' && mergeHoldMs !== null && report !== undefined;
  // `mismatch` (KTD-8): первый вход в editor за процесс при неподтверждённом несовпадении —
  // включая вход через «Оставить как есть» и после перезапуска. Прерванный, но не принятый
  // проход оборотов модалку не зовёт: решение ещё за человеком, его ведёт плашка S17.
  const showMismatch =
    screen === 'editor' &&
    !merging &&
    report !== undefined &&
    report.mismatch &&
    (report.backsState === 'completed' || report.backsState === 'accepted') &&
    snapshot.session !== null &&
    mismatchConfirmedFor !== snapshot.session.id;

  return (
    <div className="app">
      {screen !== 'scan' && !merging && <NoticesBar notices={notices} onDismiss={dismissNotice} />}
      {screen === 'setup' && (
        <SetupScreen
          snapshot={snapshot}
          launchFailure={launchFailure?.target === 'setup' ? launchFailure.error : null}
          onStart={startPass}
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
          onStart={startPass}
          onOpenDevice={openDevice}
        />
      )}
      {merging && <MergeScreen report={report} />}
      {screen === 'editor' && !merging && snapshot.session !== null && (
        <EditorScreen
          snapshot={snapshot}
          session={snapshot.session}
          resumeFailure={launchFailure?.target === 'editor' ? launchFailure.error : null}
          onResume={startPass}
          onOpenDevice={openDevice}
          onToast={showToast}
        />
      )}
      {showMismatch && (
        <MismatchModal
          report={report}
          onClose={() => {
            setMismatchConfirmedFor(snapshot.session?.id ?? null);
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
          key={toast.id}
          text={toast.text}
          durationMs={toast.durationMs}
          onExpire={expireToast}
        />
      )}
    </div>
  );
}
