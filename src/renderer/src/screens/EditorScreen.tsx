import { useTranslation } from 'react-i18next';
import type { SessionSnapshot } from '@shared';
import type { ReactNode } from 'react';
import './editor-screen.css';

// Экран `editor`, каркасная версия U20: счётчик страниц. Полный каркас — тулбар, лента по
// проходам, превью, плашка прерванного прохода — юнит U24 (сессия 8).

export function EditorScreen({ session }: { readonly session: SessionSnapshot }): ReactNode {
  const { t } = useTranslation();
  const pages = session.passes.reduce((total, pass) => total + pass.pages.length, 0);
  return (
    <main className="editor-screen">
      <div className="editor-screen__count">{t('editor.count', { count: pages })}</div>
    </main>
  );
}
