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
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  type AssembledDocument,
  type AssembledPage,
  type DomainError,
  type ScannerInfo,
  type SessionSnapshot,
  type Snapshot,
} from '@shared';
import { NewScanModal } from '../modals/NewScanModal';
import { deleted, rotated } from '../state/edits';
import { errorText, errorTextInline } from '../state/error-text';
import { addressOf, reconnectAddress } from '../state/scanner-address';
import { survivingPasses } from '../state/screen';
import { afterRemoval, collapsed, ranged, single, targetsOf, toggled } from '../state/selection';
import { EditorInspector, toneOf } from './EditorInspector';
import { EditorPreview } from './EditorPreview';
import { EditorThumb, type PickMode } from './EditorThumb';
import { useEditorEdits } from './useEditorEdits';
import './editor-screen.css';

// Экран `editor` (план M1, U24; M2, U9; M3, U7; UI_SPEC раздел 6; handoff M3, S1–S15): тулбар
// с документом текущей страницы и правой зоной сохранения, лента группами по документам из
// снимка (AE1: 1л, 1о, 2л, 2о, …) с мультивыделением, превью под углом из ядра, статус-бар с
// поворотом и удалением, инспектор, тумблер 180° внизу ленты, плашка прерванного прохода.
// Каждая правка — один `setEdits` и один шаг undo (KTD-3); ленту считает только ядро (KTD-2).
// Перетаскивание, границы, имена и плашка правок — U8; модалка `save` — U9.

export interface EditorScreenProps {
  readonly snapshot: Snapshot;
  readonly session: SessionSnapshot;
  /** Отказ последнего досканирования — строка в плашке S17; живёт в App: экран уходит. */
  readonly resumeFailure: DomainError | null;
  /** «Досканировать остаток»: тот же `startPass` — сессия есть, ядро продолжит проход. */
  readonly onResume: () => void;
  /** Ссылка «подключите заново» в отказе досканирования (S17). */
  readonly onOpenDevice: (initialAddress?: string) => void;
  /** Тосты живут в App (новый гасит предыдущий); сохранение показывает их дольше обычного. */
  readonly onToast: (text: string, durationMs?: number) => void;
}

/** Тосты сохранения — 6 с (UI_SPEC раздел 8). */
const SAVE_TOAST_MS = 6000;

/**
 * Коды отказа досканирования, которые лечатся повторным подключением (S17). Список шире, чем
 * у плашки `flip`: досканировать можно только на сканере прохода (KTD-27), поэтому и
 * «не отвечает» ведёт к переподключению.
 */
const RESUME_RECONNECT_CODES: readonly string[] = [
  'scannerUnreachable',
  'scannerCertificateChanged',
];

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
  resumeFailure,
  onResume,
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

  const [newScanOpen, setNewScanOpen] = useState(false);
  const [acceptFailure, setAcceptFailure] = useState<DomainError | null>(null);
  const [saving, setSaving] = useState(false);

  // Правки недоступны на время записи (KTD-9): ядро их всё равно отклонило бы.
  const edits = useEditorEdits({ seq: snapshot.seq, session, visible, locked: saving });
  const { selection, setSelection } = edits;
  const currentIndex = selection.current === null ? -1 : (positions.get(selection.current) ?? -1);
  const currentEntry = order[currentIndex];
  const selectedKeys = useMemo(() => new Set(selection.keys), [selection.keys]);
  const multi = selection.keys.length > 1;
  const targets = targetsOf(selection);

  // Документ текущей страницы — по отрезкам сборки.
  const currentDocument =
    currentIndex < 0
      ? null
      : documents.findIndex(
          (document) =>
            currentIndex >= document.start && currentIndex < document.start + document.count,
        );
  const currentDoc = currentDocument === null ? undefined : documents[currentDocument];

  // Имя по умолчанию: одиночный документ — «Скан ГГГГ-ММ-ДД», иначе «Документ N» (S3).
  const [today] = useState(todayStamp);
  const names = documents.map((document, index) =>
    document.name !== ''
      ? document.name
      : documents.length === 1
        ? t('editor.doc.defaultSingleName', { date: today })
        : t('editor.doc.defaultName', { number: index + 1 }),
  );

  // Стрелки двигают текущую по всей ленте — фокус следует за ней (роуминг tabindex). После
  // удаления с клавиатуры фокус уходит на страницу, вставшую на место удалённой.
  const railRef = useRef<HTMLElement>(null);
  const focusKey = useRef<string | null>(null);
  const focusAfterEdit = useRef(false);
  useEffect(() => {
    let key = focusKey.current;
    if (key === null && focusAfterEdit.current && !edits.busy) {
      focusAfterEdit.current = false;
      key = selection.current;
    }
    if (key !== null) {
      railRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
      focusKey.current = null;
    }
  });

  const focusInRail = (): boolean => railRef.current?.contains(document.activeElement) ?? false;

  const selectAt = (index: number, focus: boolean): void => {
    const key = visible[Math.min(Math.max(index, 0), total - 1)];
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
    const key = visible[Math.min(Math.max(target, 0), total - 1)];
    if (key === undefined) {
      return;
    }
    // Shift — диапазон от якоря; без него выделение сжимается до новой текущей.
    setSelection(event.shiftKey ? ranged(selection, key, visible) : single(key));
    focusKey.current = key;
  };

  // ↻ — +90° по часовой текущей или всему выделению, один шаг; тоста нет — поворот виден (S9).
  const rotate = (): void => {
    if (targets.length > 0) {
      edits.edit(
        { edits: rotated(edits.current.edits, targets), rotate180: edits.current.rotate180 },
        targets,
      );
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
    const sent = edits.edit(
      {
        edits: deleted(edits.current.edits, before, removing),
        rotate180: edits.current.rotate180,
      },
      removing,
      {
        select: (after) => afterRemoval(before, removing, after),
        onSuccess: () => {
          onToast(
            removing.length === 1
              ? t('toast.deletedOne')
              : t('toast.deletedMany', { count: removing.length }),
          );
        },
      },
    );
    if (sent && fromRail) {
      focusAfterEdit.current = true;
    }
  };

  // Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z, Delete — на всём экране, кроме текстовых полей и модалок
  // (handoff M3, Undo/Redo). Подписка — одна на монтирование: StrictMode её переживает.
  const shortcut = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      newScanOpen ||
      isTextField(event.target) ||
      document.querySelector('[aria-modal="true"]') !== null
    ) {
      return;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    const letter = ctrl ? shortcutLetter(event) : '';
    if (letter === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        edits.redo();
      } else {
        edits.undo();
      }
      return;
    }
    if (letter === 'y') {
      event.preventDefault();
      edits.redo();
      return;
    }
    // Зажатая Delete не удаляет страницу за страницей — одно нажатие, одно удаление.
    if (event.key === 'Delete' && !ctrl && !event.shiftKey && !event.repeat) {
      event.preventDefault();
      remove(focusInRail());
    }
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

  const accept = (): void => {
    setAcceptFailure(null);
    window.api.acceptPass().then(
      (result) => {
        if (!result.ok) {
          setAcceptFailure(result.error);
        }
      },
      (error: unknown) => {
        console.error('[renderer] принятие прохода не ответило', error);
      },
    );
  };

  const resume = (): void => {
    setAcceptFailure(null);
    onResume();
  };

  const reconnect = (): void => {
    onOpenDevice(reconnectAddress(snapshot.scanner));
  };

  // «Подключите заново» из текста плашки — с адресом сканера прохода: именно его и надо
  // вернуть, чтобы досканировать (KTD-27).
  const reconnectPassScanner = (scanner: ScannerInfo | null): void => {
    onOpenDevice(scanner === null ? undefined : addressOf(scanner));
  };

  // Тумблер 180° — у второго уцелевшего прохода (роль, не номер — KTD-4), включая прерванный
  // и принятый; без прохода оборотов тумблера нет (S7). Правило уцелевшего — одно на renderer.
  const backsPass = survivingPasses(session)[1];
  const setRotate = (event: ChangeEvent<HTMLInputElement>): void => {
    // Тумблер — правка (KTD-3, S15): шаг undo с текущими правками снимка. Снимок — источник
    // правды: при отказе команда не меняет ничего, и чекбокс вернётся сам.
    edits.edit({ edits: edits.current.edits, rotate180: event.target.checked }, []);
  };

  // Тосты сохранения живут дольше обычных (UI_SPEC раздел 8).
  const saveToast = (text: string): void => {
    onToast(text, SAVE_TOAST_MS);
  };

  const save = (): void => {
    if (saving) {
      return;
    }
    setSaving(true);
    window.api.savePdf().then(
      (result) => {
        setSaving(false);
        if (!result.ok) {
          saveToast(t('toast.saveFailed', { error: errorTextInline(t, result.error) }));
          return;
        }
        // Отказ в диалоге приходит успехом с `canceled` — не ошибка, тостов нет (KTD-3).
        if (!result.value.canceled) {
          saveToast(
            t('toast.saved', { file: result.value.fileName, folder: result.value.directory }),
          );
        }
      },
      (error: unknown) => {
        // Мост не ответил — пользователь не должен гадать, записался ли файл.
        setSaving(false);
        console.error('[renderer] сохранение не ответило', error);
        saveToast(t('toast.saveNoResponse'));
      },
    );
  };

  // Плашка S17: последний проход прерван. Ноль страниц проход иметь не может — сессии бы не было.
  const last = session.passes[session.passes.length - 1];
  let banner: ReactNode = null;
  if (last?.state === 'interrupted') {
    const lastNumber = last.pages[last.pages.length - 1]?.number ?? 0;
    // Текст без кнопки досканирования объясняет почему; при «подключён не тот (или никакой)»
    // ссылка ведёт в `device` с адресом сканера прохода — иначе из `editor` в модалку не
    // попасть и проход не досканировать (тупик, ревью сессии 9; текст ссылки — Copy).
    const text: ReactNode = snapshot.canResume ? (
      t('editor.interrupted.text', { next: lastNumber + 1 })
    ) : last.paramsKnown ? (
      <>
        {t('editor.interrupted.textOtherScanner', {
          name: last.scanner?.name ?? last.scanner?.host ?? '',
        })}{' '}
        <button
          type="button"
          className="btn btn--link"
          onClick={() => {
            reconnectPassScanner(last.scanner);
          }}
        >
          {t('editor.interrupted.reconnect')}
        </button>
      </>
    ) : (
      t('editor.interrupted.textParamsUnknown')
    );
    // Свежий отказ «Оставить как есть» виден и под висящим отказом досканирования:
    // показывается последнее действие, а не первое.
    let failureLine: ReactNode = null;
    if (acceptFailure !== null) {
      failureLine = errorText(t, acceptFailure);
    } else if (resumeFailure !== null) {
      failureLine = (
        <>
          {t('editor.interrupted.resumeFailed', { error: errorTextInline(t, resumeFailure) })}
          {RESUME_RECONNECT_CODES.includes(resumeFailure.code) && (
            <>
              {' '}
              <button type="button" className="btn btn--link" onClick={reconnect}>
                {t('editor.interrupted.reconnect')}
              </button>
            </>
          )}
        </>
      );
    }
    banner = (
      <div className="pass-banner" role="region" aria-labelledby="pass-banner-title">
        <div className="pass-banner__kicker">
          <span className="dot dot--warning" aria-hidden="true" />
          <span className="kicker kicker--warning">{t('editor.interrupted.kicker')}</span>
        </div>
        <h2 id="pass-banner-title" className="pass-banner__title">
          {t('editor.interrupted.title', { last: lastNumber })}
        </h2>
        <p className="pass-banner__text">{text}</p>
        <div className="pass-banner__actions">
          {snapshot.canResume && (
            <button type="button" className="btn btn--primary btn--small" onClick={resume}>
              {t('editor.interrupted.resume')}
            </button>
          )}
          {snapshot.canAccept && (
            <button type="button" className="btn btn--tinted" onClick={accept}>
              {t('editor.interrupted.accept')}
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setNewScanOpen(true);
            }}
          >
            {t('editor.interrupted.newScan')}
          </button>
        </div>
        {failureLine !== null && (
          <p className="pass-banner__status pass-banner__status--danger" role="alert">
            {failureLine}
          </p>
        )}
      </div>
    );
  }

  const rotateLabel =
    targets.length > 1 ? t('editor.rotateMany', { count: targets.length }) : t('editor.rotate');
  const deleteLabel =
    targets.length > 1 ? t('editor.deleteMany', { count: targets.length }) : t('editor.delete');

  return (
    <main className="editor-screen">
      <header className="editor-screen__toolbar">
        <div className="editor-screen__toolbar-left">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              setNewScanOpen(true);
            }}
          >
            <span aria-hidden="true">↺</span> {t('editor.newScan')}
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
          {/* S8 M2: блокировка на время сборки и записи — защита от повторного нажатия. */}
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={saving || total === 0}
            aria-busy={saving ? true : undefined}
            onClick={save}
          >
            {saving ? t('editor.saving') : t('editor.save')}
          </button>
        </div>
      </header>

      <div className="editor-screen__body">
        <aside
          className="rail"
          aria-label={t('editor.railLabel')}
          ref={railRef}
          onKeyDown={railKeyDown}
        >
          {/* S5: панель мультивыделения. */}
          {multi && (
            <div className="rail__top">
              <div
                className="rail__selection"
                role="region"
                aria-label={t('editor.selection.label')}
              >
                <p className="rail__selection-text">
                  {t('editor.selection.text', { count: selection.keys.length })}
                </p>
                <div className="rail__selection-actions">
                  <button
                    type="button"
                    className="rail__selection-clear"
                    onClick={() => {
                      // Панель исчезнет вместе с кнопкой — фокус переходит на текущую страницу.
                      setSelection(collapsed(selection));
                      focusKey.current = selection.current;
                    }}
                  >
                    {t('editor.selection.clear')}
                  </button>
                </div>
              </div>
            </div>
          )}
          <div className="rail__scroll">
            {total === 0 ? (
              <p className="rail__empty">{t('editor.empty.rail')}</p>
            ) : (
              // S2: группа на документ, в каждой свой listbox; номер миниатюры — сквозной.
              documents.map((document, index) => (
                <section
                  key={index}
                  className={`doc-group ${toneOf(index)}`}
                  aria-labelledby={`doc-name-${String(index)}`}
                >
                  {index > 0 && (
                    <div className="doc-group__divider">
                      <span className="doc-group__pill">{t('editor.doc.newPill')}</span>
                      <span className="doc-group__rule" aria-hidden="true" />
                    </div>
                  )}
                  <div className="doc-group__header">
                    <span className="doc-badge" aria-hidden="true">
                      {index + 1}
                    </span>
                    {/* Поле имени (S3) — U8; пока имя показывается текстом. */}
                    <span id={`doc-name-${String(index)}`} className="doc-group__name">
                      {names[index]}
                    </span>
                    <span className="doc-group__count">
                      {t('editor.doc.count', { count: document.count })}
                    </span>
                  </div>
                  <ul
                    className="thumbs"
                    role="listbox"
                    aria-multiselectable="true"
                    aria-orientation="horizontal"
                    aria-label={t('editor.doc.pagesLabel', { number: index + 1 })}
                  >
                    {order
                      .slice(document.start, document.start + document.count)
                      .map((entry, offset) => (
                        <EditorThumb
                          key={entry.key}
                          sessionId={session.id}
                          pageKey={entry.key}
                          side={entry.side}
                          sheet={entry.sheet}
                          angle={entry.angle}
                          lost={entry.lost}
                          position={document.start + offset + 1}
                          unpaired={entry.unpaired}
                          current={entry.key === selection.current}
                          selected={selectedKeys.has(entry.key)}
                          multi={multi && selectedKeys.has(entry.key)}
                          onPick={pick}
                        />
                      ))}
                  </ul>
                </section>
              ))
            )}
          </div>
          {backsPass !== undefined && (
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
          )}
        </aside>

        <section className="stage">
          {banner}
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
                  currentDocument !== null &&
                  currentDocument > 0 &&
                  currentDoc?.start === currentIndex
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
              aria-label={rotateLabel}
              title={rotateLabel}
              disabled={total === 0 || saving}
              onClick={rotate}
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
            frontsOnly={backsPass === undefined}
            onPickDocument={(index) => {
              const first = visible[documents[index]?.start ?? -1];
              if (first !== undefined) {
                setSelection(single(first));
              }
            }}
          />
        )}
      </div>

      {newScanOpen && (
        <NewScanModal
          pageCount={total}
          onClose={() => {
            setNewScanOpen(false);
          }}
        />
      )}
    </main>
  );
}
