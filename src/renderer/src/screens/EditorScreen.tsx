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
  type AssembledDocument,
  type AssembledPage,
  type DomainError,
  type SaveDocumentsReport,
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
  moved,
  renamed,
  REVERTED,
  rotated,
  separated,
  withCut,
  withoutCut,
  type DropSide,
  type RotateDirection,
} from '../state/edits';
import { mismatchDue } from '../state/assembly-outcome';
import { toneOf } from '../state/page-text';
import { errorTextInline } from '../state/error-text';
import type { EditState } from '../state/history';
import { rolesOf } from '../state/screen';
import {
  afterRemoval,
  collapsed,
  contiguousRange,
  ranged,
  selectionOf,
  single,
  targetsOf,
  toggled,
} from '../state/selection';
import { EditorInspector } from './EditorInspector';
import { EditorPassBanner } from './EditorPassBanner';
import { EditorPreview } from './EditorPreview';
import { docNameId, EditorRail, focusThumb } from './EditorRail';
import type { PickMode } from './EditorThumb';
import { useEditorEdits } from './useEditorEdits';
import './editor-screen.css';

// Экран `editor` (план M1, U24; M2, U9; M3, U7–U8; UI_SPEC раздел 6; handoff M3, S1–S15):
// тулбар с документом текущей страницы и правой зоной сохранения, лента группами по документам
// из снимка (AE1: 1л, 1о, 2л, 2о, …; `EditorRail`), превью под углом из ядра, статус-бар с
// поворотом и удалением, инспектор с плашкой правок, тумблер 180° внизу ленты, плашка
// прерванного прохода. Каждая правка — перенос, поворот, удаление, граница, имя, тумблер,
// «Вернуть» — один `setEdits` и один шаг undo (KTD-3); ленту считает только ядро (KTD-2).
// Модалки `save`, `newscan`, `revert`, `add` — одна за раз (M3, U9; handoff M3, S14, S16, S17;
// M3.5, S1–S2: «+ Добавить» с причинами недоступности, якорь — из видимой ленты, KTD-8).

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
  /** «Начать скан» из модалки `add`: `startPass` с намерением и якорем (M3.5, KTD-5). */
  readonly onAdd: (after: string | null) => void;
  /** Ссылка «подключите заново» в отказе досканирования (S17). */
  readonly onOpenDevice: (initialAddress?: string) => void;
  /**
   * Тосты живут в App (новый гасит предыдущий); сохранение показывает их дольше обычного, а
   * тост полного успеха несёт кнопку «Открыть папку» (S18 M3, пересмотр M3.5 S10).
   */
  readonly onToast: (text: string, durationMs?: number, action?: ToastAction) => void;
}

/** Тосты сохранения — 6 с (UI_SPEC раздел 8). */
const SAVE_TOAST_MS = 6000;
/** «Сохранено … — можно закладывать новые листы» после «Сначала сохранить текущий» (S17). */
const THEN_NEW_TOAST_MS = 3600;

/**
 * `saveThenNew` — `save`, открытая из `newscan` («Сначала сохранить текущий»): после полного
 * успеха сессия закрывается.
 */
type EditorModal = 'save' | 'saveThenNew' | 'newscan' | 'revert' | 'add';

/** Пустая лента без сборки: стабильные ссылки для мемоизации. */
const NO_PAGES: readonly AssembledPage[] = [];
const NO_DOCUMENTS: readonly AssembledDocument[] = [];

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
  const total = order.length;
  const visible = useMemo(() => order.map((entry) => entry.key), [order]);
  const positions = useMemo(() => new Map(visible.map((key, index) => [key, index])), [visible]);

  const [modal, setModal] = useState<EditorModal | null>(null);
  /** Идёт запись пакета (модалка `save`): правки заблокированы (KTD-9). */
  const [saving, setSaving] = useState(false);

  // Правки недоступны на время записи (KTD-9): ядро их всё равно отклонило бы.
  const edits = useEditorEdits({
    seq: snapshot.seq,
    session,
    visible,
    initialCurrent,
    locked: saving,
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
  const currentIndex = selection.current === null ? -1 : (positions.get(selection.current) ?? -1);
  const currentEntry = order[currentIndex];
  const targets = targetsOf(selection);
  /** Новое состояние с текущим тумблером: большинство жестов его не трогает. */
  const withEdits = (next: SessionEdits): EditState => ({
    edits: next,
    rotate180: edits.current.rotate180,
  });

  // Документ текущей страницы — по отрезкам сборки.
  const currentDocument =
    currentIndex < 0
      ? null
      : documents.findIndex(
          (doc) => currentIndex >= doc.start && currentIndex < doc.start + doc.count,
        );
  const currentDoc = currentDocument === null ? undefined : documents[currentDocument];

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
  useEffect(() => {
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
    if (key !== null) {
      focusThumb(railRef.current, key);
      focusKey.current = null;
    }
  });

  const focusInRail = (): boolean => railRef.current?.contains(document.activeElement) ?? false;

  /** Ключ ленты по позиции, прижатой к краям. */
  const keyAt = (index: number): string | undefined =>
    visible[Math.min(Math.max(index, 0), total - 1)];

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
          ? ranged(selection, key, visible)
          : mode === 'toggle'
            ? toggled(selection, key, visible)
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
        const next = toggled(selection, selection.current, visible);
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
    setSelection(event.shiftKey ? ranged(selection, key, visible) : single(key));
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
  // удаления становится страница, вставшая на место удалённой.
  const remove = (fromRail: boolean): void => {
    if (targets.length === 0) {
      return;
    }
    const before = visible;
    const removing = targets;
    const sent = edits.edit(withEdits(deleted(edits.current.edits, before, removing)), removing, {
      select: (after) => afterRemoval(before, removing, after),
      onSuccess: () => {
        onToast(
          removing.length === 1
            ? t('toast.deletedOne')
            : t('toast.deletedMany', { count: removing.length }),
        );
      },
    });
    if (sent && fromRail) {
      focusAfterEdit.current = true;
    }
  };

  // Перенос (S6): группа — с внутренним порядком ленты; бросок на исходное место — шага нет.
  // После переноса выделены перенесённые страницы на новом месте, текущая — прежняя.
  const move = (keys: readonly string[], target: string, side: DropSide): void => {
    const next = moved(edits.current.edits, visible, keys, target, side);
    if (next === null) {
      return;
    }
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

  /** После постановки границы — фокус в поле имени нового документа (номер с нуля). */
  const editBoundary = (next: SessionEdits, docIndex: number, onSuccess?: () => void): void => {
    edits.edit(withEdits(next), [], {
      onSuccess: () => {
        focusName.current = docIndex;
        onSuccess?.();
      },
    });
  };

  // Граница перед позицией ленты: split-бар, кнопка тулбара (S7, S1). Новый документ — тот,
  // что начинается с этой позиции.
  const split = (position: number): void => {
    const next = withCut(edits.current.edits, position, total);
    if (next !== null) {
      editBoundary(next, next.cuts.indexOf(position) + 1);
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

  // Имя документа (S3): фиксация по Enter или уходу фокуса, один шаг; без изменений — ничего.
  const rename = (docIndex: number, name: string): boolean => {
    const next = renamed(edits.current.edits, docIndex, name);
    return next !== edits.current.edits && edits.edit(withEdits(next), []);
  };

  // «Выделить в документ» (S5): подряд — границы до и после куска одним шагом; иначе тост.
  const group = (): void => {
    const range = contiguousRange(visible, selection.keys);
    if (range === null) {
      onToast(t('toast.notContiguous'));
      return;
    }
    const result = separated(edits.current.edits, range.from, range.to, total);
    editBoundary(result.edits, result.document, () => {
      onToast(t('toast.docCreated', { count: range.to - range.from + 1 }));
    });
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
  // ней ещё нет.
  const atDocStart = currentDoc?.start === currentIndex;
  const canSplitHere = currentIndex > 0 && !atDocStart;

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

  // Тумблер 180° — у прохода оборотов (роль по `kind`, не номер — KTD-4), включая прерванный
  // и принятый; без прохода оборотов тумблера нет (S7). Правило роли — одно на renderer.
  const backsPass = rolesOf(session.passes).backs;
  const setRotate = (event: ChangeEvent<HTMLInputElement>): void => {
    // Тумблер — правка (KTD-3, S15): шаг undo с текущими правками снимка. Снимок — источник
    // правды: при отказе команда не меняет ничего, и чекбокс вернётся сам.
    edits.edit({ edits: edits.current.edits, rotate180: event.target.checked }, []);
  };

  // Закрытие сессии без модалки: пустая сессия и «Сначала сохранить текущий» после записи
  // (`saved` — текст тоста сохранения). Отказ и молчание моста — тостом: сессия цела (S17), а
  // после записи человек должен узнать и то, что файлы сохранены.
  const closeSession = (saved?: string): void => {
    const failed = (reason: string): void => {
      onToast(
        saved === undefined
          ? t('toast.closeFailed', { error: reason })
          : t('toast.savedCloseFailed', { saved, error: reason }),
        SAVE_TOAST_MS,
      );
    };
    window.api.closeSession().then(
      (result) => {
        if (!result.ok) {
          failed(errorTextInline(t, result.error));
          return;
        }
        if (saved !== undefined) {
          onToast(t('toast.savedThenNew', { saved }), THEN_NEW_TOAST_MS);
        }
      },
      (error: unknown) => {
        console.error('[renderer] закрытие сессии не ответило', error);
        failed(t('toast.closeNoResponse'));
      },
    );
  };

  // «Новое сканирование»: сессия без страниц — ни ленты, ни удалённых — закрывается без
  // вопросов, иначе модалка `newscan` (S17).
  const deletedCount = snapshot.assembly?.deleted ?? 0;
  const newScan = (): void => {
    if (total === 0 && deletedCount === 0) {
      closeSession();
      return;
    }
    setModal('newscan');
  };

  // Имена, тронутые в модалке `save`, — в документы одним шагом undo, до записи пакета (S16).
  // Только тронутые: нетронутые строки показывают живые имена, откатывать ими нечего.
  const renameDocuments = (next: ReadonlyMap<number, string>): Promise<boolean> => {
    const target = [...next].reduce(
      (state, [index, name]) => renamed(state, index, name),
      edits.current.edits,
    );
    if (target === edits.current.edits) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const sent = edits.edit(withEdits(target), [], {
        onSuccess: () => {
          resolve(true);
        },
        onFailure: () => {
          resolve(false);
        },
      });
      if (!sent) {
        resolve(false);
      }
    });
  };

  // «Открыть папку» из тоста «Сохранено» (M3.5, KTD-9): команда без входа — папку последнего
  // пакета помнит ядро, путь от renderer не принимается; отказ — тостом ошибки.
  const openSaveFolder = (): void => {
    window.api.openSaveFolder().then(
      (result) => {
        if (!result.ok) {
          onToast(
            t('toast.openFolderFailed', { error: errorTextInline(t, result.error) }),
            SAVE_TOAST_MS,
          );
        }
      },
      (error: unknown) => {
        console.error('[renderer] открытие папки не ответило', error);
      },
    );
  };

  // Пакет записан целиком: тост 6 с с кнопкой «Открыть папку» (S18 M3, пересмотр M3.5 S10:
  // «Новое сканирование» есть в тулбаре). После «Сначала сохранить текущий» — сразу закрытие.
  const saved = (report: SaveDocumentsReport): void => {
    setModal(null);
    const [only] = report.written;
    const text =
      report.written.length === 1 && only !== undefined
        ? t('toast.saved', { file: only.fileName, folder: report.folder })
        : t('toast.savedMany', { count: report.written.length, folder: report.folder });
    if (modal === 'saveThenNew') {
      closeSession(text);
      return;
    }
    onToast(text, SAVE_TOAST_MS, { label: t('toast.openFolder'), onClick: openSaveFolder });
  };

  // «+ Добавить» (S1 M3.5, R12): недоступна при записи, правке в полёте и прерванном последнем
  // проходе — первая причина по порядку, в `title`; пустая лента — доступна (набор в конец).
  const addDisabledReason = (
    [
      [saving, 'saving'],
      [edits.busy, 'busy'],
      [session.passes.at(-1)?.state === 'interrupted', 'interrupted'],
    ] as const
  ).find(([on]) => on)?.[1];
  // Якоря для модалки — только пока она открыта (KTD-8).
  const anchors =
    modal === 'add'
      ? anchorsOf(t, {
          entry: currentEntry,
          index: currentIndex,
          document: currentDoc,
          documentName: currentDocument === null ? '' : (names[currentDocument] ?? ''),
          visible,
          mode: snapshot.assembly?.report.mode ?? 'pairs',
          sets: snapshot.assembly?.sets ?? null,
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
      <header className="editor-screen__toolbar" onMouseDown={collapseOnSurfaceClick}>
        <div className="editor-screen__toolbar-left">
          <button type="button" className="btn btn--secondary" onClick={newScan}>
            <span aria-hidden="true">↺</span> {t('editor.newScan')}
          </button>
          <button
            type="button"
            className="btn btn--secondary editor-screen__add"
            disabled={addDisabledReason !== undefined}
            title={
              addDisabledReason === undefined
                ? undefined
                : t(`editor.addDisabled.${addDisabledReason}`)
            }
            onClick={() => {
              setModal('add');
            }}
          >
            <span className="editor-screen__add-plus" aria-hidden="true">
              +
            </span>{' '}
            {t('editor.add')}
          </button>
        </div>
        {/* S1: документ текущей страницы — тон, имя, позиция. */}
        <div
          className={
            currentDocument === null
              ? 'editor-screen__toolbar-center'
              : `editor-screen__toolbar-center ${toneOf(currentDocument)}`
          }
        >
          {currentDoc === undefined || currentDocument === null ? (
            <span className="editor-screen__doc-title">{t('editor.noPages')}</span>
          ) : (
            <>
              <span className="editor-screen__doc-mark" aria-hidden="true" />
              <span className="editor-screen__doc-title">{names[currentDocument]}</span>
              <span className="editor-screen__doc-pos">
                {documents.length > 1
                  ? t('editor.docPosition', {
                      doc: currentDocument + 1,
                      docs: documents.length,
                      page: currentIndex - currentDoc.start + 1,
                      pages: currentDoc.count,
                    })
                  : t('editor.pagePosition', { page: currentIndex + 1, pages: total })}
              </span>
              {canSplitHere && (
                <button
                  type="button"
                  className="btn btn--tinted editor-screen__split"
                  disabled={saving}
                  onClick={() => {
                    split(currentIndex);
                  }}
                >
                  {t('editor.splitHere')}
                </button>
              )}
            </>
          )}
        </div>
        <div className="editor-screen__toolbar-right">
          {/* S9 M2: точка несохранённого; скрыта, когда набор пуст или сохранён. */}
          {!session.saved && total > 0 && (
            <span
              className="editor-screen__unsaved dot dot--warning"
              role="status"
              title={t('editor.unsaved')}
            >
              <span className="visually-hidden">{t('editor.unsaved')}</span>
            </span>
          )}
          {/* S1: «Сохранить документ» при одном документе, «Сохранить N файлов» при нескольких;
              пустая лента — сохранять нечего. */}
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={total === 0}
            onClick={() => {
              setModal('save');
            }}
          >
            {documents.length > 1
              ? t('editor.saveFiles', { count: documents.length })
              : t('editor.save')}
          </button>
        </div>
      </header>

      <div className="editor-screen__body">
        <EditorRail
          sessionId={session.id}
          order={order}
          documents={documents}
          defaultNames={defaultNames}
          selection={selection}
          locked={saving}
          busy={edits.busy}
          railRef={railRef}
          onKeyDown={railKeyDown}
          onPick={pick}
          onSelect={setSelection}
          onClearSelection={() => {
            // Панель исчезнет вместе с кнопкой — фокус переходит на текущую страницу.
            setSelection(collapsed(selection));
            focusKey.current = selection.current;
          }}
          onGroup={group}
          onSplit={split}
          onUnsplit={unsplit}
          onRename={rename}
          onMove={move}
          footer={
            backsPass !== null && (
              <footer className="rail__footer">
                <label className="toggle-row" title={t('editor.rotateBacksTitle')}>
                  <span className="toggle">
                    <input
                      className="toggle__input"
                      type="checkbox"
                      checked={backsPass.rotate180}
                      disabled={saving}
                      onChange={setRotate}
                    />
                    <span className="toggle__track" aria-hidden="true" />
                  </span>
                  <span className="toggle-row__label">{t('editor.rotateBacks')}</span>
                </label>
              </footer>
            )
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
            // S10: все страницы удалены — подсказка, как вернуть.
            total === 0 && (
              <div className="stage__empty">
                <h2 className="stage__empty-title">{t('editor.empty.title')}</h2>
                <p className="stage__empty-text">{t('editor.empty.text')}</p>
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
              />
            </div>
          )}
          <footer className="stage__statusbar">
            <button
              type="button"
              className="btn btn--icon"
              aria-label={t('editor.prev')}
              disabled={total === 0}
              aria-disabled={total > 0 && currentIndex <= 0 ? true : undefined}
              onClick={() => {
                selectAt(currentIndex - 1, false);
              }}
            >
              ←
            </button>
            <div className="stage__counter">
              {total === 0
                ? t('editor.positionNone')
                : t('editor.position', { current: currentIndex + 1, total })}
            </div>
            <button
              type="button"
              className="btn btn--icon"
              aria-label={t('editor.next')}
              disabled={total === 0}
              aria-disabled={total > 0 && currentIndex >= total - 1 ? true : undefined}
              onClick={() => {
                selectAt(currentIndex + 1, false);
              }}
            >
              →
            </button>
            <span className="stage__divider" aria-hidden="true" />
            <button
              type="button"
              className="btn btn--icon stage__tool"
              aria-label={rotateLeftLabel}
              title={rotateLeftLabel}
              disabled={total === 0 || saving}
              onClick={() => {
                rotate('ccw');
              }}
            >
              ↺
            </button>
            <button
              type="button"
              className="btn btn--icon stage__tool"
              aria-label={rotateLabel}
              title={rotateLabel}
              disabled={total === 0 || saving}
              onClick={() => {
                rotate('cw');
              }}
            >
              ↻
            </button>
            <button
              type="button"
              className="btn btn--icon stage__tool stage__tool--danger"
              aria-label={deleteLabel}
              title={deleteLabel}
              disabled={total === 0 || saving}
              onClick={() => {
                remove(false);
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M2.5 3.6h9" />
                <path d="M5.6 3.6V2.4h2.8v1.2" />
                <path d="M3.7 3.6l.55 7.4h5.5l.55-7.4" />
                <path d="M5.9 5.8v3M8.1 5.8v3" />
              </svg>
            </button>
          </footer>
        </section>

        {snapshot.assembly !== null && (
          <EditorInspector
            assembly={snapshot.assembly}
            entry={currentEntry}
            position={currentIndex + 1}
            currentDocument={currentDocument}
            names={names}
            frontsOnly={backsPass === null}
            pairsHint={mismatchDue(snapshot.assembly.report)}
            locked={saving}
            onPickDocument={(index) => {
              const first = visible[documents[index]?.start ?? -1];
              if (first !== undefined) {
                setSelection(single(first));
              }
            }}
            onRevert={() => {
              setModal('revert');
            }}
            onMouseDown={collapseOnSurfaceClick}
          />
        )}
      </div>

      {(modal === 'save' || modal === 'saveThenNew') && (
        <SaveModal
          documents={documents}
          defaultNames={defaultNames}
          singleDefault={t('editor.doc.defaultSingleName', { date: today })}
          total={total}
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
          total={total}
          deleted={deletedCount}
          saved={session.saved}
          unassembled={snapshot.assembly?.report.mode === 'sets'}
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
