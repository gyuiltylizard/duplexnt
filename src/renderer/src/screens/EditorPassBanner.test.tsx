import { EMPTY_EDITS, type ScannerInfo, type SessionSnapshot } from '@shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { makeSnapshot, pages, READY } from '../app-fixture';
import { EditorPassBanner } from './EditorPassBanner';

// Плашка прерванного прохода: вариант «заменено» после подтверждённой смены устройства
// (B-29, KTD-10; handoff scanner-change) против прежнего текста со ссылкой.

const PASS_SCANNER: ScannerInfo = {
  name: 'ScanPro 100',
  scheme: 'https',
  host: '192.0.2.10',
  port: 443,
};

function session(scanner: ScannerInfo | null, paramsKnown = true): SessionSnapshot {
  return {
    blankMode: 'keep',
    straighten: 'off',
    id: 'session.x',
    backsDeclined: false,
    saved: false,
    edits: EMPTY_EDITS,
    assembled: null,
    passes: [
      {
        number: 1,
        state: 'interrupted',
        paramsKnown,
        scanner,
        kind: 'fronts',
        after: null,
        pair: null,
        backsDecision: null,
        rotate180: false,
        pages: pages(2),
      },
    ],
  };
}

function renderBanner(passScanner: ScannerInfo | null, canResume: boolean) {
  const current = session(passScanner);
  const snapshot = makeSnapshot({ scanner: READY, canResume, canAccept: true, session: current });
  const onOpenDevice = vi.fn();
  render(
    <EditorPassBanner
      snapshot={snapshot}
      session={current}
      resumeFailure={null}
      onResume={vi.fn()}
      onOpenDevice={onOpenDevice}
      onNewScan={vi.fn()}
    />,
  );
  return { onOpenDevice };
}

afterEach(() => {
  cleanup();
});

describe('EditorPassBanner — заменённый проход (B-29)', () => {
  it('сканер готов на хосте сканера прохода, досканировать нельзя — текст без ссылки, фокус на «Оставить как есть»', () => {
    renderBanner(PASS_SCANNER, false);

    const text = screen.getByRole('region').textContent;
    expect(text).toContain('по этому адресу больше не отвечает');
    expect(screen.queryByRole('button', { name: 'подключите заново' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Досканировать остаток' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Оставить как есть' }));
  });

  it('другой сканер на другом хосте — прежний текст со ссылкой на сканер прохода', () => {
    const { onOpenDevice } = renderBanner({ ...PASS_SCANNER, host: '192.0.2.20' }, false);

    const text = screen.getByRole('region').textContent;
    expect(text).toContain(
      'Досканировать можно только на том сканере, на котором начат проход: ScanPro 100',
    );
    screen.getByRole('button', { name: 'подключите заново' }).click();
    expect(onOpenDevice).toHaveBeenCalledExactlyOnceWith('192.0.2.20:443');
  });

  it('досканировать можно — обычный текст и кнопка досканирования, ссылки нет', () => {
    renderBanner(PASS_SCANNER, true);

    expect(screen.getByRole('button', { name: 'Досканировать остаток' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'подключите заново' })).toBeNull();
    expect(screen.getByRole('region').textContent).toContain('положите в лоток оставшиеся листы');
  });
});
