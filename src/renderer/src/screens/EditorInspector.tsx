import { useId, useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssembledPage, AssemblyMode, PassKind, SessionAssembly, SetsLayout } from '@shared';
import type { TFunction } from 'i18next';
import { noteOf, toneOf, whatOf } from '../state/page-text';

// Инспектор редактора (handoff M3, S11–S13; M3.5, S6–S7; M3.6, S8–S9): ДЕТАЛИ текущей страницы,
// ДОКУМЕНТЫ В НАБОРЕ и ПРОВЕРКА, внизу — плашка правок S14 с «Вернуть». Только показ снимка:
// режим, счётчики групп, порядок и наличие правок — из отчёта и флагов сборки ядра (KTD-2,
// KTD-7). Страница добавленного набора — без «лица» и «листа»: факт «Набор» и своё пояснение.
// До сборки (режим наборов) «Лист» не называется: факты «Набор», «Место», «Откуда» (R23);
// заголовок и пояснение ДЕТАЛЕЙ — по режиму (KTD9), теми же словами, что подпись миниатюры и
// сводка `add`.

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

/**
 * Пункт ПРОВЕРКИ о лицах и оборотах (R22): наборы — точка со счётчиками, иначе галочка с числом
 * листов: в парах — число пар по проходам, после сборки — число лиц в видимой ленте (лист = лицо
 * по позиции в записи; добавленные наборы и удаления меняют его честно).
 */
function PairsCheck({
  t,
  assembly,
}: {
  readonly t: TFunction;
  readonly assembly: SessionAssembly;
}): ReactNode {
  const { report, sets } = assembly;
  if (report.backsState === null) {
    return <Check warning={false}>{t('inspector.check.frontsOnly')}</Check>;
  }
  if (report.mode !== 'sets' || sets === null) {
    const count =
      report.mode === 'assembled'
        ? assembly.order.filter((page) => page.side === 'front').length
        : Math.min(report.fronts, report.backs);
    return <Check warning={false}>{t('inspector.check.assembled', { count })}</Check>;
  }
  const { fronts, backs } = sets;
  if (fronts === 0 && backs === 0) {
    return <Check warning>{t('inspector.check.setsEmpty')}</Check>;
  }
  // Точка остаётся и при уравненных наборах: документ ещё не собран (handoff, Decisions).
  if (fronts === backs) {
    return <Check warning>{t('inspector.check.setsEqual', { count: fronts })}</Check>;
  }
  const missing = Math.abs(fronts - backs);
  return (
    <Check warning>
      {t('inspector.check.sets', {
        fronts,
        backs,
        missing,
        what: t(
          backs < fronts ? 'inspector.check.setsMissingBacks' : 'inspector.check.setsMissingFronts',
          { count: missing },
        ),
      })}
      <span className="check__hint">{t('inspector.check.setsHint')}</span>
    </Check>
  );
}

function Fact({ name, value }: { readonly name: string; readonly value: string }): ReactNode {
  return (
    <div className="facts__row">
      <dt className="facts__key">{name}</dt>
      <dd className="facts__value">{value}</dd>
    </div>
  );
}

function Details({
  entry,
  position,
  mode,
  sets,
  origin,
  frontsOnly,
  open,
  onToggle,
}: {
  readonly entry: AssembledPage;
  readonly position: number;
  readonly mode: AssemblyMode;
  readonly sets: SetsLayout | null;
  readonly origin: PassKind | null;
  readonly frontsOnly: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const bodyId = useId();

  const title = t('inspector.title', { page: position, what: whatOf(t, entry, mode) });
  const note = noteOf(t, entry, mode, frontsOnly);
  const back = entry.side === 'back';

  let facts: ReactNode;
  if (mode === 'sets' && sets !== null) {
    // S9 M3.6: до сборки листа нет — набор, место в нём и происхождение.
    let originText: string;
    if (entry.addedSet !== null) {
      originText = t('inspector.fact.originAdded', { set: entry.addedSet });
    } else {
      originText = t(
        origin === 'backs' ? 'inspector.fact.originBacks' : 'inspector.fact.originFronts',
      );
    }
    facts = (
      <>
        <Fact
          name={t('inspector.fact.group')}
          value={t(back ? 'inspector.fact.groupBacks' : 'inspector.fact.groupFronts')}
        />
        <Fact
          name={t('inspector.fact.place')}
          value={t('inspector.fact.placeValue', {
            position: entry.sheet ?? 0,
            count: back ? sets.backs : sets.fronts,
          })}
        />
        <Fact name={t('inspector.fact.origin')} value={originText} />
      </>
    );
  } else if (entry.addedSet !== null) {
    // S6 M3.5: у добавленной страницы нет ни листа, ни стороны — только набор.
    facts = (
      <Fact
        name={t('inspector.fact.set')}
        value={t('inspector.fact.setValue', { set: entry.addedSet })}
      />
    );
  } else {
    facts = (
      <>
        <Fact
          name={t('inspector.fact.sheet')}
          value={
            entry.sheet === null
              ? t('inspector.fact.sheetNone')
              : t('inspector.fact.sheetValue', { sheet: entry.sheet })
          }
        />
        <Fact
          name={t('inspector.fact.side')}
          value={back ? t('inspector.fact.back') : t('inspector.fact.front')}
        />
      </>
    );
  }

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
          {facts}
          <Fact
            name={t('inspector.fact.angle')}
            value={t('inspector.fact.angleValue', { angle: entry.angle })}
          />
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
  origin,
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
  /** Проход текущей страницы — факт «Откуда» до сборки (R23); `null` — ленты нет. */
  readonly origin: PassKind | null;
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
  const { report, sets } = assembly;
  const inSets = report.mode === 'sets';

  return (
    <aside className="inspector" aria-label={t('inspector.label')} onMouseDown={onMouseDown}>
      {entry !== undefined && (
        <Details
          entry={entry}
          position={position}
          mode={report.mode}
          sets={sets}
          origin={origin}
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
          {/* В режиме наборов документов ещё нет — счётчик не рисуется (R17). */}
          {!inSets && (
            <span className="inspector__meta">
              {documents.length === 0
                ? t('inspector.docsNone')
                : t('inspector.docsCount', { count: documents.length })}
            </span>
          )}
        </div>
        {inSets ? (
          <p className="inspector__note">{t('inspector.docsAfterAssemble')}</p>
        ) : (
          documents.length > 0 && (
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
          )
        )}
      </section>

      <section className="inspector__section" aria-labelledby={checksId}>
        <h2 id={checksId} className="kicker">
          {t('inspector.checks')}
        </h2>
        <ul className="checks">
          <PairsCheck t={t} assembly={assembly} />
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
