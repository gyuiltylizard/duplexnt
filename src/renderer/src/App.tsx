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
  const [store] = useState(() => createSnapshotStore(window.api));
  useEffect(
    () => () => {
      store.dispose();
    },
    [store],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.get);

  const [dismissed, setDismissed] = useState<ReadonlySet<StartupNotice>>(new Set());
  const dismissNotice = useCallback((notice: StartupNotice) => {
    setDismissed((previous) => new Set(previous).add(notice));
  }, []);

  const toastId = useRef(0);
  const [toast, setToast] = useState<ToastState | null>(null);
  const expireToast = useCallback(() => {
    setToast(null);
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
      toastId.current += 1;
      setToast({ id: toastId.current, text: t('toast.connected', { name: label }) });
    },
    [t],
  );

  const startPass = useCallback(() => {
    setLaunchFailure(null);
    // Ответ придёт, когда задание закрыто; экран тем временем сменится по снимку. Отказ до
    // первой страницы возвращает на `setup` — плашка ждёт его здесь.
    window.api.startPass().then(
      (result) => {
        if (!result.ok) {
          setLaunchFailure(result.error);
        }
      },
      (error: unknown) => {
        console.error('[renderer] запуск прохода не ответил', error);
      },
    );
  }, []);

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
        <ScanScreen snapshot={snapshot} pass={snapshot.pass} />
      )}
      {screen === 'editor' && snapshot.session !== null && (
        <EditorScreen session={snapshot.session} />
      )}
      {deviceModal !== null && screen === 'setup' && (
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
