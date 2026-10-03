import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DomainError, StartupNotice } from '@shared';
import { NoticesBar } from './components/NoticesBar';
import { Toast } from './components/Toast';
import { DeviceModal } from './modals/DeviceModal';
import { EditorScreen } from './screens/EditorScreen';
import { IncompatibleScreen } from './screens/IncompatibleScreen';
import { ScanScreen } from './screens/ScanScreen';
import { SetupScreen } from './screens/SetupScreen';
import { createSnapshotStore } from './state/snapshot-store';
import { screenOf } from './state/screen';
import './app.css';

// Каркас интерфейса M1 (U20): экран выводится из снимка, своего состояния сессии у renderer
// нет (KTD-23). Здесь живёт то, что переживает смену экрана: закрытые уведомления запуска,
// единственный тост (новый гасит предыдущий сменой `key`), модалка `device` и отказ последнего
// запуска прохода — экран на время запуска уходит на `scan` и возвращается (S6).

interface ToastState {
  readonly id: number;
  readonly text: string;
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
  const showToast = useCallback((text: string) => {
    setToast((previous) => ({ id: (previous?.id ?? 0) + 1, text }));
  }, []);

  const [deviceModal, setDeviceModal] = useState<{ readonly initialHost?: string } | null>(null);
  const [launchFailure, setLaunchFailure] = useState<DomainError | null>(null);

  const openDevice = useCallback((initialHost?: string) => {
    // Открытие модалки снимает плашку отказа запуска (S6).
    setLaunchFailure(null);
    setDeviceModal(initialHost === undefined ? {} : { initialHost });
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
    // первой страницы возвращает на `setup` — плашка ждёт его здесь.
    window.api.startPass().then(
      (result) => {
        startInFlight.current = false;
        if (!result.ok) {
          setLaunchFailure(result.error);
        }
      },
      (error: unknown) => {
        startInFlight.current = false;
        console.error('[renderer] запуск прохода не ответил', error);
      },
    );
  }, []);

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

  if (snapshot === null) {
    // Первый снимок ещё не пришёл: main отвечает за миллисекунды, рисовать нечего.
    return null;
  }

  const screen = screenOf(snapshot);
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

  return (
    <div className="app">
      {screen !== 'scan' && <NoticesBar notices={notices} onDismiss={dismissNotice} />}
      {screen === 'setup' && (
        <SetupScreen
          snapshot={snapshot}
          launchFailure={launchFailure}
          onStart={startPass}
          onOpenDevice={openDevice}
        />
      )}
      {screen === 'scan' && snapshot.pass !== null && (
        <ScanScreen snapshot={snapshot} pass={snapshot.pass} onStop={stopPass} />
      )}
      {screen === 'editor' && snapshot.session !== null && (
        <EditorScreen
          snapshot={snapshot}
          session={snapshot.session}
          resumeFailure={launchFailure}
          onResume={startPass}
          onOpenDevice={openDevice}
        />
      )}
      {/* `device` открывается и из `editor` — ссылка «подключите заново» в плашке S17. */}
      {deviceModal !== null && (screen === 'setup' || screen === 'editor') && (
        <DeviceModal
          initialHost={deviceModal.initialHost}
          onClose={closeDevice}
          onConnected={deviceConnected}
        />
      )}
      {toast !== null && <Toast key={toast.id} text={toast.text} onExpire={expireToast} />}
    </div>
  );
}
