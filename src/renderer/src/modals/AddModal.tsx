import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AssembledDocument,
  AssembledPage,
  AssemblyMode,
  ScannerState,
  SetsLayout,
} from '@shared';
import type { TFunction } from 'i18next';
import { Modal } from '../components/Modal';
import { rovingRadioKeyDown, Segments } from '../components/Segments';
import { whatOf } from '../state/page-text';
import { paramsLine } from '../state/params-line';
import { scannerLabel } from '../state/scanner-address';
import './add-modal.css';

// Модалка `add` (план M3.5, U6; handoff M3.5, S2; UI_SPEC §7): что сканируем — две
// карточки-радио, куда вставить — два крупных сегмента, строка сканера, сводка, «Отмена» /
// «Начать скан». Карточки отличаются только текстом (KTD-5: в ядро уходит одно намерение, число
// листов приложение не знает); место даёт якорь (KTD-8) — его выбирает экран из видимой ленты и
// называет сводка. «Начать скан» всегда закрывает модалку (KTD-6): экран уйдёт на `scan` раньше,
// чем ядро начнёт задание, а отказ придёт тостом. Начальный фокус — «Отмена»: запуск — действие
// с бумагой в лотке, случайный Enter его начинать не должен. В режиме раздельных наборов (M3.6,
// KTD11; handoff S10) «В конец документа» становится «В конец набора»: якорь — последняя видимая
// страница группы текущей, сводка называет группу.

/** Страница-якорь из видимой ленты: ключ, номер в ленте и как её назвать в сводке. */
export interface AddAnchor {
  readonly key: string;
  readonly page: number;
  /**
   * Текущая — «лицо листа 4» (теми же словами, что ДЕТАЛИ); конец документа — его имя; конец
   * набора — группа («лиц» / «оборотов»).
   */
  readonly label: string;
}

/** Куда ведёт второй сегмент места: в конец документа текущей или в конец её набора. */
export type AddEndKind = 'document' | 'set';

export interface AddAnchors {
  /** Текущая страница; `null` — лента пуста («После текущей страницы» недоступна). */
  readonly current: AddAnchor | null;
  /** Конец документа или набора текущей: его последняя видимая страница; `null` — лента пуста. */
  readonly end: AddAnchor | null;
  readonly endKind: AddEndKind;
}

/**
 * Якоря из видимой ленты (KTD-8): текущая — та, что в превью; конец документа — последняя
 * видимая страница документа текущей, имя — как в тулбаре; в режиме наборов (`sets`) — конец
 * группы текущей (KTD11). Пустая лента — оба `null`.
 */
export function anchorsOf(
  t: TFunction,
  input: {
    readonly entry: AssembledPage | undefined;
    /** Позиция текущей в ленте, с нуля. */
    readonly index: number;
    readonly document: AssembledDocument | undefined;
    readonly documentName: string;
    readonly visible: readonly string[];
    readonly mode: AssemblyMode;
    /** Группы ленты в режиме наборов; `null` — пары или собрано. */
    readonly sets: SetsLayout | null;
    /**
     * Ключ, после которого встанет набор при «После текущей» (M4, R12): последний скрытый
     * оборот хвоста текущей; по умолчанию — сама текущая.
     */
    readonly after?: string | undefined;
    /** Номер страницы в показанной ленте, с единицы (M4, R11); по умолчанию — позиция в `visible`. */
    readonly numberOf?: (key: string) => number;
  },
): AddAnchors {
  const { entry, index, document, sets } = input;
  const numberOf = input.numberOf ?? ((key: string): number => input.visible.indexOf(key) + 1);
  const current =
    entry === undefined
      ? null
      : {
          key: input.after ?? entry.key,
          // Номер — по показанной ленте, как у миниатюр (M4, R11); `index` — позиция в полной.
          page: numberOf(entry.key),
          label: whatOf(t, entry, input.mode),
        };
  if (sets !== null) {
    const inFronts = index < sets.divider;
    const end = inFronts ? sets.divider - 1 : input.visible.length - 1;
    const endKey = input.visible[end];
    return {
      current,
      end:
        endKey === undefined
          ? null
          : {
              key: endKey,
              page: numberOf(endKey),
              label: t(inFronts ? 'add.summary.groupFronts' : 'add.summary.groupBacks'),
            },
      endKind: 'set',
    };
  }
  const end = document === undefined ? -1 : document.start + document.count - 1;
  const endKey = input.visible[end];
  return {
    current,
    end:
      endKey === undefined
        ? null
        : { key: endKey, page: numberOf(endKey), label: input.documentName },
    endKind: 'document',
  };
}

export interface AddModalProps extends AddAnchors {
  readonly scanner: ScannerState;
  /** «Начать скан»: якорь выбран, модалка уже закрыта. */
  readonly onStart: (after: string | null) => void;
  readonly onClose: () => void;
}

type Kind = 'sheets' | 'single';
type Place = 'end' | 'after';

const KINDS: readonly Kind[] = ['sheets', 'single'];
const PLACES: readonly Place[] = ['end', 'after'];

export function AddModal({
  scanner,
  current,
  end,
  endKind,
  onStart,
  onClose,
}: AddModalProps): ReactNode {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Kind>('sheets');
  // Место по умолчанию — после текущей, если она есть; пустая лента — только «в конец».
  const [place, setPlace] = useState<Place>(current === null ? 'end' : 'after');

  const ready = scanner.kind === 'ready';
  let placeText: string;
  if (place === 'after' && current !== null) {
    placeText = t('add.summary.after', { page: current.page, what: current.label });
  } else if (end === null) {
    placeText = t('add.summary.endEmpty');
  } else if (endKind === 'set') {
    placeText = t('add.summary.setEnd', { group: end.label, page: end.page });
  } else {
    placeText = t('add.summary.end', { name: end.label, page: end.page });
  }
  const summary = t('add.summary.join', { kind: t(`add.summary.${kind}`), place: placeText });

  const start = (): void => {
    // Якорь — в момент нажатия (KTD-8): текущая, последняя страница документа или `null`.
    const after = place === 'after' && current !== null ? current.key : (end?.key ?? null);
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
          {/* Карточка-радио — рецепт дизайн-системы, впервые в коде; клавиатура общая с
              сегментами (одна остановка Tab, стрелки). */}
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
                  rovingRadioKeyDown(event, KINDS, kind, () => true, setKind);
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
          <Segments
            labelledBy="add-place-kicker"
            values={PLACES}
            selected={place}
            format={(value) =>
              value === 'end' && endKind === 'set' ? t('add.place.setEnd') : t(`add.place.${value}`)
            }
            disabledReason={(value) =>
              value === 'after' && current === null ? t('add.place.afterNone') : undefined
            }
            roving
            large
            onSelect={setPlace}
          />
        </section>

        {/* Строка сканера — как строка устройства `setup`, но без действий: подключить его
            можно только из `setup`, и строка об этом говорит. */}
        {scanner.kind === 'ready' ? (
          <p className="add-modal__scanner">
            <span className="dot dot--ready" aria-hidden="true" />
            <span className="add-modal__scanner-name">{scannerLabel(scanner.scanner)}</span>
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
