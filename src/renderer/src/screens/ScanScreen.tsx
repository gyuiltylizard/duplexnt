import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  pageImageUrl,
  type PageSnapshot,
  type PassProgress,
  type ScanParams,
  type Snapshot,
} from '@shared';
import type { TFunction } from 'i18next';
import { useImageLoad } from '../components/useImageLoad';
import { lowerFirst } from '../state/error-text';
import './scan-screen.css';

// Экран `scan` (план M1, U23; UI_SPEC раздел 3; handoff U19, S12–S15, S19): тег прохода,
// иллюстрация подачи, счётчик в живом регионе, строка параметров, лента последних пяти
// страниц, «Остановить». Тег не упоминает лицевые стороны, счётчик — без «из M» (KTD-25).

/** Сколько последних страниц показывает лента. */
export const STRIP_SIZE = 5;

export interface ScanScreenProps {
  readonly snapshot: Snapshot;
  readonly pass: PassProgress;
  /** «Остановить»: команда уходит один раз, исходом занимается App (тост S15). */
  readonly onStop: () => void;
}

function passNumber(snapshot: Snapshot): number {
  const passes = snapshot.session?.passes ?? [];
  const running = passes.find((pass) => pass.state === 'running') ?? passes[passes.length - 1];
  return running?.number ?? 1;
}

/**
 * Страницы прохода, который идёт: при досканировании до `resumePass` ядро ещё держит проход
 * прерванным — лента начинается с его прежних страниц (S14).
 */
function passPages(snapshot: Snapshot, pass: PassProgress): readonly PageSnapshot[] {
  const passes = snapshot.session?.passes ?? [];
  const running = passes.find((candidate) => candidate.state === 'running');
  if (running !== undefined) {
    return running.pages;
  }
  return pass.resumed ? (passes[passes.length - 1]?.pages ?? []) : [];
}

/** Строка параметров прохода: «300 dpi · оттенки серого · A4». */
function paramsLine(t: TFunction, params: ScanParams): string {
  return t('scan.params', {
    resolution: params.resolution,
    color: lowerFirst(t(`setup.params.colorMode.${params.colorMode}`)),
    size: params.paperSize,
  });
}

/** Карточка ленты: скелетон, пока миниатюра строится; номер вместо не построившейся (S19). */
function StripCard({
  sessionId,
  page,
}: {
  readonly sessionId: string;
  readonly page: PageSnapshot;
}): ReactNode {
  const { t } = useTranslation();
  const image = useImageLoad();

  // Потерянная страница в ленте `scan` выглядит как не построившаяся миниатюра — номер на
  // месте; полная форма S18 — в ленте `editor`. Различается только подпись.
  if (page.lost || image.state === 'failed') {
    return (
      <li
        className="strip__card strip__card--failed"
        title={page.lost ? t('thumb.lostLabel', { number: page.number }) : t('thumb.failedTitle')}
      >
        <span className="strip__num">{page.number}</span>
      </li>
    );
  }
  return (
    <li
      className={image.state === 'loading' ? 'strip__card strip__card--loading' : 'strip__card'}
      aria-busy={image.state === 'loading' ? true : undefined}
    >
      <img
        className="strip__img"
        alt={t('thumb.alt', { number: page.number })}
        src={pageImageUrl(sessionId, 'thumb', page.key)}
        onLoad={image.onLoad}
        onError={image.onError}
      />
      {image.state === 'loading' && <span className="skeleton skeleton--cover" />}
    </li>
  );
}

export function ScanScreen({ snapshot, pass, onStop }: ScanScreenProps): ReactNode {
  const { t } = useTranslation();
  const screenRef = useRef<HTMLElement>(null);
  const [stopSent, setStopSent] = useState(false);
  const stopping = stopSent || pass.phase === 'stopping';

  // В S15 «Остановить» выпадает из обхода — фокус уходит на контейнер экрана, чтобы не
  // потеряться (handoff, «Клавиатура»).
  useEffect(() => {
    if (stopping) {
      screenRef.current?.focus();
    }
  }, [stopping]);

  const pages = passPages(snapshot, pass);
  const prior = pages.length - pass.pages;
  const busy = pass.phase === 'busy';

  // До первой страницы — «Начинаем проход…» и в фазе `scanning` тоже: задание уже принято, но
  // «Отсканировано 0» на экране не появляется (S12 — счёт начинается с первой страницы).
  const counted = pages.length > 0 ? pages.length : pass.pages;
  const counter = counted === 0 ? t('scan.starting') : t('scan.counter', { count: counted });

  const meta = busy
    ? t('scan.busy.meta')
    : pass.resumed
      ? `${t('scan.resumeMeta', { number: passNumber(snapshot), count: prior })} · ${paramsLine(t, pass.params)}`
      : paramsLine(t, pass.params);

  const strip = pages.slice(-STRIP_SIZE);
  const sessionId = snapshot.session?.id;

  const stop = (): void => {
    if (stopping) {
      return;
    }
    setStopSent(true);
    onStop();
  };

  return (
    <main className="scan-screen" ref={screenRef} tabIndex={-1}>
      <div className="scan-screen__tag">{t('scan.tag', { number: passNumber(snapshot) })}</div>

      <div className="scan-screen__stage">
        <div className={busy ? 'feed feed--idle' : 'feed'} aria-hidden="true">
          <span className="feed__sheet feed__sheet--back" />
          <span className="feed__sheet feed__sheet--mid" />
          <span className="feed__sheet feed__sheet--moving" />
          <span className="feed__tray" />
          <span className="feed__bar" />
        </div>
        <div className="scan-screen__counter" role="status" aria-live="polite" aria-atomic="true">
          {busy ? t('scan.busy.title') : counter}
        </div>
        <div className="scan-screen__meta">{meta}</div>
      </div>

      {sessionId !== undefined && strip.length > 0 && (
        <ul className="strip" aria-label={t('scan.strip.label')}>
          {strip.map((page) => (
            <StripCard key={page.key} sessionId={sessionId} page={page} />
          ))}
        </ul>
      )}

      <button
        type="button"
        className="btn btn--secondary btn--large"
        disabled={stopping}
        aria-busy={stopping ? true : undefined}
        onClick={stop}
      >
        {stopping ? t('scan.stopping') : t('scan.stop')}
      </button>
    </main>
  );
}
