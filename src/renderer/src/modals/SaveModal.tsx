import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  MAX_DOCUMENT_NAME_LENGTH,
  type AssembledDocument,
  type BlankSummary,
  type SaveDocumentsReport,
  type SaveMode,
  type StraightenSummary,
} from '@shared';
import { Modal } from '../components/Modal';
import { useUnmounted } from '../components/useUnmounted';
import { errorText, errorTextInline } from '../state/error-text';
import { asRequested, requestedNames, resultRows } from '../state/save-result';
import { toneOf } from '../state/page-text';
import './save-modal.css';

// Модалка `save` (план M3, U9; handoff M3, S16; UI_SPEC §7.3): режим «Отдельные файлы / Один
// файл», имена, папка, сводка → пакет `saveDocuments` (best-effort, KTD-6). Изменённые здесь
// имена документов сначала записываются в правки — одним шагом undo, — чтобы редактор и файлы не
// расходились; имя единого файла при нескольких документах в журнал не пишется (R15). Полный
// успех под запрошенными именами закрывает модалку (тост S18 ставит экран); частичный сбой или
// имя, изменённое ядром, держат ИТОГ: выбор, имена и папка недоступны — повтор пишет тот же
// пакет. На время записи модалка занята и не закрывается: отменять пакет ядро не умеет.
// С M4 (handoff M4, S14; R16–R17) счёт страниц — по тем, что уйдут в файл (без скрытых пустых
// оборотов), сводка несёт ряд «Пустых оборотов», а отказы ядра `documentBlank` и `blankPending`
// видны до клика: кнопка недоступна, статус объясняет. С M6 (handoff M6, `save`) — ряд
// «Выровнено» и отказ `straightenPending` в том же ряду, что `blankPending`: пока страницы в
// обработке, кнопка недоступна, снимок с нулём открывает её сам; отложенные не блокируют.

export interface SaveModalProps {
  /** Документы со счётом страниц, которые уйдут в файл (без скрытых); `count: 0` — одни скрытые. */
  readonly documents: readonly AssembledDocument[];
  /** Имена по умолчанию — плейсхолдеры строк документов. */
  readonly defaultNames: readonly string[];
  /** Имя единого файла по умолчанию при нескольких документах — «Скан ГГГГ-ММ-ДД». */
  readonly singleDefault: string;
  /** Страниц, которые уйдут в файл (без скрытых пустых оборотов). */
  readonly total: number;
  /** Сводка пустых оборотов снимка: ряд сводки и причины отказа до клика (S14 M4). */
  readonly blank: BlankSummary;
  /** Сводка выравнивания снимка (M6): ряд «Выровнено» и отказ `straightenPending` до клика. */
  readonly straighten: StraightenSummary;
  /**
   * Записать имена, тронутые в модалке (номер документа → имя), одной правкой; `false` — не
   * записались (об этом уже сказано).
   */
  readonly onRename: (names: ReadonlyMap<number, string>) => Promise<boolean>;
  /**
   * Правка редактора в полёте — например, имя из ленты, зафиксированное уходом фокуса на кнопку
   * сохранения: «Сохранить…» ждёт её снимка, иначе правка имён ушла бы от устаревших правок.
   */
  readonly editsBusy: boolean;
  /** Идёт запись пакета: правки заблокированы (KTD-9). */
  readonly onWriting: (writing: boolean) => void;
  /** Нажаты «Отдельные файлы» при одном документе — подсказка тостом (UI_SPEC §7.3). */
  readonly onNeedCuts: () => void;
  /** Пакет записан целиком: экран закрывает модалку и показывает тост. */
  readonly onSaved: (report: SaveDocumentsReport) => void;
  /** «Отмена» или «Закрыть» после сбоя: пакет забыт, ничего не удаляется. */
  readonly onClose: () => void;
}

/** Больше десяти строк — список прокручивается (порог макета). */
const SCROLL_ROWS = 10;

/** Итог записи: отчёт и имена, с которыми пакет ушёл, — повтор шлёт их же. */
interface Outcome {
  readonly report: SaveDocumentsReport;
  readonly requested: readonly string[];
}

interface Row {
  readonly value: string;
  readonly placeholder: string;
  readonly pages: number;
  /** Документ из одних скрытых пустых оборотов — в файл не запишется (S14 M4). */
  readonly blank: boolean;
  readonly onChange: (value: string) => void;
}

/** Ряд «Пустых оборотов» (S14 M4): скрыто / помечено / не найдено — по режиму сессии. */
function blankFact(t: TFunction, blank: BlankSummary): string {
  if (blank.found === 0) {
    return t('save.fact.blankNone');
  }
  return blank.mode === 'hide'
    ? t('save.fact.blankHidden', { count: blank.hidden })
    : t('save.fact.blankMarked', { count: blank.found });
}

/** Ряд «Выровнено» (M6): «N стр.» или «нет», хвост — ещё в обработке или не выровнено. */
function straightFact(t: TFunction, straighten: StraightenSummary): string {
  let text =
    straighten.straightened === 0
      ? t('save.fact.straightNone')
      : t('save.fact.straightValue', { count: straighten.straightened });
  const undone = straighten.unmeasurable + straighten.deferred;
  if (straighten.pending > 0) {
    text += t('save.fact.straightPendingTail', { count: straighten.pending });
  } else if (undone > 0) {
    text += t('save.fact.straightUndoneTail', { count: undone });
  }
  return text;
}

/** Отказ повтора, после которого пакета у ядра больше нет: выбор снова доступен (S16). */
const BATCH_GONE: readonly unknown[] = ['batchStale', 'noFailedFiles'];

/** ИТОГ появился (B-4): если тело модалки его не вмещает — прокрутить к нему. */
function revealResult(section: HTMLDivElement | null): void {
  if (section !== null && typeof section.scrollIntoView === 'function') {
    section.scrollIntoView({ block: 'nearest' });
  }
}

export function SaveModal({
  documents,
  defaultNames,
  singleDefault,
  total,
  blank,
  straighten,
  onRename,
  editsBusy,
  onWriting,
  onNeedCuts,
  onSaved,
  onClose,
}: SaveModalProps): ReactNode {
  const { t } = useTranslation();
  const several = documents.length > 1;
  const [mode, setMode] = useState<SaveMode>(several ? 'separate' : 'single');
  // Имена документов, тронутые в модалке; остальные строки — живые имена из снимка.
  const [edited, setEdited] = useState<ReadonlyMap<number, string>>(() => new Map());
  const [fileName, setFileName] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [writing, setWriting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const unmounted = useUnmounted();

  // Папка — последняя выбранная в этом запуске, иначе «Документы» (KTD-5); её знает ядро.
  useEffect(() => {
    window.api.getSaveFolder().then(
      (result) => {
        if (!unmounted.current && result.ok) {
          setFolder(result.value);
        }
      },
      (error: unknown) => {
        console.error('[renderer] папка сохранения не ответила', error);
      },
    );
  }, [unmounted]);

  // После записи фокус — на основной кнопке: «Повторить неудавшиеся», «Готово» или снова
  // «Сохранить…» после отказа. Начальный фокус — на первом режиме (`Modal`).
  const primaryRef = useRef<HTMLButtonElement>(null);
  const wrote = useRef(false);
  useEffect(() => {
    if (writing) {
      wrote.current = true;
    } else if (wrote.current) {
      primaryRef.current?.focus();
    }
  }, [writing, outcome]);

  // Выбор, имена и папка недоступны во время записи и в ИТОГЕ.
  const locked = writing || outcome !== null;

  const docRows: Row[] = documents.map((doc, index) => ({
    value: edited.get(index) ?? doc.name,
    placeholder: defaultNames[index] ?? '',
    pages: doc.count,
    blank: doc.count === 0,
    onChange: (value) => {
      setEdited((previous) => new Map(previous).set(index, value));
    },
  }));
  // «Один файл» при одном документе — это его имя; при нескольких — имя файла вне журнала.
  const perDocument = mode === 'separate' || !several;
  const rows: Row[] = perDocument
    ? docRows
    : [
        {
          value: fileName,
          placeholder: singleDefault,
          pages: total,
          blank: false,
          onChange: setFileName,
        },
      ];

  // S14 M4: причины отказа ядра — до клика. Документ из одних скрытых (R16) не записать по
  // документам; «Один файл» пишется, пока есть хоть одна показанная. Оценки ещё идут —
  // `blankPending`: снимок с `pending === 0` снимет блок сам.
  const emptyDoc = documents.findIndex((doc) => doc.count === 0);
  const blankDocument = emptyDoc >= 0 && (perDocument || total === 0) ? emptyDoc : -1;
  // M6: выравнивание ещё идёт — `straightenPending`, тот же ряд, что `blankPending`.
  const unsaveable = blankDocument >= 0 || blank.pending > 0 || straighten.pending > 0;

  const write = (requested: readonly string[], retry: boolean): void => {
    setWriting(true);
    setFailure(null);
    onWriting(true);
    window.api.saveDocuments({ mode, names: requested, retry }).then(
      (result) => {
        onWriting(false);
        if (unmounted.current) {
          return;
        }
        setWriting(false);
        if (!result.ok) {
          setFailure(t('save.failed', { error: errorTextInline(t, result.error) }));
          // Отказ целиком (папка недоступна, пакет устарел) — снова выбор; следующее «Сохранить»
          // пишет пакет заново. Иной отказ повтора — ИТОГ остаётся, повтор возможен.
          if (!retry || BATCH_GONE.includes(result.error.details?.reason)) {
            setOutcome(null);
          }
          return;
        }
        if (asRequested(result.value, requested)) {
          onSaved(result.value);
          return;
        }
        setOutcome({ report: result.value, requested });
      },
      (error: unknown) => {
        // Мост не ответил — человек не должен гадать, записались ли файлы: модалка остаётся.
        console.error('[renderer] сохранение не ответило', error);
        onWriting(false);
        if (!unmounted.current) {
          setWriting(false);
          setFailure(t('toast.saveNoResponse'));
        }
      },
    );
  };

  const submit = (): void => {
    if (locked || editsBusy || unsaveable) {
      return;
    }
    const requested = requestedNames(rows);
    setWriting(true);
    setFailure(null);
    void (perDocument ? onRename(edited) : Promise.resolve(true)).then((renamed) => {
      if (unmounted.current) {
        return;
      }
      if (renamed) {
        write(requested, false);
      } else {
        setWriting(false);
      }
    });
  };

  const choose = (): void => {
    if (locked || choosing) {
      return;
    }
    setChoosing(true);
    window.api.chooseSaveFolder().then(
      (result) => {
        if (unmounted.current) {
          return;
        }
        setChoosing(false);
        if (result.ok) {
          // Отказ в диалоге оставляет прежнюю папку — она и приходит. Прежняя ошибка записи
          // (часто — недоступная папка) к новой папке не относится.
          setFolder(result.value.folder);
          setFailure(null);
        } else {
          setFailure(errorText(t, result.error));
        }
      },
      (error: unknown) => {
        console.error('[renderer] выбор папки не ответил', error);
        if (!unmounted.current) {
          setChoosing(false);
        }
      },
    );
  };

  const fileCount = mode === 'separate' ? documents.length : 1;
  const results = outcome === null ? null : resultRows(outcome.report, outcome.requested);

  let status: ReactNode;
  if (writing) {
    status = (
      <p className="modal__status" role="status" aria-live="polite">
        {t('save.writing')}
      </p>
    );
  } else if (failure !== null) {
    status = (
      <p className="modal__status modal__status--danger" role="alert">
        {failure}
      </p>
    );
  } else if (outcome !== null) {
    status = (
      <p className="modal__status" role="status" aria-live="polite">
        {t('save.resultStatus', {
          written: outcome.report.written.length,
          total: outcome.requested.length,
        })}
      </p>
    );
  } else if (blankDocument >= 0) {
    // Безымянный документ назван именем по умолчанию — как в строке.
    const blankDoc = documents[blankDocument];
    const name =
      blankDoc === undefined || blankDoc.name === ''
        ? (defaultNames[blankDocument] ?? '')
        : blankDoc.name;
    status = (
      <p className="modal__status modal__status--danger" role="alert">
        {t('save.documentBlank', { name })}
      </p>
    );
  } else if (blank.pending > 0 && straighten.pending > 0) {
    status = (
      <p className="modal__status" role="status" aria-live="polite">
        {t('save.bothPending', { count: blank.pending + straighten.pending })}
      </p>
    );
  } else if (blank.pending > 0) {
    status = (
      <p className="modal__status" role="status" aria-live="polite">
        {t('save.blankPending', { count: blank.pending })}
      </p>
    );
  } else if (straighten.pending > 0) {
    status = (
      <p className="modal__status" role="status" aria-live="polite">
        {t('save.straightPending', { left: straighten.pending, total: straighten.total })}
      </p>
    );
  } else {
    status = <p className="modal__status" />;
  }

  // Футер: выбор — «Отмена» + «Сохранить…»; частичный сбой — «Закрыть» + «Повторить
  // неудавшиеся»; всё записано, но имена изменены — одна «Готово».
  // Esc (B-11) — та же кнопка: «Готово», «Закрыть» или «Отмена»; во время записи — без действия.
  let actions: ReactNode;
  let escape: (() => void) | undefined;
  if (outcome !== null && outcome.report.failed.length === 0) {
    const { report } = outcome;
    escape = () => {
      onSaved(report);
    };
    actions = (
      <button
        ref={primaryRef}
        type="button"
        className="btn btn--primary btn--small"
        onClick={() => {
          onSaved(report);
        }}
      >
        {t('save.done')}
      </button>
    );
  } else {
    const retry = outcome?.requested ?? null;
    escape = writing ? undefined : onClose;
    let label: string;
    if (retry !== null) {
      label = t('save.retry');
    } else if (fileCount === 1) {
      label = t('save.submitOne');
    } else {
      label = t('save.submitMany', { count: fileCount });
    }
    actions = (
      <>
        <button type="button" className="btn btn--ghost" disabled={writing} onClick={onClose}>
          {retry === null ? t('save.cancel') : t('save.close')}
        </button>
        <button
          ref={primaryRef}
          type="button"
          className="btn btn--primary btn--small"
          disabled={writing || (retry === null && (editsBusy || unsaveable))}
          aria-busy={writing ? true : undefined}
          onClick={() => {
            if (retry === null) {
              submit();
            } else {
              write(retry, true);
            }
          }}
        >
          {writing ? t('save.submitting') : label}
        </button>
      </>
    );
  }

  return (
    <Modal labelledBy="save-title" busy={writing} className="save-modal" onEscape={escape}>
      <header className="modal__header">
        <h2 id="save-title" className="modal__title">
          {fileCount === 1 ? t('save.titleOne') : t('save.titleMany', { count: fileCount })}
        </h2>
      </header>
      <div className="modal__body">
        <div className="modal__section">
          <h3 className="kicker" id="save-mode-kicker">
            {t('save.mode.label')}
          </h3>
          <div className="save-modal__modes" role="radiogroup" aria-labelledby="save-mode-kicker">
            <button
              type="button"
              className="save-mode"
              role="radio"
              aria-checked={mode === 'separate'}
              aria-disabled={locked || !several ? true : undefined}
              onClick={() => {
                if (locked) {
                  return;
                }
                if (several) {
                  setMode('separate');
                } else {
                  onNeedCuts();
                }
              }}
            >
              <span>{t('save.mode.separate')}</span>
              <span className="save-mode__hint">
                {several
                  ? t('save.mode.separateHint', { count: documents.length })
                  : t('save.mode.separateNone')}
              </span>
            </button>
            <button
              type="button"
              className="save-mode"
              role="radio"
              aria-checked={mode === 'single'}
              aria-disabled={locked ? true : undefined}
              onClick={() => {
                if (!locked) {
                  setMode('single');
                }
              }}
            >
              <span>{t('save.mode.single')}</span>
              <span className="save-mode__hint">{t('save.mode.singleHint', { count: total })}</span>
            </button>
          </div>
        </div>

        <div className="modal__section">
          <h3 className="kicker" id="save-files-kicker">
            {t('save.files', { count: rows.length })}
          </h3>
          <ul
            aria-labelledby="save-files-kicker"
            className={rows.length > SCROLL_ROWS ? 'save-files save-files--scroll' : 'save-files'}
          >
            {rows.map((row, index) => (
              <li
                key={index}
                className={`save-file ${toneOf(index)}${row.blank ? ' save-file--blank' : ''}`}
              >
                <span className="doc-badge doc-badge--small" aria-hidden="true">
                  {index + 1}
                </span>
                <input
                  className="save-file__name"
                  type="text"
                  value={row.value}
                  placeholder={row.placeholder}
                  maxLength={MAX_DOCUMENT_NAME_LENGTH}
                  aria-label={t('save.fileLabel', { number: index + 1 })}
                  disabled={locked}
                  onChange={(event) => {
                    row.onChange(event.target.value);
                  }}
                />
                <span className="save-file__ext">.pdf</span>
                <span className="save-file__meta">
                  {row.blank ? t('save.fileMetaBlank') : t('save.fileMeta', { count: row.pages })}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="modal__section">
          <h3 className="kicker">{t('save.folder')}</h3>
          <div className="save-folder">
            <span className="save-folder__icon" aria-hidden="true" />
            {/* Путь режется с начала (`direction: rtl`); метки LTR держат на месте края пути
                вроде «\\сервер» и хвостового «\». */}
            <p className="save-folder__path" title={folder ?? undefined}>
              {folder === null ? '' : `‎${folder}‎`}
            </p>
            <button
              type="button"
              className="btn btn--tinted"
              disabled={locked || choosing}
              onClick={choose}
            >
              {t('save.chooseFolder')}
            </button>
          </div>
        </div>

        <dl className="facts">
          <div className="facts__row">
            <dt className="facts__key">{t('save.fact.files')}</dt>
            <dd className="facts__value">{fileCount}</dd>
          </div>
          <div className="facts__row">
            <dt className="facts__key">{t('save.fact.pages')}</dt>
            <dd className="facts__value">{total}</dd>
          </div>
          {blank.mode !== 'keep' && (
            <div className="facts__row">
              <dt className="facts__key">{t('save.fact.blank')}</dt>
              <dd className="facts__value">{blankFact(t, blank)}</dd>
            </div>
          )}
          {straighten.mode === 'auto' && (
            <div className="facts__row">
              <dt className="facts__key">{t('save.fact.straight')}</dt>
              <dd className="facts__value">{straightFact(t, straighten)}</dd>
            </div>
          )}
          <div className="facts__row">
            <dt className="facts__key">{t('save.fact.format')}</dt>
            <dd className="facts__value">{t('save.fact.formatValue')}</dd>
          </div>
        </dl>

        {results !== null && (
          // B-4: ИТОГ проявляется после роста высоты окна; не помещается — тело прокручивается к нему.
          <div className="modal__section save-modal__result" ref={revealResult}>
            <h3 className="kicker" id="save-result-kicker">
              {t('save.result')}
            </h3>
            <ul className="save-result" aria-labelledby="save-result-kicker">
              {results.map((row) => (
                <li
                  key={row.index}
                  className={
                    row.error === null
                      ? 'save-result__row'
                      : 'save-result__row save-result__row--failed'
                  }
                >
                  <span className="save-result__icon" aria-hidden="true">
                    {row.error === null ? '✓' : '✕'}
                  </span>
                  <span className="save-result__name">
                    {row.fileName}
                    {row.error !== null && (
                      <span className="save-result__note">{errorText(t, row.error)}</span>
                    )}
                    {row.note === 'renamed' && (
                      <span className="save-result__note">{t('save.resultRenamed')}</span>
                    )}
                    {row.note === 'changed' && (
                      <span className="save-result__note">{t('save.resultChanged')}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <footer className="modal__footer">
        {status}
        {actions}
      </footer>
    </Modal>
  );
}
