import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../components/Modal';
import { useUnmounted } from '../components/useUnmounted';
import { errorText } from '../state/error-text';

// Модалка `newscan` (план M3, U9; handoff M3, S17; UI_SPEC §7.4): кикер и текст по состоянию
// набора — сохранён, есть несохранённое, лента пуста, но удалённые ещё можно вернуть. Удалённые
// пометкой страницы называются числом: закрытие сотрёт и их. Карточка «Сначала сохранить
// текущий» — только при несохранённом и непустой ленте; в режиме раздельных наборов (M3.6,
// R16; handoff S11) её нет — ядро всё равно откажет (`notAssembled`), кикер и текст говорят,
// что документ не собран. Начальный фокус — на «Остаться в документе». Пока идёт закрытие,
// карточки недоступны; успех уводит на `setup` по снимку, отказ оставляет сессию целой. С M4
// (handoff M4, S15) «N стр.» — те, что ушли бы в файл; скрытые пустые обороты названы отдельным
// предложением: закрытие сотрёт и их.

export interface NewScanModalProps {
  /** Страниц, которые ушли бы в файл (без скрытых пустых оборотов). */
  readonly total: number;
  /** Скрытых пустых оборотов — закрытие сотрёт и их (S15 M4). */
  readonly hidden: number;
  /** Удалённых пометкой — их вернул бы Ctrl+Z или «Вернуть». */
  readonly deleted: number;
  readonly saved: boolean;
  /** Режим раздельных наборов: документ не собран, сохранить нельзя (M3.6, R16). */
  readonly unassembled: boolean;
  readonly onSaveFirst: () => void;
  readonly onClose: () => void;
}

type Kind = 'saved' | 'unsaved' | 'empty' | 'unassembled';

const kindOf = (total: number, saved: boolean, unassembled: boolean): Kind => {
  if (total === 0) {
    return 'empty';
  }
  if (unassembled) {
    return 'unassembled';
  }
  return saved ? 'saved' : 'unsaved';
};

export function NewScanModal({
  total,
  hidden,
  deleted,
  saved,
  unassembled,
  onSaveFirst,
  onClose,
}: NewScanModalProps): ReactNode {
  const { t } = useTranslation();
  const [closing, setClosing] = useState(false);
  /** Текст отказа: ошибка ядра или «мост не ответил». */
  const [failure, setFailure] = useState<string | null>(null);
  const unmounted = useUnmounted();

  const kind = kindOf(total, saved, unassembled);

  const confirm = (): void => {
    if (closing) {
      return;
    }
    setClosing(true);
    setFailure(null);
    window.api.closeSession().then(
      (result) => {
        if (unmounted.current) {
          return;
        }
        if (result.ok) {
          // Снимок без сессии сам уведёт на `setup`; закрытие — чтобы не ждать его.
          onClose();
          return;
        }
        setClosing(false);
        setFailure(errorText(t, result.error));
      },
      (error: unknown) => {
        console.error('[renderer] закрытие сессии не ответило', error);
        // Удаляет ли ядро страницы, неизвестно — человек должен это узнать, а не гадать.
        if (!unmounted.current) {
          setClosing(false);
          setFailure(t('newScan.noResponse'));
        }
      },
    );
  };

  // Лента пуста: текст про удалённые, если они есть, — одни скрытые (S7 M4) про Ctrl+Z не
  // говорят; иначе — состояние набора и отдельно удалённые. Скрытые — всегда последним.
  const parts: (string | null)[] =
    kind === 'empty'
      ? [deleted > 0 ? t('newScan.text.empty', { count: deleted }) : null]
      : [
          t(`newScan.text.${kind}`, { count: total }),
          deleted > 0 ? t('newScan.text.deleted', { count: deleted }) : null,
        ];
  parts.push(hidden > 0 ? t('newScan.text.blankHidden', { count: hidden }) : null);
  const text = parts.filter((part) => part !== null).join(' ');

  let status: ReactNode;
  if (closing) {
    status = (
      <p className="modal__status" role="status" aria-live="polite">
        {t('newScan.confirming')}
      </p>
    );
  } else if (failure !== null) {
    status = (
      <p className="modal__status modal__status--danger" role="alert">
        {failure}
      </p>
    );
  } else {
    status = <p className="modal__status" />;
  }

  return (
    <Modal
      labelledBy="newscan-title"
      describedBy="newscan-text"
      small
      busy={closing}
      className="newscan-modal"
      onEscape={closing ? undefined : onClose}
    >
      <header className="modal__header">
        <div className="modal__kicker">
          <span
            className={kind === 'saved' ? 'dot dot--accent' : 'dot dot--warning'}
            aria-hidden="true"
          />
          <span className={kind === 'saved' ? 'kicker kicker--accent' : 'kicker kicker--warning'}>
            {t(`newScan.kicker.${kind}`)}
          </span>
        </div>
        <h2 id="newscan-title" className="modal__title">
          {t('newScan.title')}
        </h2>
        <p id="newscan-text" className="modal__subtitle">
          {text}
        </p>
      </header>
      <div className="modal__body choices">
        <button type="button" className="choice" disabled={closing} onClick={confirm}>
          <span className="choice__sheet" aria-hidden="true" />
          <span className="choice__text">
            <span className="choice__title">{t('newScan.fresh')}</span>
            <span className="choice__note">
              {kind === 'saved'
                ? t('newScan.freshNote.saved')
                : t('newScan.freshNote.unsaved', { count: total })}
            </span>
          </span>
          <span className="choice__arrow" aria-hidden="true">
            →
          </span>
        </button>
        {kind === 'unsaved' && (
          <button type="button" className="choice" disabled={closing} onClick={onSaveFirst}>
            <span className="choice__sheet choice__sheet--accent" aria-hidden="true" />
            <span className="choice__text">
              <span className="choice__title">{t('newScan.saveFirst')}</span>
              <span className="choice__note">{t('newScan.saveFirstNote')}</span>
            </span>
            <span className="choice__arrow" aria-hidden="true">
              →
            </span>
          </button>
        )}
      </div>
      <footer className="modal__footer">
        {status}
        <button
          type="button"
          className="btn btn--ghost"
          autoFocus
          disabled={closing}
          onClick={onClose}
        >
          {t('newScan.stay')}
        </button>
      </footer>
    </Modal>
  );
}
