import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AddedPassIntent,
  AssembledDocument,
  AssembledPage,
  AssemblyMode,
  PassKind,
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
// «Начать скан». С M4.5 (R1–R4; handoff M4.5, S1–S2) карточки — сценарии: «Двустороннее
// сканирование» (пара проходов с разворотом, намерение `addedFronts`) и «Одностороннее
// сканирование» (`added`); число листов приложение не знает. В режиме раздельных наборов (R3)
// двусторонняя выключена с причиной и не выбирается ни кликом, ни стрелками. Место даёт якорь
// (KTD-8) — его выбирает экран из видимой ленты и называет сводка. «Начать скан» всегда закрывает
// модалку (KTD-6): экран уйдёт на `scan` раньше, чем ядро начнёт задание, а отказ придёт тостом.
// Начальный фокус — «Отмена»: запуск — действие с бумагой в лотке, случайный Enter его начинать
// не должен. В режиме раздельных наборов (M3.6, KTD11; handoff S10) «В конец документа»
// становится «В конец набора»: якорь — последняя видимая страница группы текущей, сводка называет
// группу.

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
    /** Роль прохода текущей — слова страницы пары (M4.5, R13); по умолчанию неизвестна. */
    readonly origin?: PassKind | null;
    /**
     * Ключ, после которого встанет набор при «После текущей» (M4, R12; B-13): последняя
     * страница листа текущей — её склеенный оборот; по умолчанию — сама текущая.
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
          label: whatOf(t, entry, input.mode, input.origin ?? null),
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
  /** Режим сборки (M4.5, R3): в режиме раздельных наборов двустороннее недоступно. */
  readonly mode: AssemblyMode;
  /** «Начать скан»: сценарий и якорь выбраны, модалка уже закрыта. */
  readonly onStart: (kind: AddedPassIntent['kind'], after: string | null) => void;
  readonly onClose: () => void;
}

type Kind = 'twoSided' | 'oneSided';
type Place = 'end' | 'after';

const KINDS: readonly Kind[] = ['twoSided', 'oneSided'];
const PLACES: readonly Place[] = ['end', 'after'];

/** Намерение запуска по карточке: пара проходов или один (M4.5, KTD2). */
const INTENT_OF: Readonly<Record<Kind, AddedPassIntent['kind']>> = {
  twoSided: 'addedFronts',
  oneSided: 'added',
};

const TWO_SIDED_REASON_ID = 'add-kind-two-sided-reason';

export function AddModal({
  scanner,
  mode,
  current,
  end,
  endKind,
  onStart,
  onClose,
}: AddModalProps): ReactNode {
  const { t } = useTranslation();
  // Двусторонняя — по умолчанию, если доступна (R1); в режиме наборов — односторонняя (R3).
  const twoSidedDisabled = mode === 'sets';
  const enabled = (value: Kind): boolean => value !== 'twoSided' || !twoSidedDisabled;
  const [kind, setKind] = useState<Kind>(twoSidedDisabled ? 'oneSided' : 'twoSided');
  // Место по умолчанию — «В конец документа» (решение автора на приёмке M4.5, 2026-10-24).
  const [place, setPlace] = useState<Place>('end');

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
    onStart(INTENT_OF[kind], after);
  };

  return (
    <Modal labelledBy="add-title" describedBy="add-text" className="add-modal" onEscape={onClose}>
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
          {/* Карточка-радио — рецепт дизайн-системы; клавиатура общая с сегментами (одна
              остановка Tab, стрелки). Выключенная карточка (S2 M4.5): `aria-disabled`, причина
              вместо заметки, вне обхода и кольца стрелок. */}
          <div className="radio-cards" role="radiogroup" aria-labelledby="add-kind-kicker">
            {KINDS.map((value) => {
              const disabled = !enabled(value);
              const classes = ['radio-card'];
              if (value === kind) {
                classes.push('radio-card--selected');
              }
              if (disabled) {
                classes.push('radio-card--disabled');
              }
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={value === kind}
                  aria-disabled={disabled || undefined}
                  aria-describedby={disabled ? TWO_SIDED_REASON_ID : undefined}
                  tabIndex={value === kind ? 0 : -1}
                  data-value={value}
                  className={classes.join(' ')}
                  onClick={() => {
                    if (!disabled) {
                      setKind(value);
                    }
                  }}
                  onKeyDown={(event) => {
                    rovingRadioKeyDown(event, KINDS, kind, enabled, setKind);
                  }}
                >
                  <span className="radio-card__dot" aria-hidden="true" />
                  <span className="radio-card__text">
                    <span className="radio-card__title">{t(`add.kind.${value}`)}</span>
                    {disabled ? (
                      <span className="radio-card__note" id={TWO_SIDED_REASON_ID}>
                        {t('add.kind.twoSidedDisabled')}
                      </span>
                    ) : (
                      <span className="radio-card__note">{t(`add.kind.${value}Note`)}</span>
                    )}
                  </span>
                </button>
              );
            })}
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
