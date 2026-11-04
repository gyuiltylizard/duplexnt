import { useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isPairKind,
  type AssembledPage,
  type AssemblyMode,
  type BlankSummary,
  type PassKind,
  type SessionAssembly,
  type SetsLayout,
  APP_NAME,
} from '@shared';
import type { TFunction } from 'i18next';
import { noteOf, toneOf, whatOf } from '../state/page-text';
import type { ShownDocument } from '../state/shown';
import { straightFactText, type StraightSelection } from '../state/straighten-text';
import { AppMark } from '../components/AppMark';
import { StraightSection, straightChecks, straightSectionDue } from './EditorInspectorStraight';
import { Check, type CheckItem } from './InspectorCheck';
import { useHintAttention } from './useHintAttention';

// Инспектор редактора (handoff M3, S11–S13; M3.5, S6–S7; M3.6, S8–S9; B-45
// `2026-11-inspector-v2.md`): ДЕТАЛИ текущей страницы с подразделом ПРОВЕРКА внутри, ПУСТОЙ
// ОБОРОТ, ВЫРАВНИВАНИЕ, ДОКУМЕНТЫ В НАБОРЕ с первичной кнопкой («Сохранить…» / «Собрать
// документ») на всю ширину, внизу подвал — логотип, ссылка на проект и плашка BETA. Плашка
// правок с «Вернуть» с B-45 живёт в правой зоне тулбара. Только показ снимка:
// режим, счётчики групп, порядок и наличие правок — из отчёта и флагов сборки ядра (KTD-2,
// KTD-7). Страница добавленного набора — без «лица» и «листа»: факт «Набор» и своё пояснение.
// До сборки (режим наборов) «Лист» не называется: факты «Набор», «Место», «Откуда» (R23);
// заголовок и пояснение ДЕТАЛЕЙ — по режиму (KTD9), теми же словами, что подпись миниатюры и
// сводка `add`. M4 (handoff M4, S9–S11): секция «ПУСТОЙ ОБОРОТ» с действием «Это не пустая
// страница» у пустой текущей, факт «Содержимое» в ДЕТАЛЯХ, пункт ПРОВЕРКИ о пустых; список
// документов — в координатах показанной ленты. M6 (handoff M6): секция «ВЫРАВНИВАНИЕ» после
// ДЕТАЛЕЙ с «Оставить оригинал» / «Выровнять», факт «Выравнивание», пункт ПРОВЕРКИ
// (`EditorInspectorStraight.tsx`).

/**
 * Пункты ПРОВЕРКИ о лицах и оборотах (R22) — только при отклонении (решение автора 2026-11-03,
 * bugs): при совпавших проходах и без оборотов пунктов нет — модалка уже всё сказала, а
 * «Обороты не сканировали» про давний выбор только путал, когда потом добавлялись двусторонние
 * наборы. Остаются: наборы не собраны — точка со счётчиками групп; набор «ДN», у которого
 * обороты не сошлись и нажато «Оставить как есть», — точка словами кнопки: модалка второй раз
 * не покажется, а листы без оборотов легко забыть. Числа — по проходам (KTD-7): «отсканировано
 * 1 из 3» остаётся правдой и после правок.
 */
function pairsChecks(t: TFunction, assembly: SessionAssembly): CheckItem[] {
  const { report, sets } = assembly;
  const keptSets: CheckItem[] = report.sets
    .filter((set) => set.decision === 'kept' && set.mismatch)
    .map((set) => ({
      key: `set-${String(set.set)}`,
      warning: true,
      text: t(
        set.backs < set.fronts ? 'inspector.check.setKeptFewer' : 'inspector.check.setKeptExtra',
        { set: set.set, fronts: set.fronts, backs: set.backs },
      ),
    }));
  if (report.mode !== 'sets' || sets === null) {
    return keptSets;
  }
  const { fronts, backs } = sets;
  let main: ReactNode;
  if (fronts === 0 && backs === 0) {
    main = t('inspector.check.setsEmpty');
  } else if (fronts === backs) {
    // Точка остаётся и при уравненных наборах: документ ещё не собран (handoff, Decisions).
    main = t('inspector.check.setsEqual', { count: fronts });
  } else {
    const missing = Math.abs(fronts - backs);
    main = (
      <>
        {t('inspector.check.sets', {
          fronts,
          backs,
          missing,
          what: t(
            backs < fronts
              ? 'inspector.check.setsMissingBacks'
              : 'inspector.check.setsMissingFronts',
            { count: missing },
          ),
        })}
        <span className="check__hint">{t('inspector.check.setsHint')}</span>
      </>
    );
  }
  return [{ key: 'sets', warning: true, text: main }, ...keptSets];
}

/**
 * Пункт ПРОВЕРКИ о пустых оборотах (M4, S11): при «Оставлять» пункта нет; оценка идёт — точка с
 * приоритетом (сохранение недоступно); «Скрывать» — точка (состав файла изменился без участия
 * человека), «Помечать» — галочка; в режиме наборов при «Скрывать» — считаются, скроются после
 * сборки.
 */
/** S10 M4: факт «Содержимое» — только у пустых по оценке и у помеченных вручную. */
function contentText(t: TFunction, entry: AssembledPage, notBlank: boolean): string | null {
  if (notBlank) {
    return t('inspector.fact.contentNotBlank');
  }
  if (entry.blank === 'hidden') {
    return t('inspector.fact.contentHidden');
  }
  return entry.blank === 'marked' ? t('inspector.fact.contentMarked') : null;
}

/**
 * S9 M4: текст секции «ПУСТОЙ ОБОРОТ» — по тому, что будет со страницей: считается в наборах
 * до сборки, скрыта, в файле с меткой; обычная страница — секции нет.
 */
function blankNoteText(t: TFunction, entry: AssembledPage, inSets: boolean): string | null {
  if (entry.blank === null) {
    return null;
  }
  if (inSets) {
    return t('inspector.blank.sets');
  }
  return t(entry.blank === 'hidden' ? 'inspector.blank.hidden' : 'inspector.blank.marked');
}

/** Строка документа в списке ДОКУМЕНТЫ: «только пустые — скрыты», «стр. N» или «N стр. · M–K». */
function docMetaText(t: TFunction, document: ShownDocument): string {
  if (document.count === 0) {
    return t('inspector.docMetaBlank');
  }
  if (document.count === 1) {
    return t('inspector.docMetaOnePage', { from: document.start + 1 });
  }
  return t('inspector.docMeta', {
    count: document.count,
    from: document.start + 1,
    to: document.start + document.count,
  });
}

function blankChecks(t: TFunction, blank: BlankSummary, inSets: boolean): CheckItem[] {
  if (blank.mode === 'keep') {
    return [];
  }
  const item = (warning: boolean, text: ReactNode): CheckItem[] => [
    { key: 'blank', warning, text },
  ];
  if (blank.pending > 0) {
    return item(true, t('inspector.check.blankPending', { count: blank.pending }));
  }
  if (blank.found === 0) {
    return item(false, t('inspector.check.blankNone'));
  }
  if (blank.mode === 'mark') {
    return item(false, t('inspector.check.blankMarked', { count: blank.found }));
  }
  if (inSets) {
    return item(true, t('inspector.check.blankSets', { count: blank.found }));
  }
  return item(
    true,
    <>
      {t('inspector.check.blankHidden', { count: blank.hidden })}
      <span className="check__hint">{t('inspector.check.blankHiddenHint')}</span>
    </>,
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
  notBlank,
  checks,
  open,
  onToggle,
}: {
  readonly entry: AssembledPage;
  readonly position: number;
  readonly mode: AssemblyMode;
  readonly sets: SetsLayout | null;
  readonly origin: PassKind | null;
  readonly frontsOnly: boolean;
  /** Страница помечена «не пустая» (M4, S10) — факт «Содержимое». */
  readonly notBlank: boolean;
  /** Пункты ПРОВЕРКИ (B-45): подраздел ДЕТАЛЕЙ; точка в свёрнутой строке — пока есть точка в них. */
  readonly checks: readonly CheckItem[];
  readonly open: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const bodyId = useId();
  const warned = checks.some((item) => item.warning);

  const title = t('inspector.title', {
    page: position,
    what: whatOf(t, entry, mode, origin),
  });
  const note = noteOf(t, entry, mode, frontsOnly, origin);
  const back = entry.side === 'back';
  const content = contentText(t, entry, notBlank);
  // M6: факт «Выравнивание» — только при статусе (у пустой, потерянной и при «Не трогать» нет).
  const straight = straightFactText(t, entry.straighten);

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
  } else if (entry.addedSet !== null && isPairKind(origin)) {
    // S8 M4.5: страница двустороннего набора — набор, лист внутри набора (в подблоках его
    // нет), сторона и проход пары.
    facts = (
      <>
        <Fact
          name={t('inspector.fact.set')}
          value={t('inspector.fact.setValue', { set: entry.addedSet })}
        />
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
        <Fact
          name={t('inspector.fact.origin')}
          value={t(
            origin === 'addedBacks'
              ? 'inspector.fact.originSetBacks'
              : 'inspector.fact.originSetFronts',
            { set: entry.addedSet },
          )}
        />
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
        {/* B-45 (решение 3): свёрнутые ДЕТАЛИ не прячут замечания ПРОВЕРКИ — янтарная точка. */}
        {!open && warned && (
          <span
            className="dot dot--warning details-toggle__dot"
            title={t('inspector.detailsWarning')}
          >
            <span className="visually-hidden">{t('inspector.detailsWarning')}</span>
          </span>
        )}
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
          {content !== null && <Fact name={t('inspector.fact.content')} value={content} />}
          {straight !== null && <Fact name={t('inspector.fact.straight')} value={straight} />}
          <Fact
            name={t('inspector.fact.angle')}
            value={t('inspector.fact.angleValue', { angle: entry.angle })}
          />
        </dl>
        <p className="details__note">{note}</p>
        <div className="details__checks">
          <h3 className="kicker">{t('inspector.checks')}</h3>
          <ul className="checks">
            {checks.map((item) => (
              <Check key={item.key} warning={item.warning}>
                {item.text}
              </Check>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** Первичная кнопка под ДОКУМЕНТАМИ В НАБОРЕ (B-45, KTD-5): гарды и команду считает экран. */
export interface InspectorPrimary {
  /** «Сохранить документ» / «Сохранить N файлов» или «Собрать документ» (режим наборов). */
  readonly kind: 'save' | 'assemble';
  readonly disabled: boolean;
  /** Причина недоступности «Собрать документ» (S5 M3.6). */
  readonly title?: string | undefined;
  readonly onClick: () => void;
}

export function EditorInspector({
  assembly,
  documents,
  entry,
  position,
  origin,
  currentDocument,
  names,
  frontsOnly,
  notBlank,
  locked,
  notBlankLocked,
  hintSeen,
  straight,
  onPickDocument,
  onNotBlank,
  onKeepOriginal,
  onRestoreStraight,
  onMouseDown,
  primary,
  onOpenProject,
}: {
  readonly assembly: SessionAssembly;
  /** Документы в координатах показанной ленты (M4, R11): счётчики и диапазоны — по показанным. */
  readonly documents: readonly ShownDocument[];
  /** Текущая страница; `undefined` — лента пуста (S10: ДЕТАЛИ скрыты). */
  readonly entry: AssembledPage | undefined;
  /** Номер текущей страницы в показанной ленте, с единицы. */
  readonly position: number;
  /** Проход текущей страницы — факт «Откуда» до сборки (R23); `null` — ленты нет. */
  readonly origin: PassKind | null;
  /** Документ текущей страницы (с нуля); `null` — лента пуста. */
  readonly currentDocument: number | null;
  /** Показываемые имена документов: введённые или по умолчанию. */
  readonly names: readonly string[];
  /** Прохода оборотов нет — набор односторонний. */
  readonly frontsOnly: boolean;
  /** Текущая помечена «не пустая» (M4, KTD5). */
  readonly notBlank: boolean;
  /** Идёт запись или правка в полёте (KTD-9): «Вернуть» и «Это не пустая страница» недоступны. */
  readonly locked: boolean;
  /** «Это не пустая страница» гасится и при команде правки в полёте (B-17), как действия выравнивания. */
  readonly notBlankLocked: boolean;
  /** Подсказка про границы (Ctrl/Shift) уже показывалась с привлечением внимания (B-4). */
  readonly hintSeen: boolean;
  /** Выделение по статусам выравнивания (M6): секция ВЫРАВНИВАНИЕ и подписи её кнопок. */
  readonly straight: StraightSelection;
  readonly onPickDocument: (document: number) => void;
  /** «Это не пустая страница» (M4, S9) — пометка текущей одним шагом undo. */
  readonly onNotBlank: () => void;
  /** «Оригинал» / «Выровнять» (M6) — на текущую или выделение, один шаг undo. */
  readonly onKeepOriginal: () => void;
  readonly onRestoreStraight: () => void;
  /** Клик по поверхности инспектора — сжатие мультивыделения решает экран (M3.5, R21). */
  readonly onMouseDown?: (event: MouseEvent<HTMLElement>) => void;
  /** Первичная кнопка под документами (B-45). */
  readonly primary: InspectorPrimary;
  /** Ссылка на страницу проекта в подвале (B-42) — команда моста без входа. */
  readonly onOpenProject: () => void;
}): ReactNode {
  const { t } = useTranslation();
  // ДЕТАЛИ свёрнуты по умолчанию; состояние живёт до размонтирования экрана (S11), в том числе
  // пока лента пуста и блок скрыт.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const docsId = useId();
  const blankId = useId();
  const straightId = useId();
  const listed = assembly.order.length === 0 ? [] : documents;
  // Подсказка про границы — при первом показе на установку мигает (B-4).
  const noteRef = useRef<HTMLParagraphElement>(null);
  const attention = useHintAttention(noteRef, 'docsSplit', listed.length === 1 && !hintSeen);
  const { report, sets } = assembly;
  const inSets = report.mode === 'sets';
  const blankNote = entry === undefined ? null : blankNoteText(t, entry, inSets);
  const checks: CheckItem[] = [
    ...pairsChecks(t, assembly),
    ...blankChecks(t, assembly.blank, inSets),
    ...straightChecks(t, assembly.straighten),
    {
      key: 'order',
      warning: assembly.orderEdited,
      text: t(assembly.orderEdited ? 'inspector.check.orderEdited' : 'inspector.check.orderAuto'),
    },
  ];
  let primaryLabel: string;
  if (primary.kind === 'assemble') {
    primaryLabel = t('editor.assemble');
  } else if (listed.length > 1) {
    primaryLabel = t('editor.saveFiles', { count: listed.length });
  } else {
    primaryLabel = t('editor.save');
  }

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
          notBlank={notBlank}
          checks={checks}
          open={detailsOpen}
          onToggle={() => {
            setDetailsOpen((value) => !value);
          }}
        />
      )}

      {blankNote !== null && (
        <section className="inspector__section inspector__section--blank" aria-labelledby={blankId}>
          <div className="inspector__heading">
            <h2 id={blankId} className="kicker">
              {t('inspector.blank.kicker')}
            </h2>
          </div>
          <p className="inspector__note">{blankNote}</p>
          <button
            type="button"
            className="btn btn--tinted inspector__blank-action"
            title={t('inspector.blank.actionTitle')}
            disabled={notBlankLocked}
            onClick={onNotBlank}
          >
            {t('inspector.blank.action')}
          </button>
        </section>
      )}

      {/* M6: при «Не трогать» секции нет; у пустой статуса нет — с секцией пустого не пересекается. */}
      {entry !== undefined &&
        assembly.straighten.mode === 'auto' &&
        straightSectionDue(t, straight, entry.straighten) && (
          <StraightSection
            t={t}
            headingId={straightId}
            selection={straight}
            current={entry.straighten}
            locked={locked}
            onKeep={onKeepOriginal}
            onRestore={onRestoreStraight}
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
              {listed.length === 0
                ? t('inspector.docsNone')
                : t('inspector.docsCount', { count: listed.length })}
            </span>
          )}
        </div>
        {inSets ? (
          <p className="inspector__note">{t('inspector.docsAfterAssemble')}</p>
        ) : (
          listed.length > 0 && (
            <>
              <ul className="doc-list">
                {listed.map((document, index) => (
                  <li key={index}>
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
                        <span className="doc-list__meta">{docMetaText(t, document)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <p
                ref={noteRef}
                className={
                  attention === 'none'
                    ? 'inspector__note'
                    : `inspector__note inspector__note--${attention === 'blink' ? 'attention' : 'attention-static'}`
                }
              >
                {listed.length > 1
                  ? t('inspector.docsNoteMany', { count: listed.length })
                  : t('inspector.docsNoteOne')}
              </p>
            </>
          )
        )}
        {/* B-45 (KTD-5): первичное действие — у своего объекта, на всю ширину. */}
        <button
          type="button"
          className="btn btn--primary inspector__primary"
          disabled={primary.disabled}
          title={primary.title}
          onClick={primary.onClick}
        >
          {primaryLabel}
        </button>
      </section>

      {/* Подвал (B-42, B-45): логотип со ссылкой на проект и плашка BETA прижаты к низу панели. */}
      <footer className="inspector__footer">
        <div className="inspector__brand">
          <AppMark className="inspector__mark" />
          <button
            type="button"
            className="inspector__about"
            title={t('inspector.aboutTitle')}
            onClick={onOpenProject}
          >
            {t('inspector.about', { app: APP_NAME })}
          </button>
        </div>
        <span className="beta-badge">BETA</span>
      </footer>
    </aside>
  );
}
