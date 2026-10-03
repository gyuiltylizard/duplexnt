import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { StartupNotice } from '@shared';
import { NoticesBar } from './components/NoticesBar';
import { Toast } from './components/Toast';
import { EditorScreen } from './screens/EditorScreen';
import { IncompatibleScreen } from './screens/IncompatibleScreen';
import { ScanScreen } from './screens/ScanScreen';
import { SetupScreen } from './screens/SetupScreen';
import { createSnapshotStore } from './state/snapshot-store';
import { screenOf } from './state/screen';
import './app.css';

// Каркас интерфейса M1 (U20): экран выводится из снимка, своего состояния сессии у renderer
// нет (KTD-23). Здесь же живёт то, что переживает смену экрана: закрытые уведомления запуска
// и единственный тост — новый гасит предыдущий сменой `key`.

interface ToastState {
  readonly id: number;
  readonly text: string;
}

export function App(): ReactNode {
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

  // Слот тоста один на приложение; наполнять его начнёт подключение сканера (U21).
  const [toast, setToast] = useState<ToastState | null>(null);
  const expireToast = useCallback(() => {
    setToast(null);
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
      {screen === 'setup' && <SetupScreen />}
      {screen === 'scan' && snapshot.pass !== null && (
        <ScanScreen snapshot={snapshot} pass={snapshot.pass} />
      )}
      {screen === 'editor' && snapshot.session !== null && (
        <EditorScreen session={snapshot.session} />
      )}
      {toast !== null && <Toast key={toast.id} text={toast.text} onExpire={expireToast} />}
    </div>
  );
}
