import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  type AddedPassIntent,
  type AssembledDocument,
  type AssembledPage,
  type BlankSummary,
  type DomainError,
  type SessionEdits,
  type SessionSnapshot,
  type Snapshot,
} from '@shared';
import type { ToastAction } from '../components/Toast';
import { AddModal, anchorsOf } from '../modals/AddModal';
import { NewScanModal } from '../modals/NewScanModal';
import { RevertModal } from '../modals/RevertModal';
import { SaveModal } from '../modals/SaveModal';
import {
  deleted,
  dividerAfterMove,
  grouped,
  markedNotBlank,
  moved,
  movedAcross,
  renamed,
  REVERTED,
  rotated,
  rotatedBacks,
  withCut,
  withoutCut,
  type DropSide,
  type RotateDirection,
  type SetSide,
} from '../state/edits';
import { toneOf } from '../state/page-text';
import { errorTextInline } from '../state/error-text';
import type { EditState } from '../state/history';
import { originKindOf, originsOf } from '../state/origins';
import { rolesOf } from '../state/screen';
import { rotateRowOf, useRotateTarget } from '../state/useRotateTarget';
import {
  afterRemoval,
  collapsed,
  ranged,
  selectionOf,
  single,
  targetsOf,
  toggled,
} from '../state/selection';
import { assembleBlockOf, assembleBlockText } from '../state/assemble-block';
import { shownDocumentsOf, shownOf, withHiddenTails } from '../state/shown';
import { EditorInspector } from './EditorInspector';
import { EditorPassBanner } from './EditorPassBanner';
import { EditorPreview } from './EditorPreview';
import { docNameId, EditorRail, focusThumb } from './EditorRail';
import { EditorRailFooter } from './EditorRailFooter';
import { EditorStatusBar } from './EditorStatusBar';
import { EditorToolbar } from './EditorToolbar';
import type { PickMode } from './EditorThumb';
import { useEditorAssemble } from './useEditorAssemble';
import { useEditorEdits } from './useEditorEdits';
import { SAVE_TOAST_MS, useEditorSaving } from './useEditorSaving';
import { useLateHidden } from './useLateHidden';
import './editor-screen.css';

// Экран `editor` (план M1, U24; M2, U9; M3, U7–U8; UI_SPEC раздел 6; handoff M3, S1–S15):
// тулбар с документом текущей страницы и правой зоной сохранения, лента группами по документам
// из снимка (AE1: 1л, 1о, 2л, 2о, …; `EditorRail`), превью под углом из ядра, статус-бар с
// поворотом и удалением, инспектор с плашкой правок, тумблер 180° внизу ленты, плашка
// прерванного прохода. Каждая правка — перенос, поворот, удаление, граница, имя, тумблер,
// «Вернуть» — один `setEdits` и один шаг undo (KTD-3); ленту считает только ядро (KTD-2).
// Модалки `save`, `newscan`, `revert`, `add` — одна за раз (M3, U9; handoff M3, S14, S16, S17;
// M3.5, S1–S2: «+ Добавить» с причинами недоступности, якорь — из видимой ленты, KTD-8).
// Режим раздельных наборов (M3.6; handoff M3.6, S1–S5, S13): лента из двух групп по
// `assembly.sets`, тулбар с живыми счётчиками и «Собрать документ» вместо «Сохранить»; перенос
// через границу — правка порядка с явной границей (`dividerAfterMove`, `movedAcross`, KTD8);
// сборка — команда `assemble` напрямую, не шаг undo (KTD5): запись сборки входит в подпись ленты.
// Пустые обороты (M4; handoff M4, S1–S13): экран живёт по показанной ленте — без скрытых, пока
// переключатель «добавить пустые» выключен (состояние экрана, не правка); правки считаются по
// полной ленте, скрытые хвосты едут за лицом (KTD4, R11–R13); «Это не пустая страница» —
// правка `notBlank` (KTD5); поздние оценки прячут страницу с тостом (KTD6).

export interface EditorScreenProps {
  readonly snapshot: Snapshot;
  readonly session: SessionSnapshot;
  /**
   * Текущая страница при монтировании (M3.5, S9): первая добавленная после посадки набора —
   * лента прокручивается к ней; `null` — первая в ленте, как всегда.
   */
  readonly initialCurrent: string | null;
  /** Отказ последнего досканирования — строка в плашке S17; живёт в App: экран уходит. */
  readonly resumeFailure: DomainError | null;
  /** «Досканировать остаток»: тот же `startPass` — сессия есть, ядро продолжит проход. */
  readonly onResume: () => void;
  /** «Начать скан» из модалки `add`: `startPass` с намерением и якорем (M3.5, KTD-5; M4.5, R4). */
  readonly onAdd: (kind: AddedPassIntent['kind'], after: string | null) => void;
  /** Ссылка «подключите заново» в отказе досканирования (S17). */
  readonly onOpenDevice: (initialAddress?: string) => void;
  /**
   * Тосты живут в App (новый гасит предыдущий); сохранение показывает их дольше обычного, а
   * тост полного успеха несёт кнопку «Открыть папку» (S18 M3, пересмотр M3.5 S10).
   */
  readonly onToast: (text: string, durationMs?: number, action?: ToastAction) => void;
}

/**
 * `saveThenNew` — `save`, открытая из `newscan` («Сначала сохранить текущий»): после полного
 * успеха сессия закрывается.
 */
type EditorModal = 'save' | 'saveThenNew' | 'newscan' | 'revert' | 'add';

/** Пустая лента без сборки: стабильные ссылки для мемоизации. */
const NO_PAGES: readonly AssembledPage[] = [];
const NO_DOCUMENTS: readonly AssembledDocument[] = [];
const NO_BLANK: BlankSummary = { mode: 'keep', found: 0, hidden: 0, pending: 0 };

/** Сегодняшняя дата для имени по умолчанию — локальная, не UTC (как имя файла в M2). */
const todayStamp = (): string => new Intl.DateTimeFormat('sv-SE').format(new Date());

/** Типы `<input>`, где Ctrl+Z и Delete — текстовые: ленточные сочетания их не перехватывают. */
const NON_TEXT_INPUTS: readonly string[] = ['checkbox', 'radio', 'button', 'submit', 'reset'];

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLInputElement) {
    return !NON_TEXT_INPUTS.includes(target.type);
  }
  return target instanceof HTMLTextAreaElement || target.isContentEditable;
}

/**
 * Буква сочетания с Ctrl: по `key` для латиницы, иначе по физической клавише — в русской
 * раскладке Ctrl+Z приходит с `key` «я».
 */
function shortcutLetter(event: globalThis.KeyboardEvent): string {
  const key = event.key.toLowerCase();
  if (/^[a-z]$/u.test(key)) {
    return key;
  }
  return event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : key;
}

export function EditorScreen({
  snapshot,
  session,
  initialCurrent,
  resumeFailure,
  onResume,
  onAdd,
  onOpenDevice,
  onToast,
}: EditorScreenProps): ReactNode {
  const { t } = useTranslation();

  // Лента и документы — готовыми из снимка (KTD-2): renderer ничего не пересчитывает.
  const order = snapshot.assembly?.order ?? NO_PAGES;
  const documents = snapshot.assembly?.documents ?? NO_DOCUMENTS;
  const fullTotal = order.length;
  const visible = useMemo(() => order.map((entry) => entry.key), [order]);
  const positions = useMemo(() => new Map(visible.map((key, index) => [key, index])), [visible]);
  const blank = snapshot.assembly?.blank ?? NO_BLANK;
  // Показанная лента (M4, KTD4; handoff M4, S1–S3): без скрытых пустых оборотов, пока
  // переключатель «добавить пустые» выключен. Переключатель — состояние экрана: не правка, не
  // шаг undo, сбрасывается с перемонтированием (R13). Текущая, выделение, клавиатура, нумерация,
  // счётчики и якоря — по показанной; правки — по полной (`visible`), позиции переводятся.
  const [reveal, setReveal] = useState(false);
  const shown = useMemo(() => shownOf(order, reveal), [order, reveal]);
  const shownKeys = useMemo(() => shown.map((entry) => entry.key), [shown]);
  const shownPositions = useMemo(
    () => new Map(shownKeys.map((key, index) => [key, index])),
    [shownKeys],
  );
  const total = shown.length;
  const allHidden = total === 0 && fullTotal > 0;
  const shownDocuments = useMemo(
    () => shownDocumentsOf(documents, order, shown),
    [documents, order, shown],
  );
  // Что уйдёт в файл и что сотрёт «Новое сканирование» (S14–S15 M4): лента без скрытых
  // независимо от переключателя — он только показывает, в файл не добавляет (R13).
  const fileShown = useMemo(() => (reveal ? shownOf(order, false) : shown), [order, reveal, shown]);
  const fileTotal = fileShown.length;
  const fileDocuments = useMemo(
    () => (reveal ? shownDocumentsOf(documents, order, fileShown) : shownDocuments),
    [documents, order, fileShown, reveal, shownDocuments],
  );
  /** Ключи с хвостами скрытых (R12) — пока скрытые не показаны; иначе буквально. */
  const withTails = (keys: readonly string[]): readonly string[] =>
    reveal ? keys : withHiddenTails(keys, order);
  // Режим сборки и группы — из ядра (M3.6, R10): renderer ничего не считает сам.
  const mode = snapshot.assembly?.report.mode ?? 'pairs';
  const sets = snapshot.assembly?.sets ?? null;
  // Происхождение страницы — роль прохода по ключу: тег «об», факт «Откуда» и слова страницы пары
  // (R11, R23; M4.5).
  const origins = useMemo(() => originsOf(session.passes), [session.passes]);

  const [modal, setModal] = useState<EditorModal | null>(null);
  /** Идёт запись пакета (модалка `save`): правки заблокированы (KTD-9). */
  const [saving, setSaving] = useState(false);
  // «Собрать документ» (M3.6, KTD5): пока в полёте — правки заблокированы, как при записи.
  const {
    assembling,
    focusAfterRef: focusAfterAssembleRef,
    assemble: runAssemble,
  } = useEditorAssemble({ mode, blank, onToast });
  const locked = saving || assembling;

  // Правки недоступны на время записи и сборки (KTD-9): правка внутри круга команды легла бы
  // поверх записи сборки устаревшим порядком (ревью M3.6, #6).
  const edits = useEditorEdits({
    seq: snapshot.seq,
    session,
    visible: shownKeys,
    order: visible,
    initialCurrent,
    locked,
    // Правка не записалась — человек должен знать, что лента осталась прежней. Текст ошибки
    // длинный — показывается столько же, сколько ошибка сохранения.
    onFailed: (error) => {
      onToast(
        error === null
          ? t('toast.editNoResponse')
          : t('toast.editFailed', { error: errorTextInline(t, error) }),
        SAVE_TOAST_MS,
      );
    },
  });
  const { selection, setSelection } = edits;
  /** Позиция текущей в показанной ленте; `currentFull` — в полной (документы, правки). */
  const currentIndex =
    selection.current === null ? -1 : (shownPositions.get(selection.current) ?? -1);
  const currentFull = selection.current === null ? -1 : (positions.get(selection.current) ?? -1);
  const currentEntry = shown[currentIndex];
  const targets = targetsOf(selection);
  /** Новое состояние с текущим тумблером: большинство жестов его не трогает. */
  const withEdits = (next: SessionEdits): EditState => ({
    edits: next,
    rotate180: edits.current.rotate180,
  });

  // Документ текущей страницы — по отрезкам сборки.
  const currentDocument =
    currentFull < 0
      ? null
      : documents.findIndex(
          (doc) => currentFull >= doc.start && currentFull < doc.start + doc.count,
        );
  const currentDoc = currentDocument === null ? undefined : documents[currentDocument];
  const currentShownDoc = currentDocument === null ? undefined : shownDocuments[currentDocument];

  // Имя по умолчанию: одиночный документ — «Скан ГГГГ-ММ-ДД», иначе «Документ N» (S3).
  const [today] = useState(todayStamp);
  const defaultNames = useMemo(
    () =>
      Array.from({ length: documents.length }, (_, index) =>
        documents.length === 1
          ? t('editor.doc.defaultSingleName', { date: today })
          : t('editor.doc.defaultName', { number: index + 1 }),
      ),
    [documents.length, today, t],
  );
  const names = useMemo(
    () => documents.map((doc, index) => (doc.name !== '' ? doc.name : (defaultNames[index] ?? ''))),
    [documents, defaultNames],
  );

  // Стрелки двигают текущую по всей ленте — фокус следует за ней (роуминг tabindex). После
  // удаления с клавиатуры фокус уходит на страницу, вставшую на место удалённой; после
  // постановки границы — в поле имени нового документа, текст выделен (handoff M3, Границы).
  const railRef = useRef<HTMLElement>(null);
  // Посадка добавленного набора (S9): первая добавленная — текущая и в фокусе, `focus()` сам
  // прокручивает к ней ближайшим краем, без анимации (handoff, «Движение»).
  const focusKey = useRef<string | null>(initialCurrent);
  const focusAfterEdit = useRef(false);
  const focusName = useRef<number | null>(null);
  // S7 M4: все показанные страницы скрыты — фокус на переключателе «добавить пустые», один раз
  // на вход в это состояние.
  const blankToggleRef = useRef<HTMLInputElement>(null);
  const allHiddenFocused = useRef(false);
  useEffect(() => {
    if (!allHidden) {
      allHiddenFocused.current = false;
    } else if (!allHiddenFocused.current) {
      allHiddenFocused.current = true;
      blankToggleRef.current?.focus();
      return;
    }
    if (focusName.current !== null && !edits.busy) {
      const field = railRef.current?.querySelector<HTMLInputElement>(
        `#${docNameId(focusName.current)}`,
      );
      focusName.current = null;
      field?.focus();
      field?.select();
      return;
    }
    let key = focusKey.current;
    if (key === null && focusAfterEdit.current && !edits.busy) {
      focusAfterEdit.current = false;
      key = selection.current;
    }
    if (key === null && focusAfterAssembleRef.current && mode === 'assembled') {
      focusAfterAssembleRef.current = false;
      key = selection.current;
    }
    if (key !== null) {
      focusThumb(railRef.current, key);
      focusKey.current = null;
    }
  });

  const focusInRail = (): boolean => railRef.current?.contains(document.activeElement) ?? false;

  /** Ключ показанной ленты по позиции, прижатой к краям. */
  const keyAt = (index: number): string | undefined =>
    shownKeys[Math.min(Math.max(index, 0), total - 1)];

  const selectAt = (index: number, focus: boolean): void => {
    const key = keyAt(index);
    if (key !== undefined) {
      setSelection(single(key));
      if (focus) {
        focusKey.current = key;
      }
    }
  };

  // Клик, Shift+клик, Ctrl+клик (S4). Миниатюра получает стабильный обработчик — `memo` не
  // перерисовывает всю ленту при смене выделения; свежие выделение и лента — через ref.
  const pickRef = useRef<(key: string, mode: PickMode) => void>(() => undefined);
  useLayoutEffect(() => {
    pickRef.current = (key, mode) => {
      setSelection(
        mode === 'range'
          ? ranged(selection, key, shownKeys)
          : mode === 'toggle'
            ? toggled(selection, key, shownKeys)
            : single(key),
      );
    };
  });
  const pick = useCallback((key: string, mode: PickMode) => {
    pickRef.current(key, mode);
  }, []);

  const railKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    // Esc — выделение сжимается до текущей, откуда бы в ленте ни нажали.
    if (event.key === 'Escape') {
      setSelection(collapsed(selection));
      return;
    }
    // Остальное — только на миниатюрах: стрелки на кнопках панели выделения и тумблере не
    // должны уводить фокус в ленту.
    if (!(event.target instanceof Element) || event.target.closest('[role="option"]') === null) {
      return;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    if (event.key === ' ' && ctrl) {
      event.preventDefault();
      if (selection.current !== null) {
        const next = toggled(selection, selection.current, shownKeys);
        setSelection(next);
        focusKey.current = next.current;
      }
      return;
    }
    let target: number;
    switch (event.key) {
      // ↑/↓ — синонимы ←/→: скринридеры ждут вертикальных стрелок у listbox.
      case 'ArrowLeft':
      case 'ArrowUp':
        target = currentIndex - 1;
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        target = currentIndex + 1;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = total - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const key = keyAt(target);
    if (key === undefined) {
      return;
    }
    // Shift — диапазон от якоря; без него выделение сжимается до новой текущей.
    setSelection(event.shiftKey ? ranged(selection, key, shownKeys) : single(key));
    focusKey.current = key;
  };

  // «↻» +90° / «↺» −90° (M3.5, KTD-11) — текущей или всему выделению, один шаг; тоста нет —
  // поворот виден (S9).
  const rotate = (direction: RotateDirection): void => {
    if (targets.length > 0) {
      edits.edit(withEdits(rotated(edits.current.edits, targets, direction)), targets);
    }
  };

  // Удаление — пометка, без подтверждения: тост подсказывает Ctrl+Z (S9). Текущей после
  // удаления становится страница, вставшая на место удалённой. Скрытый хвост уходит вместе с
  // лицом одним шагом (R12); тост и кнопка считают только показанные.
  const remove = (fromRail: boolean): void => {
    if (targets.length === 0) {
      return;
    }
    const before = shownKeys;
    const removing = withTails(targets);
    const sent = edits.edit(withEdits(deleted(edits.current.edits, visible, removing)), removing, {
      select: (after) => afterRemoval(before, targets, after),
      onSuccess: () => {
        onToast(
          targets.length === 1
            ? t('toast.deletedOne')
            : t('toast.deletedMany', { count: targets.length }),
        );
      },
    });
    if (sent && fromRail) {
      focusAfterEdit.current = true;
    }
  };

  /** Перенос ушёл: выделены перенесённые страницы на новом месте, текущая — прежняя. */
  const sendMove = (next: SessionEdits, keys: readonly string[]): void => {
    const current = selection.current;
    const fromRail = focusInRail();
    const sent = edits.edit(withEdits(next), keys, {
      select: (after) => {
        const chosen = selectionOf(keys, after);
        return chosen !== null && current !== null && chosen.keys.includes(current)
          ? { ...chosen, current, anchor: current }
          : chosen;
      },
    });
    // Миниатюра, сменившая группу, перемонтируется — фокус вернётся на текущую после снимка.
    if (sent && fromRail) {
      focusAfterEdit.current = true;
    }
  };

  // Перенос (S6): группа — с внутренним порядком ленты; бросок на исходное место — шага нет.
  // В режиме наборов (M3.6, KTD8) перенесённые берут группу страницы-цели: граница считается
  // здесь и уходит тем же `setEdits`, что порядок, — один шаг undo. Крайняя страница, брошенная
  // «через границу» рядом с собой, порядок не меняет, а группу — да: шлётся одна граница.
  // Скрытые хвосты (R12 M4): едут за перенесёнными, а бросок «после» показанной страницы ложится
  // за её хвостом — лист не разрывается.
  const move = (keys: readonly string[], target: string, side: DropSide): void => {
    const targetIndex = positions.get(target);
    if (targetIndex === undefined || keys.includes(target)) {
      return;
    }
    const moving = withTails(keys);
    const anchor = side === 'after' ? (withTails([target]).at(-1) ?? target) : target;
    const base = moved(edits.current.edits, visible, moving, anchor, side);
    let next: SessionEdits | null = base;
    if (sets !== null) {
      const divider = dividerAfterMove(visible, sets.divider, moving, targetIndex);
      if (base !== null || divider !== sets.divider) {
        next = { ...(base ?? edits.current.edits), divider };
      }
    }
    if (next !== null) {
      sendMove(next, moving);
    }
  };

  // Бросок на разделитель наборов или в пустую группу (S2–S3 M3.6): только граница, порядок —
  // если выделение к ней не прилегало.
  const moveAcross = (keys: readonly string[], side: SetSide): void => {
    if (sets === null) {
      return;
    }
    const next = movedAcross(edits.current.edits, visible, sets.divider, keys, side);
    if (next !== null) {
      sendMove(next, keys);
    }
  };

  /**
   * После постановки границы — фокус в поле имени нового документа (номер с нуля); `keys` —
   * страницы, которые выделит Ctrl+Z (группировка не подряд переносит их).
   */
  const editBoundary = (
    next: SessionEdits,
    docIndex: number,
    onSuccess?: () => void,
    keys: readonly string[] = [],
  ): void => {
    edits.edit(withEdits(next), keys, {
      onSuccess: () => {
        focusName.current = docIndex;
        onSuccess?.();
      },
    });
  };

  // Граница перед позицией показанной ленты: split-бар, кнопка тулбара (S7, S1). Разрез ложится
  // перед показанной страницей в полной ленте — хвост предыдущей остаётся слева (R12 M4). Новый
  // документ — тот, что начинается с этой позиции.
  const split = (position: number): void => {
    const key = shownKeys[position];
    const full = key === undefined ? undefined : positions.get(key);
    if (full === undefined) {
      return;
    }
    const next = withCut(edits.current.edits, full, fullTotal);
    if (next !== null) {
      editBoundary(next, next.cuts.indexOf(full) + 1);
    }
  };

  // Снять границу: «✕» разделителя или split-бар (S2, S7); имя уходит вместе с ней (R12).
  // «✕» исчезает вместе с разделителем — фокус клавиатуры переходит на текущую страницу.
  const unsplit = (docIndex: number, fromDivider: boolean): void => {
    const sent = edits.edit(withEdits(withoutCut(edits.current.edits, docIndex)), []);
    if (sent && fromDivider) {
      focusAfterEdit.current = true;
    }
  };

  // Клик по документу в списке ДОКУМЕНТЫ: текущей становится его первая показанная страница;
  // документ из одних скрытых показать нечем.
  const pickDocument = (index: number): void => {
    const target = shownDocuments[index];
    const first = target === undefined || target.count === 0 ? undefined : shownKeys[target.start];
    if (first !== undefined) {
      setSelection(single(first));
    }
  };

  // Имя документа (S3): фиксация по Enter или уходу фокуса, один шаг; без изменений — ничего.
  const rename = (docIndex: number, name: string): boolean => {
    const next = renamed(edits.current.edits, docIndex, name);
    return next !== edits.current.edits && edits.edit(withEdits(next), []);
  };

  // «Выделить в документ» (S6 M4, KTD7): подряд — границы до и после куска одним шагом; не
  // подряд — выделенные встают на место первой и получают границы, тоже одним шагом (перенос:
  // Ctrl+Z выделит их). Подряд — по полной ленте с хвостами скрытых (R12 M4).
  const group = (): void => {
    const keys = withTails(selection.keys);
    const result = grouped(edits.current.edits, visible, keys);
    if (result === null) {
      return;
    }
    const reordered = result.edits.order === edits.current.edits.order ? [] : keys;
    editBoundary(
      result.edits,
      result.document,
      () => {
        onToast(t('toast.docCreated', { count: selection.keys.length }));
      },
      reordered,
    );
  };

  // «Это не пустая страница» (S9 M4, KTD5): правка одним шагом — страница становится обычной,
  // секция уходит, фокус на карточке текущей; обратного действия нет — Ctrl+Z или «Вернуть».
  const markNotBlank = (): void => {
    const key = selection.current;
    if (key === null) {
      return;
    }
    const sent = edits.edit(withEdits(markedNotBlank(edits.current.edits, key)), [key], {
      select: () => single(key),
      onSuccess: () => {
        onToast(t('toast.notBlank'));
      },
    });
    if (sent) {
      focusAfterEdit.current = true;
    }
  };

  // «Вернуть всё» (S14): пустые правки и выключенный тумблер одним шагом; Ctrl+Z вернёт всё.
  const revert = (): void => {
    setModal(null);
    const sent = edits.edit(REVERTED, [], {
      onSuccess: () => {
        onToast(t('toast.reverted'));
      },
    });
    // Плашка с «Вернуть» исчезнет — фокус клавиатуры уходит на текущую страницу.
    if (sent) {
      focusAfterEdit.current = true;
    }
  };

  // Тулбар (S1): «+ Новый документ с этой страницы» — если текущая не первая и границы перед
  // ней ещё нет; в режиме наборов документов нет (R17). Начало документа — по показанной ленте.
  const atDocStart = currentShownDoc?.start === currentIndex;
  const canSplitHere = sets === null && currentIndex > 0 && !atDocStart;

  // Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z, Delete — на всём экране, кроме текстовых полей и модалок
  // (handoff M3, Undo/Redo). Подписка — одна на монтирование: StrictMode её переживает.
  const shortcut = useEffectEvent((event: globalThis.KeyboardEvent) => {
    const ctrl = event.ctrlKey || event.metaKey;
    const letter = ctrl ? shortcutLetter(event) : '';
    // Зажатая Delete не удаляет страницу за страницей — одно нажатие, одно удаление.
    const deleteKey = event.key === 'Delete' && !ctrl && !event.shiftKey && !event.repeat;
    // Чужие клавиши отсеиваются до поиска модалки в DOM.
    if (letter !== 'z' && letter !== 'y' && !deleteKey) {
      return;
    }
    if (
      event.defaultPrevented ||
      event.altKey ||
      modal !== null ||
      isTextField(event.target) ||
      document.querySelector('[aria-modal="true"]') !== null
    ) {
      return;
    }
    if (letter === 'z' || letter === 'y') {
      event.preventDefault();
      // Откат может перегруппировать ленту — фокус из ленты вернётся на текущую после снимка.
      const fromRail = focusInRail();
      const sent = letter === 'z' && !event.shiftKey ? edits.undo() : edits.redo();
      if (sent && fromRail) {
        focusAfterEdit.current = true;
      }
      return;
    }
    event.preventDefault();
    remove(focusInRail());
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent): void => {
      shortcut(event);
    };
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
    };
  }, []);

  // Тумблер 180° — у прохода оборотов пачки текущей страницы (M4.5, KTD4; R16): основной
  // документ или набор «ДN», роль по `kind` (KTD-4). Тумблер — правка (KTD-3, S15): шаг undo с
  // текущими правками снимка; при отказе команда ничего не меняет, чекбокс вернётся по снимку.
  const rotateTarget = useRotateTarget(session.passes, currentEntry?.addedSet);
  const setRotate = (event: ChangeEvent<HTMLInputElement>): void => {
    if (rotateTarget !== null && rotateTarget.kind !== 'none') {
      edits.edit(rotatedBacks(edits.current, rotateTarget.pass, event.target.checked), []);
    }
  };

  // Сохранение и закрытие сессии (S16–S18) — хук; модалка `save` закрывается до тоста.
  const { closeSession, renameDocuments, saved } = useEditorSaving({
    edits,
    withEdits,
    thenNew: modal === 'saveThenNew',
    onSaved: () => {
      setModal(null);
    },
    onToast,
  });

  // «Новое сканирование»: сессия без страниц — ни ленты, ни удалённых — закрывается без
  // вопросов, иначе модалка `newscan` (S17).
  const deletedCount = snapshot.assembly?.deleted ?? 0;
  const newScan = (): void => {
    if (fullTotal === 0 && deletedCount === 0) {
      closeSession();
      return;
    }
    setModal('newscan');
  };

  // «+ Добавить» (S1 M3.5, R12): недоступна при записи, правке в полёте и прерванном последнем
  // проходе — первая причина по порядку, в `title`; пустая лента — доступна (набор в конец).
  const lastInterrupted = session.passes.at(-1)?.state === 'interrupted';
  const addDisabledReason = (
    [
      [saving, 'saving'],
      [edits.busy, 'busy'],
      [lastInterrupted, 'interrupted'],
    ] as const
  ).find(([on]) => on)?.[1];

  // «Собрать документ» (S4–S5 M3.6, R19): доступна при равных ненулевых счётчиках групп и без
  // причин по порядку таблицы; до ответа команды — недоступна, повторные клики игнорируются.
  const assembleBlock = assembleBlockOf({
    saving,
    busy: edits.busy,
    interrupted: lastInterrupted,
    sets,
  });
  const assembleTitle =
    assembleBlock === undefined || sets === null
      ? undefined
      : assembleBlockText(t, assembleBlock, sets);
  const assemble = (): void => {
    if (assembling || assembleBlock !== undefined || sets === null) {
      return;
    }
    runAssemble(sets.fronts);
  };
  // Поздние оценки (S13 M4, KTD6): снимок спрятал показанную страницу вердиктом — тост; о
  // скрытых после сборки наборов уже сказал тост сборки.
  const { notBlank } = session.edits;
  useLateHidden({
    order,
    mode,
    reveal,
    onHidden: (count) => {
      onToast(t('toast.blankHidden', { count }));
      // Спряталась карточка с фокусом — она размонтирована, фокус упал на body; текущая уже
      // переехала (`pruned`) — вернуть фокус на неё, чтобы клавиатура не потерялась.
      if (document.activeElement === document.body && selection.current !== null) {
        focusThumb(railRef.current, selection.current);
      }
    },
  });

  /** Номер страницы в показанной ленте; у скрытой — номер её показанного лица (слева). */
  const numberOf = (key: string): number => {
    for (let index = positions.get(key) ?? -1; index >= 0; index -= 1) {
      const shownIndex = shownPositions.get(visible[index] ?? '');
      if (shownIndex !== undefined) {
        return shownIndex + 1;
      }
    }
    return 0;
  };

  // Якоря для модалки — только пока она открыта (KTD-8). «После текущей» — за её скрытым хвостом
  // (R12 M4), номера — по показанной ленте.
  const anchors =
    modal === 'add'
      ? anchorsOf(t, {
          entry: currentEntry,
          index: currentFull,
          document: currentDoc,
          documentName: currentDocument === null ? '' : (names[currentDocument] ?? ''),
          visible,
          mode,
          sets,
          origin: originKindOf(origins, currentEntry?.key),
          after: selection.current === null ? undefined : withTails([selection.current]).at(-1),
          numberOf,
        })
      : null;

  /** Подпись инструмента по выделению: «Повернуть 3 стр. …» или «Повернуть …». */
  const countLabel = (key: 'editor.rotate' | 'editor.rotateLeft' | 'editor.delete'): string =>
    targets.length > 1 ? t(`${key}Many`, { count: targets.length }) : t(key);
  const rotateLabel = countLabel('editor.rotate');
  const rotateLeftLabel = countLabel('editor.rotateLeft');
  const deleteLabel = countLabel('editor.delete');

  // Клик по поверхности мимо ленты — тулбар, превью, инспектор — сжимает мультивыделение до
  // текущей, как Esc (M3.5, R21). Органы управления на этих поверхностях исключены: «↻» и
  // «Удалить N стр.» действуют на выделение, и сжимать его в момент нажатия нельзя.
  const collapseOnSurfaceClick = (event: ReactMouseEvent<HTMLElement>): void => {
    const { target } = event;
    if (
      event.button === 0 &&
      selection.keys.length > 1 &&
      target instanceof Element &&
      target.closest('button, input, textarea, select, label, a') === null
    ) {
      setSelection(collapsed(selection));
    }
  };

  return (
    <main className="editor-screen">
      <EditorToolbar
        total={total}
        saved={session.saved}
        documents={shownDocuments}
        names={names}
        currentIndex={currentIndex}
        currentDocument={currentDocument}
        sets={sets}
        addDisabledReason={addDisabledReason}
        assembleDisabled={assembleBlock !== undefined || assembling}
        assembleTitle={assembleTitle}
        canSplitHere={canSplitHere}
        saving={saving}
        onNewScan={newScan}
        onAdd={() => {
          setModal('add');
        }}
        onSplit={() => {
          split(currentIndex);
        }}
        onAssemble={assemble}
        onSave={() => {
          setModal('save');
        }}
        onMouseDown={collapseOnSurfaceClick}
      />

      <div className="editor-screen__body">
        <EditorRail
          sessionId={session.id}
          order={shown}
          documents={shownDocuments}
          allHidden={allHidden}
          sets={sets}
          origins={origins}
          defaultNames={defaultNames}
          selection={selection}
          locked={locked}
          busy={edits.busy}
          railRef={railRef}
          onKeyDown={railKeyDown}
          onPick={pick}
          onSelect={setSelection}
          onSplit={split}
          onUnsplit={unsplit}
          onRename={rename}
          onMove={move}
          onMoveAcross={moveAcross}
          footer={
            // S4–S6 M4: панель выделения (больше одной показанной), переключатель «добавить
            // пустые» и тумблер 180° — у прохода оборотов.
            <EditorRailFooter
              selection={
                selection.keys.length > 1
                  ? {
                      count: selection.keys.length,
                      // «Выделить в документ» — только вне режима наборов (M3.6, KTD8).
                      group: sets === null ? { disabled: locked, onClick: group } : null,
                      onClear: () => {
                        // Панель исчезнет вместе с кнопкой — фокус переходит на текущую страницу.
                        setSelection(collapsed(selection));
                        focusKey.current = selection.current;
                      },
                    }
                  : null
              }
              blank={blank}
              inSets={sets !== null}
              reveal={reveal}
              toggleRef={blankToggleRef}
              onReveal={setReveal}
              rotate={rotateRowOf(t, rotateTarget, edits.current.rotate180, saving, setRotate)}
            />
          }
        />

        <section className="stage" onMouseDown={collapseOnSurfaceClick}>
          <EditorPassBanner
            snapshot={snapshot}
            session={session}
            resumeFailure={resumeFailure}
            onResume={onResume}
            onOpenDevice={onOpenDevice}
            onNewScan={newScan}
          />
          {currentEntry === undefined ? (
            // S10: все страницы удалены — подсказка, как вернуть; S7 M4: все показанные скрыты —
            // подсказка про переключатель.
            (fullTotal === 0 || allHidden) && (
              <div className="stage__empty">
                <h2 className="stage__empty-title">
                  {t(allHidden ? 'editor.empty.blankTitle' : 'editor.empty.title')}
                </h2>
                <p className="stage__empty-text">
                  {t(allHidden ? 'editor.empty.blankText' : 'editor.empty.text')}
                </p>
              </div>
            )
          ) : (
            <div className="preview">
              <EditorPreview
                key={currentEntry.key}
                sessionId={session.id}
                entry={currentEntry}
                position={currentIndex + 1}
                docStart={
                  currentDocument !== null && currentDocument > 0 && atDocStart
                    ? currentDocument + 1
                    : null
                }
                tone={toneOf(currentDocument ?? 0)}
                blank={currentEntry.blank}
              />
            </div>
          )}
          <EditorStatusBar
            total={total}
            currentIndex={currentIndex}
            locked={locked}
            rotateLabel={rotateLabel}
            rotateLeftLabel={rotateLeftLabel}
            deleteLabel={deleteLabel}
            onStep={(delta) => {
              selectAt(currentIndex + delta, false);
            }}
            onRotate={rotate}
            onRemove={() => {
              remove(false);
            }}
          />
        </section>

        {snapshot.assembly !== null && (
          <EditorInspector
            assembly={snapshot.assembly}
            documents={shownDocuments}
            entry={currentEntry}
            position={currentIndex + 1}
            origin={originKindOf(origins, currentEntry?.key)}
            currentDocument={currentDocument}
            names={names}
            frontsOnly={rolesOf(session.passes).backs === null}
            notBlank={currentEntry !== undefined && notBlank.includes(currentEntry.key)}
            locked={locked}
            onPickDocument={pickDocument}
            onNotBlank={markNotBlank}
            onRevert={() => {
              setModal('revert');
            }}
            onMouseDown={collapseOnSurfaceClick}
          />
        )}
      </div>

      {(modal === 'save' || modal === 'saveThenNew') && (
        <SaveModal
          documents={fileDocuments}
          defaultNames={defaultNames}
          singleDefault={t('editor.doc.defaultSingleName', { date: today })}
          total={fileTotal}
          blank={blank}
          onRename={renameDocuments}
          editsBusy={edits.busy}
          onWriting={setSaving}
          onNeedCuts={() => {
            onToast(t('toast.needCuts'));
          }}
          onSaved={saved}
          onClose={() => {
            setModal(null);
          }}
        />
      )}
      {modal === 'newscan' && (
        <NewScanModal
          total={fileTotal}
          hidden={blank.hidden}
          deleted={deletedCount}
          saved={session.saved}
          unassembled={mode === 'sets'}
          onSaveFirst={() => {
            setModal('saveThenNew');
          }}
          onClose={() => {
            setModal(null);
          }}
        />
      )}
      {modal === 'revert' && (
        <RevertModal
          onCancel={() => {
            setModal(null);
          }}
          onConfirm={revert}
        />
      )}
      {anchors !== null && (
        <AddModal
          scanner={snapshot.scanner}
          mode={mode}
          current={anchors.current}
          end={anchors.end}
          endKind={anchors.endKind}
          onStart={onAdd}
          onClose={() => {
            setModal(null);
          }}
        />
      )}
    </main>
  );
}
