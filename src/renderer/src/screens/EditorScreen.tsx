import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  pageImageUrl,
  type DomainError,
  type PageSnapshot,
  type PassSnapshot,
  type SessionSnapshot,
  type Snapshot,
} from '@shared';
import type { TFunction } from 'i18next';
import { NewScanModal } from '../modals/NewScanModal';
import { errorText, errorTextInline } from '../state/error-text';
import './editor-screen.css';

// Экран `editor` (план M1, U24; UI_SPEC раздел 6 в объёме KTD-25; handoff U19, S16–S19, S21):
// тулбар с «Новое сканирование», лента группами по проходам, превью со статус-баром, плашка
// прерванного прохода. Инспектора, «Сохранить», «Добавить», поворота, удаления и
// пересканирования в разметке нет (KTD-25).

export interface EditorScreenProps {
  readonly snapshot: Snapshot;
  readonly session: SessionSnapshot;
  /** Отказ последнего досканирования — строка в плашке S17; живёт в App: экран уходит. */
  readonly resumeFailure: DomainError | null;
  /** «Досканировать остаток»: тот же `startPass` — сессия есть, ядро продолжит проход. */
  readonly onResume: () => void;
  /** Ссылка «подключите заново» в отказе досканирования (S17). */
  readonly onOpenDevice: (initialHost?: string) => void;
}

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

/** Миниатюра в ленте: обычная, потерянная (S18), строится или не построилась (S19). */
function Thumb({
  sessionId,
  page,
  selected,
  onSelect,
}: {
  readonly sessionId: string;
  readonly page: PageSnapshot;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading');

  const keyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  };

  const classes = ['thumb'];
  let paper: ReactNode;
  if (page.lost) {
    classes.push('thumb--lost');
    paper = <span className="thumb__label">{t('thumb.lost')}</span>;
  } else if (state === 'failed') {
    classes.push('thumb--failed');
    paper = <span className="thumb__label">{t('thumb.failed')}</span>;
  } else {
    if (state === 'loading') {
      classes.push('thumb--loading');
    }
    paper = (
      <>
        <img
          className="thumb__img"
          alt=""
          src={pageImageUrl(sessionId, 'thumb', page.key)}
          onLoad={() => {
            setState('ok');
          }}
          onError={() => {
            setState('failed');
          }}
        />
        {state === 'loading' && <span className="skeleton" />}
      </>
    );
  }
  if (selected) {
    classes.push('thumb--selected');
  }

  return (
    <li
      role="option"
      aria-selected={selected}
      aria-busy={!page.lost && state === 'loading' ? true : undefined}
      aria-label={page.lost ? t('thumb.lostLabel', { number: page.number }) : undefined}
      title={!page.lost && state === 'failed' ? t('thumb.failedTitle') : undefined}
      tabIndex={selected ? 0 : -1}
      data-key={page.key}
      className={classes.join(' ')}
      onClick={onSelect}
      onKeyDown={keyDown}
    >
      <div className="thumb__paper">{paper}</div>
      <div className="thumb__foot">
        <span className="thumb__num">{page.number}</span>
      </div>
    </li>
  );
}

/** Превью: сама страница; потерянная — пунктирный лист S18; не открылась — текст S19. */
function Preview({
  sessionId,
  page,
}: {
  readonly sessionId: string;
  readonly page: PageSnapshot;
}): ReactNode {
  const { t } = useTranslation();
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading');

  if (page.lost) {
    return (
      <div className="preview__paper preview__paper--lost">
        <div className="preview__corner">{t('preview.corner', { number: page.number })}</div>
        <p className="preview__empty">{multiline(t('preview.lost'))}</p>
      </div>
    );
  }
  if (state === 'failed') {
    return (
      <div className="preview__paper">
        <div className="preview__corner">{t('preview.corner', { number: page.number })}</div>
        <p className="preview__empty">{multiline(t('preview.failed'))}</p>
      </div>
    );
  }
  return (
    <div
      className={state === 'loading' ? 'preview__paper preview__paper--loading' : 'preview__paper'}
      aria-busy={state === 'loading' ? true : undefined}
    >
      <img
        className="preview__img"
        alt={t('thumb.alt', { number: page.number })}
        src={pageImageUrl(sessionId, 'page', page.key)}
        onLoad={() => {
          setState('ok');
        }}
        onError={() => {
          setState('failed');
        }}
      />
      {state === 'loading' && <span className="skeleton" />}
    </div>
  );
}

function passMeta(t: TFunction, pass: PassSnapshot): string {
  const count = pass.pages.length;
  switch (pass.state) {
    case 'interrupted':
      return t('editor.pass.metaInterrupted', { count });
    case 'accepted':
      return t('editor.pass.metaAccepted', { count });
    default:
      return t('editor.pass.meta', { count });
  }
}

export function EditorScreen({
  snapshot,
  session,
  resumeFailure,
  onResume,
  onOpenDevice,
}: EditorScreenProps): ReactNode {
  const { t } = useTranslation();
  const pages = session.passes.flatMap((pass) => pass.pages);
  const total = pages.length;

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedIndex = Math.max(
    0,
    pages.findIndex((page) => page.key === selectedKey),
  );
  const selected = pages[selectedIndex];

  const [newScanOpen, setNewScanOpen] = useState(false);
  const [acceptFailure, setAcceptFailure] = useState<DomainError | null>(null);

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
    const page = pages[Math.min(Math.max(index, 0), total - 1)];
    if (page !== undefined) {
      setSelectedKey(page.key);
      if (focus) {
        focusKey.current = page.key;
      }
    }
  };

  const railKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    let target: number;
    switch (event.key) {
      case 'ArrowLeft':
        target = selectedIndex - 1;
        break;
      case 'ArrowRight':
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
    onOpenDevice(
      scanner.kind === 'none' ? undefined : `${scanner.scanner.host}:${scanner.scanner.port}`,
    );
  };

  // Плашка S17: последний проход прерван. Ноль страниц проход иметь не может — сессии бы не было.
  const last = session.passes[session.passes.length - 1];
  let banner: ReactNode = null;
  if (last?.state === 'interrupted') {
    const lastNumber = last.pages[last.pages.length - 1]?.number ?? 0;
    const text = snapshot.canResume
      ? t('editor.interrupted.text', { next: lastNumber + 1 })
      : last.paramsKnown
        ? t('editor.interrupted.textOtherScanner', {
            name: last.scanner?.name ?? last.scanner?.host ?? '',
          })
        : t('editor.interrupted.textParamsUnknown');
    const failure = resumeFailure ?? acceptFailure;
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
        {failure !== null && (
          <p className="pass-banner__status pass-banner__status--danger" role="alert">
            {failure === resumeFailure
              ? t('editor.interrupted.resumeFailed', { error: errorTextInline(t, failure) })
              : errorText(t, failure)}
            {failure === resumeFailure && RECONNECT_CODES.includes(failure.code) && (
              <>
                {' '}
                <button type="button" className="btn btn--link" onClick={reconnect}>
                  {t('editor.interrupted.reconnect')}
                </button>
              </>
            )}
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
      </header>

      <div className="editor-screen__body">
        <aside
          className="rail"
          aria-label={t('editor.railLabel')}
          ref={railRef}
          onKeyDown={railKeyDown}
        >
          {session.passes.map((pass) => (
            <section key={pass.number} className="pass-group">
              <header className="pass-group__header">
                <span className="pass-group__title">
                  {t('editor.pass.title', { number: pass.number })}
                </span>
                <span className="pass-group__meta">{passMeta(t, pass)}</span>
              </header>
              <ul
                className="thumbs"
                role="listbox"
                aria-label={t('editor.pass.title', { number: pass.number })}
              >
                {pass.pages.map((page) => (
                  <Thumb
                    key={page.key}
                    sessionId={session.id}
                    page={page}
                    selected={selected?.key === page.key}
                    onSelect={() => {
                      setSelectedKey(page.key);
                    }}
                  />
                ))}
              </ul>
            </section>
          ))}
        </aside>

        <section className="stage">
          {banner}
          <div className="preview">
            {selected !== undefined && (
              <Preview key={selected.key} sessionId={session.id} page={selected} />
            )}
          </div>
          <footer className="stage__statusbar">
            <button
              type="button"
              className="btn btn--icon"
              aria-label={t('editor.prev')}
              disabled={selectedIndex === 0}
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
              disabled={selectedIndex >= total - 1}
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
