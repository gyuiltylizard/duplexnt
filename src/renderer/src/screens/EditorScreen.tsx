import {
  Fragment,
  memo,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  pageImageUrl,
  type AssembledPage,
  type DomainError,
  type ScannerInfo,
  type SessionSnapshot,
  type Snapshot,
} from '@shared';
import { useImageLoad } from '../components/useImageLoad';
import { NewScanModal } from '../modals/NewScanModal';
import { errorText, errorTextInline } from '../state/error-text';
import { addressOf } from '../state/scanner-address';
import './editor-screen.css';

// Экран `editor` (план M1, U24; M2, U9; UI_SPEC раздел 6; handoff M2, S6–S9): тулбар с «Новое
// сканирование» и правой зоной сохранения, лента в порядке сборки (AE1: 1л, 1о, 2л, 2о, …)
// с тегом «об» на оборотах и пометкой непарного листа, превью, тумблер «повернуть обороты
// на 180°» внизу ленты, плашка прерванного прохода. Инспектора, «Добавить» и правок страниц
// нет (KTD-25 M1 продолжает действовать).

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

/** Коды отказа досканирования, которые лечатся повторным подключением (S17). */
const RECONNECT_CODES: readonly string[] = ['scannerUnreachable', 'scannerCertificateChanged'];

/** Текст локали с переводом строки — двумя строками (`preview.lost`, `preview.failed`). */
function multiline(text: string): ReactNode {
  return text.split('\n').map((line, index) => (
    <Fragment key={index}>
      {index > 0 && <br />}
      {line}
    </Fragment>
  ));
}

/**
 * Миниатюра в ленте: обычная, потерянная (S18), строится или не построилась (S19), оборот с
 * тегом «об» и поворотом, непарный лист с янтарной точкой (S6). Мемоизирована: смена выбора
 * перерисовывает две карточки, а не всю ленту (`onSelect` стабилен и принимает ключ).
 */
const Thumb = memo(function Thumb({
  sessionId,
  entry,
  position,
  unpaired,
  selected,
  onSelect,
}: {
  readonly sessionId: string;
  readonly entry: AssembledPage;
  /** Номер по порядку в наборе, с единицы. */
  readonly position: number;
  readonly unpaired: boolean;
  readonly selected: boolean;
  readonly onSelect: (key: string) => void;
}): ReactNode {
  const { t } = useTranslation();
  const image = useImageLoad();

  const select = (): void => {
    onSelect(entry.key);
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select();
    }
  };

  const classes = ['thumb'];
  let paper: ReactNode;
  if (entry.lost) {
    classes.push('thumb--lost');
    paper = <span className="thumb__label">{t('thumb.lost')}</span>;
  } else if (image.state === 'failed') {
    classes.push('thumb--failed');
    paper = <span className="thumb__label">{t('thumb.failed')}</span>;
  } else {
    if (image.state === 'loading') {
      classes.push('thumb--loading');
    }
    paper = (
      <>
        <img
          className="thumb__img"
          alt=""
          loading="lazy"
          decoding="async"
          src={pageImageUrl(sessionId, 'thumb', entry.key)}
          onLoad={image.onLoad}
          onError={image.onError}
        />
        {image.state === 'loading' && <span className="skeleton skeleton--cover" />}
      </>
    );
  }
  if (selected) {
    classes.push('thumb--selected');
  }
  // Поворот оборотов — только отображение: файлы не меняются (KTD-2).
  if (entry.side === 'back' && entry.rotate180) {
    classes.push('thumb--rotated');
  }

  const label = entry.lost
    ? t('thumb.lostLabel', { number: position })
    : unpaired
      ? t('thumb.unpairedLabel', { number: entry.sheet ?? position })
      : t('thumb.alt', { number: position });

  return (
    <li
      role="option"
      aria-selected={selected}
      aria-busy={!entry.lost && image.state === 'loading' ? true : undefined}
      aria-label={label}
      title={!entry.lost && image.state === 'failed' ? t('thumb.failedTitle') : undefined}
      tabIndex={selected ? 0 : -1}
      data-key={entry.key}
      className={classes.join(' ')}
      onClick={select}
      onKeyDown={keyDown}
    >
      <div className="thumb__paper">{paper}</div>
      <div className="thumb__foot">
        <span className="thumb__num">{position}</span>
        {entry.side === 'back' && <span className="thumb__tag">{t('thumb.tagBacks')}</span>}
        {unpaired && (
          <span
            className="dot dot--warning thumb__flag"
            title={t('thumb.unpairedTitle')}
            aria-hidden="true"
          />
        )}
      </div>
    </li>
  );
});

/** Превью: сама страница; потерянная — пунктирный лист S18; не открылась — текст S19. */
function Preview({
  sessionId,
  entry,
  position,
}: {
  readonly sessionId: string;
  readonly entry: AssembledPage;
  readonly position: number;
}): ReactNode {
  const { t } = useTranslation();
  const image = useImageLoad();

  // Потерянная страница и не открывшийся файл показываются одинаково устроенным листом:
  // угловая метка и текст; различаются пунктиром и ключом текста.
  if (entry.lost || image.state === 'failed') {
    return (
      <div className={entry.lost ? 'preview__paper preview__paper--lost' : 'preview__paper'}>
        <div className="preview__corner">{t('preview.corner', { number: position })}</div>
        <p className="preview__empty">
          {multiline(entry.lost ? t('preview.lost') : t('preview.failed'))}
        </p>
      </div>
    );
  }
  const classes = ['preview__paper'];
  if (image.state === 'loading') {
    classes.push('preview__paper--loading');
  }
  if (entry.side === 'back' && entry.rotate180) {
    classes.push('preview__paper--rotated');
  }
  return (
    <div className={classes.join(' ')} aria-busy={image.state === 'loading' ? true : undefined}>
      <img
        className="preview__img"
        alt={t('thumb.alt', { number: position })}
        src={pageImageUrl(sessionId, 'page', entry.key)}
        onLoad={image.onLoad}
        onError={image.onError}
      />
      {image.state === 'loading' && <span className="skeleton skeleton--cover" />}
    </div>
  );
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

  // Лента — порядок сборки (KTD-4, derived); до приёмки прерванных оборотов — фактические пары.
  const order = snapshot.assembly?.order ?? [];
  const report = snapshot.assembly?.report;
  const total = order.length;
  const unpairedSheets = report?.unpairedSheets ?? [];

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedIndex = Math.max(
    0,
    order.findIndex((entry) => entry.key === selectedKey),
  );
  const selected = order[selectedIndex];

  const [newScanOpen, setNewScanOpen] = useState(false);
  const [acceptFailure, setAcceptFailure] = useState<DomainError | null>(null);
  const [saving, setSaving] = useState(false);

  // Стрелки двигают выбор по всей ленте — фокус должен следовать за ним (роуминг tabindex).
  const railRef = useRef<HTMLElement>(null);
  const focusKey = useRef<string | null>(null);
  useEffect(() => {
    if (focusKey.current !== null) {
      railRef.current
        ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey.current)}"]`)
        ?.focus();
      focusKey.current = null;
    }
  });

  const selectAt = (index: number, focus: boolean): void => {
    const entry = order[Math.min(Math.max(index, 0), total - 1)];
    if (entry !== undefined) {
      setSelectedKey(entry.key);
      if (focus) {
        focusKey.current = entry.key;
      }
    }
  };

  const railKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    let target: number;
    switch (event.key) {
      // ↑/↓ — синонимы ←/→: скринридеры ждут вертикальных стрелок у listbox.
      case 'ArrowLeft':
      case 'ArrowUp':
        target = selectedIndex - 1;
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        target = selectedIndex + 1;
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
    selectAt(target, true);
  };

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
    const { scanner } = snapshot;
    onOpenDevice(scanner.kind === 'none' ? undefined : addressOf(scanner.scanner));
  };

  // «Подключите заново» из текста плашки — с адресом сканера прохода: именно его и надо
  // вернуть, чтобы досканировать (KTD-27).
  const reconnectPassScanner = (scanner: ScannerInfo | null): void => {
    onOpenDevice(scanner === null ? undefined : addressOf(scanner));
  };

  // Тумблер 180° — у второго уцелевшего прохода (роль, не номер — KTD-4), включая прерванный
  // и принятый; без прохода оборотов тумблера нет (S7).
  const backsPass = session.passes.filter((pass) => pass.pages.length > 0)[1];
  const setRotate = (event: ChangeEvent<HTMLInputElement>): void => {
    // Снимок — источник правды: при отказе команда не меняет ничего, и чекбокс вернётся сам.
    window.api.setRotateBacks({ rotate: event.target.checked }).then(
      (result) => {
        if (!result.ok) {
          console.error('[renderer] поворот оборотов не принят', result.error);
        }
      },
      (error: unknown) => {
        console.error('[renderer] поворот оборотов не отправлен', error);
      },
    );
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
          // Отказ в диалоге — не ошибка: ничего не записано, тостов нет (KTD-3).
          if (result.error.code !== 'canceled') {
            onToast(
              t('toast.saveFailed', { error: errorTextInline(t, result.error) }),
              SAVE_TOAST_MS,
            );
          }
          return;
        }
        if (!result.value.canceled) {
          onToast(
            t('toast.saved', { file: result.value.fileName, folder: result.value.directory }),
            SAVE_TOAST_MS,
          );
        }
      },
      (error: unknown) => {
        setSaving(false);
        console.error('[renderer] сохранение не ответило', error);
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
          {RECONNECT_CODES.includes(resumeFailure.code) && (
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
        <div className="editor-screen__toolbar-center">
          <div className="editor-screen__count">{t('editor.count', { count: total })}</div>
        </div>
        <div className="editor-screen__toolbar-right">
          {/* S9: точка несохранённого; скрыта, когда набор пуст или сохранён. */}
          {!session.saved && total > 0 && (
            <span
              className="editor-screen__unsaved dot dot--warning"
              role="status"
              title={t('editor.unsaved')}
            >
              <span className="visually-hidden">{t('editor.unsaved')}</span>
            </span>
          )}
          {/* S8: блокировка на время сборки и записи — защита от повторного нажатия. */}
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
          <div className="rail__scroll">
            <ul className="thumbs" role="listbox" aria-orientation="horizontal">
              {order.map((entry, index) => (
                <Thumb
                  key={entry.key}
                  sessionId={session.id}
                  entry={entry}
                  position={index + 1}
                  unpaired={
                    entry.side === 'front' &&
                    entry.sheet !== null &&
                    unpairedSheets.includes(entry.sheet)
                  }
                  selected={selected?.key === entry.key}
                  onSelect={setSelectedKey}
                />
              ))}
            </ul>
          </div>
          {backsPass !== undefined && (
            <footer className="rail__footer">
              <label className="toggle-row" title={t('editor.rotateBacksTitle')}>
                <span className="toggle">
                  <input
                    className="toggle__input"
                    type="checkbox"
                    checked={backsPass.rotate180}
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
          <div className="preview">
            {selected !== undefined && (
              <Preview
                key={selected.key}
                sessionId={session.id}
                entry={selected}
                position={selectedIndex + 1}
              />
            )}
          </div>
          <footer className="stage__statusbar">
            <button
              type="button"
              className="btn btn--icon"
              aria-label={t('editor.prev')}
              aria-disabled={selectedIndex === 0 ? true : undefined}
              onClick={() => {
                selectAt(selectedIndex - 1, false);
              }}
            >
              ←
            </button>
            <div className="stage__counter">
              {t('editor.position', { current: selectedIndex + 1, total })}
            </div>
            <button
              type="button"
              className="btn btn--icon"
              aria-label={t('editor.next')}
              aria-disabled={selectedIndex >= total - 1 ? true : undefined}
              onClick={() => {
                selectAt(selectedIndex + 1, false);
              }}
            >
              →
            </button>
          </footer>
        </section>
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
