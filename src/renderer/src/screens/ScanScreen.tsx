import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  addedSetsOf,
  hasPages,
  isAnchoredKind,
  isBacksKind,
  pageImageUrl,
  type PageSnapshot,
  type PassProgress,
  type PassSnapshot,
  type Snapshot,
} from '@shared';
import type { TFunction } from 'i18next';
import { useFocusWhen } from '../components/useFocusWhen';
import { useImageLoad } from '../components/useImageLoad';
import { paramsLine } from '../state/params-line';
import './scan-screen.css';

// Экран `scan` (план M1, U23; UI_SPEC раздел 3; handoff U19, S12–S15, S19): тег прохода,
// иллюстрация подачи, счётчик в живом регионе, строка параметров, лента последних пяти
// страниц, «Остановить». С M2 вернулись полные тексты (план M2, U8): тег различает роли
// «лицевые/обороты/добавляем» (по `kind`, не по номеру — KTD-4), счётчик оборотов — «N из M»
// (R2) и может перевалить за M — показывается как есть. Добавленный набор (M3.5, handoff S3):
// тег без номера прохода на цвете набора, счётчик без «из M», мета досканирования без номера.
// Проходы двустороннего набора (M4.5, R5, R7; handoff M4.5, S3–S4): тег с ролью «ЛИЦА» /
// «ОБОРОТЫ» на цвете набора, у оборотов счётчик «из N» (`pass.expected` — лица набора), мета
// досканирования называет набор «ДN».

/** Сколько последних страниц показывает лента. */
export const STRIP_SIZE = 5;

export interface ScanScreenProps {
  readonly snapshot: Snapshot;
  readonly pass: PassProgress;
  /** «Остановить»: команда уходит один раз, исходом занимается App (тост S15). */
  readonly onStop: () => void;
}

/** Идущий проход; до `resumePass` он ещё прерванный — берётся последний; без сессии — нет. */
function runningPass(snapshot: Snapshot): PassSnapshot | undefined {
  const passes = snapshot.session?.passes ?? [];
  return passes.find((pass) => pass.state === 'running') ?? passes[passes.length - 1];
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

/** Номер «ДN» набора, которому принадлежит проход (M4.5, KTD2); `null` — не проход набора. */
function setNumberOf(snapshot: Snapshot, pass: PassSnapshot | undefined): number | null {
  if (pass === undefined) {
    return null;
  }
  const passes = snapshot.session?.passes ?? [];
  return (
    addedSetsOf(passes, hasPages).find(
      (set) => set.fronts === pass.number || set.backs === pass.number,
    )?.set ?? null
  );
}

/** Тег прохода по роли (KTD-4): у набора — с ролью пары (M4.5), у основной пачки — с номером. */
function tagOf(t: TFunction, kind: PassProgress['kind'], number: number): string {
  switch (kind) {
    case 'added':
      return t('scan.tagAdded');
    case 'addedFronts':
      return t('scan.tagSetFronts');
    case 'addedBacks':
      return t('scan.tagSetBacks');
    case 'backs':
      return t('scan.tagBacks', { number });
    case 'fronts':
      return t('scan.tag', { number });
  }
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
  useFocusWhen(screenRef, stopping);

  const pages = passPages(snapshot, pass);
  // `pass.pages` — число страниц этого запуска; прежние страницы досканируемого прохода — разница.
  const prior = pages.length - pass.pages;
  const busy = pass.phase === 'busy';
  const running = runningPass(snapshot);

  // «Начинаем проход…» — всю фазу `starting` (и при досканировании: подача ещё не идёт, S12)
  // и пока счёт нулевой в `scanning`: «Отсканировано 0» на экран не выходит.
  const counted = pages.length > 0 ? pages.length : pass.pages;
  const counter =
    pass.phase === 'starting' || counted === 0
      ? t('scan.starting')
      : pass.expected !== null
        ? t('scan.counterOf', { count: counted, expected: pass.expected })
        : t('scan.counter', { count: counted });

  let meta = busy ? t('scan.busy.meta') : paramsLine(t, pass.params);
  if (!busy && pass.resumed) {
    const set = setNumberOf(snapshot, running);
    let resume: string;
    if (set !== null) {
      resume = t('scan.resumeMetaSet', { set, count: prior });
    } else if (pass.kind === 'added') {
      resume = t('scan.resumeMetaAdded', { count: prior });
    } else {
      resume = t('scan.resumeMeta', { number: running?.number ?? 1, count: prior });
    }
    meta = `${resume} · ${meta}`;
  }
  const tag = tagOf(t, pass.kind, running?.number ?? 1);
  // Добавляем — односторонний набор или проход пары: тег на цвете набора (S3 M3.5, S3–S4 M4.5).
  const added = isAnchoredKind(pass.kind) || (isBacksKind(pass.kind) && pass.kind !== 'backs');

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
      <div className={added ? 'scan-screen__tag scan-screen__tag--added' : 'scan-screen__tag'}>
        {tag}
      </div>

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

      {/* Лента занимает место с самого начала: первая миниатюра не расталкивает экран
          (смоук приёмки M1). Пустая — скрыта от скринридера. */}
      <ul
        className="strip"
        aria-label={strip.length > 0 ? t('scan.strip.label') : undefined}
        aria-hidden={strip.length === 0 ? true : undefined}
      >
        {sessionId !== undefined &&
          strip.map((page) => <StripCard key={page.key} sessionId={sessionId} page={page} />)}
      </ul>

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
