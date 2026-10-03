import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

// Экран `setup`, каркасная версия U20: одна колонка с кикером, заголовком и лидом (S1).
// Строка устройства, параметры из capabilities и запуск прохода — юнит U22.

export function SetupScreen(): ReactNode {
  const { t } = useTranslation();
  return (
    <main className="setup-screen">
      <section className="setup-screen__column">
        <header className="setup-screen__intro">
          <div className="kicker">{t('setup.kicker')}</div>
          <h1 className="setup-screen__title">{t('setup.title')}</h1>
          <p className="setup-screen__lead">{t('setup.lead')}</p>
        </header>
      </section>
    </main>
  );
}
