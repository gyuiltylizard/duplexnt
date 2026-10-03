import { useTranslation } from 'react-i18next';
import type { PassProgress, Snapshot } from '@shared';
import type { ReactNode } from 'react';

// Экран `scan`, каркасная версия U20: тег прохода и счётчик (S12). Полный экран — иллюстрация
// подачи, ожидание занятости, лента последних страниц, «Остановить» — юнит U23 (сессия 8).

function passNumber(snapshot: Snapshot): number {
  const passes = snapshot.session?.passes ?? [];
  const running = passes.find((pass) => pass.state === 'running') ?? passes[passes.length - 1];
  return running?.number ?? 1;
}

function counted(snapshot: Snapshot, pass: PassProgress): number {
  if (!pass.resumed) {
    return pass.pages;
  }
  // При досканировании счётчик продолжает нумерацию прохода (S14): прежние страницы плюс новые.
  const passes = snapshot.session?.passes ?? [];
  const resumedPass = passes.find((candidate) => candidate.state === 'running');
  return resumedPass?.pages.length ?? pass.pages;
}

export function ScanScreen({
  snapshot,
  pass,
}: {
  readonly snapshot: Snapshot;
  readonly pass: PassProgress;
}): ReactNode {
  const { t } = useTranslation();
  const counter =
    pass.phase === 'starting' && pass.pages === 0
      ? t('scan.starting')
      : t('scan.counter', { count: counted(snapshot, pass) });

  return (
    <main className="scan-screen">
      <div className="scan-screen__tag">{t('scan.tag', { number: passNumber(snapshot) })}</div>
      <div className="scan-screen__counter" role="status" aria-live="polite" aria-atomic="true">
        {counter}
      </div>
    </main>
  );
}
