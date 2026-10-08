import { useId, useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssembledPage, SessionAssembly } from '@shared';
import type { TFunction } from 'i18next';

// Инспектор редактора (handoff M3, S11–S13): ДЕТАЛИ текущей страницы, ДОКУМЕНТЫ В НАБОРЕ и
// ПРОВЕРКА, внизу — плашка правок S14 с «Вернуть». Только показ снимка: пары, порядок и наличие
// правок — из отчёта и флагов сборки ядра (KTD-2, KTD-7).

/** Тон документа по номеру с нуля: четыре цвета по кругу (handoff M3, Anatomy). */
export const toneOf = (document: number): string => `doc-tone--${String((document % 4) + 1)}`;

/** Лишний оборот: оборот без листа. */
const isExtraBack = (entry: AssembledPage): boolean =>
  entry.side === 'back' && entry.sheet === null;

function titleOf(t: TFunction, entry: AssembledPage, position: number): string {
  const sheet = entry.sheet ?? 0;
  if (isExtraBack(entry)) {
    return t('inspector.titleExtraBack', { page: position });
  }
  if (entry.side === 'back') {
    return t('inspector.titleBack', { page: position, sheet });
  }
  return t('inspector.titleFront', { page: position, sheet });
}

/** Пояснение — по самому важному: потеря, лишний оборот, непарность, односторонний набор. */
function noteOf(t: TFunction, entry: AssembledPage, frontsOnly: boolean): string {
  const sheet = entry.sheet ?? 0;
  if (entry.lost) {
    return t('inspector.note.lost');
  }
  if (isExtraBack(entry)) {
    return t('inspector.note.extraBack');
  }
  if (entry.unpaired) {
    return t('inspector.note.unpaired');
  }
  if (entry.side === 'back') {
    return t('inspector.note.back', { sheet });
  }
  if (frontsOnly) {
    return t('inspector.note.frontsOnly');
  }
  return t('inspector.note.front', { sheet });
}

/** Строка ПРОВЕРКИ: ✓ — всё хорошо, • — стоит взглянуть. */
function Check({
  warning,
  children,
}: {
  readonly warning: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <li className={warning ? 'check check--warning' : 'check'}>
      <span className="check__icon" aria-hidden="true">
        {warning ? '•' : '✓'}
      </span>
      <span className="check__text">{children}</span>
    </li>
  );
}

function Details({
  entry,
  position,
  frontsOnly,
  open,
  onToggle,
}: {
  readonly entry: AssembledPage;
  readonly position: number;
  readonly frontsOnly: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const bodyId = useId();

  const title = titleOf(t, entry, position);
  const note = noteOf(t, entry, frontsOnly);

  return (
    <section className="inspector__section inspector__section--details">
      <button
        type="button"
        className="details-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <span className="kicker">{t('inspector.details')}</span>
        <span className="details-toggle__rule" aria-hidden="true" />
        <span className="details-toggle__summary">
          {t('inspector.detailsSummary', { page: position })}
        </span>
        <span className="details-toggle__arrow" aria-hidden="true">
          ▾
        </span>
      </button>
      <div id={bodyId} className="details" hidden={!open}>
        <h2 className="details__title">{title}</h2>
        <dl className="facts">
          <div className="facts__row">
            <dt className="facts__key">{t('inspector.fact.sheet')}</dt>
            <dd className="facts__value">
              {entry.sheet === null
                ? t('inspector.fact.sheetNone')
                : t('inspector.fact.sheetValue', { sheet: entry.sheet })}
            </dd>
          </div>
          <div className="facts__row">
            <dt className="facts__key">{t('inspector.fact.side')}</dt>
            <dd className="facts__value">
              {entry.side === 'back' ? t('inspector.fact.back') : t('inspector.fact.front')}
            </dd>
          </div>
          <div className="facts__row">
            <dt className="facts__key">{t('inspector.fact.angle')}</dt>
            <dd className="facts__value">
              {t('inspector.fact.angleValue', { angle: entry.angle })}
            </dd>
          </div>
        </dl>
        <p className="details__note">{note}</p>
      </div>
    </section>
  );
}

export function EditorInspector({
  assembly,
  entry,
  position,
  currentDocument,
  names,
  frontsOnly,
  locked,
  onPickDocument,
  onMouseDown,
  onRevert,
}: {
  readonly assembly: SessionAssembly;
  /** Текущая страница; `undefined` — лента пуста (S10: ДЕТАЛИ скрыты). */
  readonly entry: AssembledPage | undefined;
  /** Номер текущей страницы в ленте, с единицы. */
  readonly position: number;
  /** Документ текущей страницы (с нуля); `null` — лента пуста. */
  readonly currentDocument: number | null;
  /** Показываемые имена документов: введённые или по умолчанию. */
  readonly names: readonly string[];
  /** Прохода оборотов нет — набор односторонний. */
  readonly frontsOnly: boolean;
  /** Идёт запись (KTD-9): «Вернуть» недоступна. */
  readonly locked: boolean;
  readonly onPickDocument: (document: number) => void;
  /** Клик по поверхности инспектора — сжатие мультивыделения решает экран (M3.5, R21). */
  readonly onMouseDown?: (event: MouseEvent<HTMLElement>) => void;
  /** «Вернуть» — открыть подтверждение `revert`. */
  readonly onRevert: () => void;
}): ReactNode {
  const { t } = useTranslation();
  // ДЕТАЛИ свёрнуты по умолчанию; состояние живёт до размонтирования экрана (S11), в том числе
  // пока лента пуста и блок скрыт.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const docsId = useId();
  const checksId = useId();
  const documents = assembly.order.length === 0 ? [] : assembly.documents;
  const report = assembly.report;
  const pairsWarning = report.mismatch;

  return (
    <aside className="inspector" aria-label={t('inspector.label')} onMouseDown={onMouseDown}>
      {entry !== undefined && (
        <Details
          entry={entry}
          position={position}
          frontsOnly={frontsOnly}
          open={detailsOpen}
          onToggle={() => {
            setDetailsOpen((value) => !value);
          }}
        />
      )}

      <section className="inspector__section" aria-labelledby={docsId}>
        <div className="inspector__heading">
          <h2 id={docsId} className="kicker">
            {t('inspector.docs')}
          </h2>
          <span className="inspector__meta">
            {documents.length === 0
              ? t('inspector.docsNone')
              : t('inspector.docsCount', { count: documents.length })}
          </span>
        </div>
        {documents.length > 0 && (
          <>
            <ul className="doc-list">
              {documents.map((document, index) => (
                <li key={document.start}>
                  <button
                    type="button"
                    className={`doc-list__item ${toneOf(index)}`}
                    aria-current={index === currentDocument ? 'true' : undefined}
                    onClick={() => {
                      onPickDocument(index);
                    }}
                  >
                    <span className="doc-badge doc-badge--small" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="doc-list__text">
                      <span className="doc-list__name">{names[index]}</span>
                      <span className="doc-list__meta">
                        {document.count === 1
                          ? t('inspector.docMetaOnePage', { from: document.start + 1 })
                          : t('inspector.docMeta', {
                              count: document.count,
                              from: document.start + 1,
                              to: document.start + document.count,
                            })}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="inspector__note">
              {documents.length > 1
                ? t('inspector.docsNoteMany', { count: documents.length })
                : t('inspector.docsNoteOne')}
            </p>
          </>
        )}
      </section>

      <section className="inspector__section" aria-labelledby={checksId}>
        <h2 id={checksId} className="kicker">
          {t('inspector.checks')}
        </h2>
        <ul className="checks">
          {report.backsState === null ? (
            <Check warning={false}>{t('inspector.check.frontsOnly')}</Check>
          ) : (
            <Check warning={pairsWarning}>
              {t('inspector.check.pairs', { pairs: report.pairs, fronts: report.fronts })}
            </Check>
          )}
          <Check warning={assembly.orderEdited}>
            {assembly.orderEdited
              ? t('inspector.check.orderEdited')
              : t('inspector.check.orderAuto')}
          </Check>
        </ul>
      </section>

      {/* S14: при любой правке, включая тумблер 180° — флаг ядра учитывает и его. */}
      {assembly.hasEdits && (
        <div className="edits-bar" role="status">
          <p className="edits-bar__text">{t('editor.edits.text')}</p>
          <button
            type="button"
            className="btn btn--tinted"
            title={t('editor.edits.revertTitle')}
            disabled={locked}
            onClick={onRevert}
          >
            {t('editor.edits.revert')}
          </button>
        </div>
      )}
    </aside>
  );
}
