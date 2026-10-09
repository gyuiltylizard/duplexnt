import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssemblyReport } from '@shared';
import { Modal } from '../components/Modal';
import { assemblyOutcome } from '../state/assembly-outcome';

// Модалка `mismatch` (план M2, U9; UI_SPEC раздел 7.5; handoff M2, S5; M3.5, S8): сообщает о
// несовпадении проходов, кнопок действия нет — документ уже собран по совпавшим парам, закрыть —
// нормальный исход. Три исхода Copy: оборотов меньше, оборотов больше, проход принят коротким.
// Пропущенный лист текст не называет (R18): пары считаются от начала, какой именно лист не
// прошёл, приложение не знает — отсылает к «+ Добавить». Показ выводится из снимка в App
// (KTD-8), закрытие — подтверждение на время жизни процесса.

export interface MismatchModalProps {
  readonly report: AssemblyReport;
  readonly onClose: () => void;
}

export function MismatchModal({ report, onClose }: MismatchModalProps): ReactNode {
  const { t } = useTranslation();

  // Исход — общей классификацией (та же, что у статусной строки `merge`): модалка и статус
  // не могут назвать одну сборку по-разному. `frontsOnly`/`ok` сюда не приходят — App
  // показывает модалку только при несовпадении; запасная ветка — «оборотов меньше».
  let title: string;
  let text: string;
  const outcome = assemblyOutcome(report);
  if (outcome === 'accepted') {
    title = t('mismatch.accepted.title', { backs: report.backs, fronts: report.fronts });
    // Принят может быть и длинный прерванный проход: непарных лиц нет, зато есть лишние
    // обороты — текст про листы без пары был бы ложью.
    text =
      report.unpairedSheets.length > 0
        ? t('mismatch.accepted.text')
        : t('mismatch.accepted.textExtra');
  } else if (outcome === 'extra') {
    title = t('mismatch.extra.title', { backs: report.backs, fronts: report.fronts });
    text = t('mismatch.extra.text');
  } else {
    title = t('mismatch.fewer.title', { count: report.fronts, backs: report.backs });
    text = t('mismatch.fewer.text');
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
