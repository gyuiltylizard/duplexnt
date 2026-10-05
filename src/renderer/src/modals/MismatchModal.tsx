import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssemblyReport } from '@shared';
import type { TFunction } from 'i18next';
import { Modal } from '../components/Modal';

// Модалка `mismatch` (план M2, U9; UI_SPEC раздел 7.5; handoff M2, S5): сообщает о несовпадении
// проходов, кнопок действия нет — документ уже собран по совпавшим парам, закрыть — нормальный
// исход. Три исхода Copy: оборотов меньше, оборотов больше, проход принят коротким. Показ
// выводится из снимка в App (KTD-8), закрытие — подтверждение на время жизни процесса.

export interface MismatchModalProps {
  readonly report: AssemblyReport;
  readonly onClose: () => void;
}

/**
 * Листы без оборота текстом: «лист №1», «листы №1–5», «листы №1, 4» — подряд идущие номера
 * сворачиваются в диапазон. Вход — отсортированный список из отчёта сборки.
 */
export function sheetsLabel(t: TFunction, sheets: readonly number[]): string {
  const parts: string[] = [];
  let start = 0;
  for (let index = 1; index <= sheets.length; index += 1) {
    const previous = sheets[index - 1];
    if (index < sheets.length && previous !== undefined && sheets[index] === previous + 1) {
      continue;
    }
    const from = sheets[start];
    const to = sheets[index - 1];
    if (from === undefined || to === undefined) {
      break;
    }
    parts.push(from === to ? String(from) : to === from + 1 ? `${from}, ${to}` : `${from}–${to}`);
    start = index;
  }
  const list = parts.join(', ');
  return sheets.length === 1 ? t('mismatch.sheetOne', { list }) : t('mismatch.sheetMany', { list });
}

export function MismatchModal({ report, onClose }: MismatchModalProps): ReactNode {
  const { t } = useTranslation();

  // Исход — по отчёту: принятый коротким проход важнее арифметики, дальше — куда разошлись.
  let title: string;
  let text: string;
  if (report.backsState === 'accepted') {
    title = t('mismatch.accepted.title', { backs: report.backs, fronts: report.fronts });
    // Принят может быть и длинный прерванный проход: непарных лиц нет, зато есть лишние
    // обороты — перечень пустых листов в тексте был бы битым.
    text =
      report.unpairedSheets.length > 0
        ? t('mismatch.accepted.text', {
            count: report.unpairedSheets.length,
            sheets: sheetsLabel(t, report.unpairedSheets),
          })
        : t('mismatch.accepted.textExtra');
  } else if (report.extraBacks > 0) {
    title = t('mismatch.extra.title', { backs: report.backs, fronts: report.fronts });
    text = t('mismatch.extra.text');
  } else {
    title = t('mismatch.fewer.title', { count: report.fronts, backs: report.backs });
    text = t('mismatch.fewer.text', {
      count: report.unpairedSheets.length,
      sheets: sheetsLabel(t, report.unpairedSheets),
    });
  }

  return (
    <Modal labelledBy="mismatch-title" describedBy="mismatch-text" small className="mismatch-modal">
      <header className="modal__header">
        <div className="modal__kicker">
          <span className="dot dot--warning" aria-hidden="true" />
          <span className="kicker kicker--warning">{t('mismatch.kicker')}</span>
        </div>
        <h2 id="mismatch-title" className="modal__title">
          {title}
        </h2>
        <p id="mismatch-text" className="modal__subtitle">
          {text}
        </p>
      </header>
      <footer className="modal__footer modal__footer--end">
        <button type="button" className="btn btn--primary btn--small" autoFocus onClick={onClose}>
          {t('mismatch.close')}
        </button>
      </footer>
    </Modal>
  );
}
