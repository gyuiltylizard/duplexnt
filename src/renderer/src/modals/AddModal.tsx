import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ScannerState } from '@shared';
import { Modal } from '../components/Modal';
import { paramsLine } from '../state/params-line';
import './add-modal.css';

// Модалка `add` (план M3.5, U6; handoff M3.5, S2; UI_SPEC §7): что сканируем — две
// карточки-радио, куда вставить — два крупных сегмента, строка сканера, сводка, «Отмена» /
// «Начать скан». Карточки отличаются только текстом (KTD-5: в ядро уходит одно намерение, число
// листов приложение не знает); место даёт якорь (KTD-8) — его выбирает экран из видимой ленты и
// называет сводка. «Начать скан» всегда закрывает модалку (KTD-6): экран уйдёт на `scan` раньше,
// чем ядро начнёт задание, а отказ придёт тостом. Начальный фокус — «Отмена»: запуск — действие
// с бумагой в лотке, случайный Enter его начинать не должен.

/** Страница-якорь из видимой ленты: ключ и как её назвать в сводке. */
export interface AddAnchor {
  readonly key: string;
  /** Номер в ленте, с единицы. */
  readonly page: number;
  /** «лицо листа 4» / «добавленный набор 1» — теми же словами, что заголовок ДЕТАЛЕЙ. */
  readonly what: string;
}

/** Конец документа текущей страницы: последняя видимая страница и имя документа. */
export interface AddDocumentEnd {
  readonly key: string;
  readonly page: number;
  readonly name: string;
}

export interface AddModalProps {
  readonly scanner: ScannerState;
  /** Текущая страница; `null` — лента пуста («После текущей страницы» недоступна). */
  readonly current: AddAnchor | null;
  /** Конец документа текущей; `null` — лента пуста (набор — в конец ленты). */
  readonly documentEnd: AddDocumentEnd | null;
  /** «Начать скан»: якорь выбран, модалка уже закрыта. */
  readonly onStart: (after: string | null) => void;
  readonly onClose: () => void;
}

type Kind = 'sheets' | 'single';
type Place = 'end' | 'after';

const KINDS: readonly Kind[] = ['sheets', 'single'];
const PLACES: readonly Place[] = ['end', 'after'];

/**
 * Группа радио с одной остановкой Tab (handoff, «Клавиатура»): в обходе — выбранный элемент,
 * стрелки переводят выбор и фокус на соседний доступный; недоступный пропускается.
 */
function radioKeyDown<T extends string>(
  event: KeyboardEvent<HTMLElement>,
  values: readonly T[],
  selected: T,
  enabled: (value: T) => boolean,
  onSelect: (value: T) => void,
): void {
  const step =
    event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : 0;
  if (step === 0) {
    return;
  }
  event.preventDefault();
  const start = values.indexOf(selected);
  const size = values.length;
  for (let offset = 1; offset < size; offset += 1) {
    const candidate = values[(((start + step * offset) % size) + size) % size];
    if (candidate !== undefined && enabled(candidate)) {
      onSelect(candidate);
      const group = event.currentTarget.closest('[role="radiogroup"]');
      group?.querySelector<HTMLElement>(`[data-value="${candidate}"]`)?.focus();
      return;
    }
  }
}

export function AddModal({
  scanner,
  current,
  documentEnd,
  onStart,
  onClose,
}: AddModalProps): ReactNode {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>('sheets');
  // Место по умолчанию — после текущей, если она есть; пустая лента — только «в конец».
  const [place, setPlace] = useState<Place>(current === null ? 'end' : 'after');
  const placeEnabled = (value: Place): boolean => value === 'end' || current !== null;

  const ready = scanner.kind === 'ready';
  const placeText =
    place === 'after' && current !== null
      ? t('add.summary.after', { page: current.page, what: current.what })
      : documentEnd === null
        ? t('add.summary.endEmpty')
        : t('add.summary.end', { name: documentEnd.name, page: documentEnd.page });
  const summary = t('add.summary.join', { kind: t(`add.summary.${kind}`), place: placeText });

  const start = (): void => {
    // Якорь — в момент нажатия (KTD-8): текущая, последняя страница документа или `null`.
    const after = place === 'after' && current !== null ? current.key : (documentEnd?.key ?? null);
    onClose();
    onStart(after);
  };

  return (
    <Modal labelledBy="add-title" describedBy="add-text" className="add-modal">
      <header className="modal__header">
        <h2 id="add-title" className="modal__title">
          {t('add.title')}
        </h2>
        <p id="add-text" className="modal__subtitle">
          {t('add.text')}
        </p>
      </header>

      <div className="modal__body add-modal__body">
        <section className="add-modal__section" aria-labelledby="add-kind-kicker">
          <h3 id="add-kind-kicker" className="kicker kicker--hint">
            {t('add.kind.label')}
          </h3>
          <div className="radio-cards" role="radiogroup" aria-labelledby="add-kind-kicker">
            {KINDS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={value === kind}
                tabIndex={value === kind ? 0 : -1}
                data-value={value}
                className={value === kind ? 'radio-card radio-card--selected' : 'radio-card'}
                onClick={() => {
                  setKind(value);
                }}
                onKeyDown={(event) => {
                  radioKeyDown(event, KINDS, kind, () => true, setKind);
                }}
              >
                <span className="radio-card__dot" aria-hidden="true" />
                <span className="radio-card__text">
                  <span className="radio-card__title">{t(`add.kind.${value}`)}</span>
                  <span className="radio-card__note">{t(`add.kind.${value}Note`)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="add-modal__section" aria-labelledby="add-place-kicker">
          <h3 id="add-place-kicker" className="kicker kicker--hint">
            {t('add.place.label')}
          </h3>
          <div
            className="segments segments--wide"
            role="radiogroup"
            aria-labelledby="add-place-kicker"
          >
            {PLACES.map((value) => {
              const enabled = placeEnabled(value);
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={value === place}
                  aria-disabled={enabled ? undefined : true}
                  tabIndex={value === place ? 0 : -1}
                  data-value={value}
                  title={enabled ? undefined : t('add.place.afterNone')}
                  className={
                    value === place
                      ? 'segment segment--large segment--selected'
                      : 'segment segment--large'
                  }
                  onClick={() => {
                    if (enabled) {
                      setPlace(value);
                    }
                  }}
                  onKeyDown={(event) => {
                    radioKeyDown(event, PLACES, place, placeEnabled, setPlace);
                  }}
                >
                  {t(`add.place.${value}`)}
                </button>
              );
            })}
          </div>
        </section>

        {/* Строка сканера — как строка устройства `setup`, но без действий: подключить его
            можно только из `setup`, и строка об этом говорит. */}
        {ready ? (
          <p className="add-modal__scanner">
            <span className="dot dot--ready" aria-hidden="true" />
            <span className="add-modal__scanner-name">
              {scanner.scanner.name ?? scanner.scanner.host}
            </span>
            <span className="add-modal__scanner-status">
              {t('add.scanner.ready', { params: paramsLine(t, scanner.params) })}
            </span>
          </p>
        ) : (
          <p className="add-modal__scanner add-modal__scanner--none">
            <span className="dot dot--faint" aria-hidden="true" />
            <span className="add-modal__scanner-status">{t('add.scanner.none')}</span>
          </p>
        )}
      </div>

      <footer className="modal__footer">
        <p className="modal__status add-modal__summary">{summary}</p>
        <button type="button" className="btn btn--ghost" autoFocus onClick={onClose}>
          {t('add.cancel')}
        </button>
        <button
          type="button"
          className="btn btn--primary btn--small"
          disabled={!ready}
          onClick={start}
        >
          {t('add.start')}
        </button>
      </footer>
    </Modal>
  );
}
