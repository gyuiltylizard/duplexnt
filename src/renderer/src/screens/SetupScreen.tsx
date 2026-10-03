import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_SCAN_PARAMS,
  resolveScanParams,
  type DomainError,
  type ScanOptions,
  type ScanParams,
  type ScannerInfo,
  type Snapshot,
} from '@shared';
import { Segments } from '../components/Segments';
import { errorText, errorTextInline } from '../state/error-text';
import './setup-screen.css';

// Экран `setup` (план M1, U22; UI_SPEC раздел 2; handoff U19, S1–S6): одна колонка, строка
// устройства с состояниями запомненного сканера, параметры из capabilities, запуск прохода.
// Строки «Пустые обороты» и «Авто» отсутствуют, тексты — про один проход (KTD-25).

export interface SetupScreenProps {
  readonly snapshot: Snapshot;
  /** Отказ последнего запуска — плашка S6; живёт в App: экран на время запуска уходит. */
  readonly launchFailure: DomainError | null;
  readonly onStart: () => void;
  /** Открыть модалку `device`; адрес — для «Подключить заново» (S4, S6). */
  readonly onOpenDevice: (initialHost?: string) => void;
}

/** Адрес для поля модалки: хост с портом — порт различает две записи одного устройства. */
const hostOf = (scanner: ScannerInfo): string => `${scanner.host}:${scanner.port}`;

interface KnownParams {
  readonly options: ScanOptions;
  readonly params: ScanParams;
}

/** Ряды недоступного состояния показывают значения, а не пустоту (S2): по одному сегменту. */
const FALLBACK: KnownParams = {
  options: {
    colorModes: [DEFAULT_SCAN_PARAMS.colorMode],
    resolutions: [DEFAULT_SCAN_PARAMS.resolution],
    paperSizes: [DEFAULT_SCAN_PARAMS.paperSize],
  },
  params: DEFAULT_SCAN_PARAMS,
};

export function SetupScreen({
  snapshot,
  launchFailure,
  onStart,
  onOpenDevice,
}: SetupScreenProps): ReactNode {
  const { t } = useTranslation();
  const { scanner } = snapshot;
  const ready = scanner.kind === 'ready' ? scanner : null;

  // Последние подтверждённые варианты: недоступные ряды S3–S4 показывают их, а не дефолты.
  // Корректировка состояния при рендере (react.dev «You Might Not Need an Effect»): рендер
  // перезапустится с новым значением до обращения к DOM.
  const [known, setKnown] = useState<KnownParams | null>(null);
  if (ready !== null && (known?.options !== ready.options || known.params !== ready.params)) {
    setKnown({ options: ready.options, params: ready.params });
  }

  const shown = ready ?? known ?? FALLBACK;
  const enabled = ready !== null;

  const sendParams = (params: ScanParams): void => {
    window.api.setScanParams(params).then(
      (result) => {
        if (!result.ok) {
          // Снимок вернёт прежнее значение; гонка с отключением устройства — не отказ экрана.
          console.error('[renderer] параметры не приняты', result.error);
        }
      },
      (error: unknown) => {
        console.error('[renderer] параметры не отправлены', error);
      },
    );
  };

  const recheck = (): void => {
    window.api.recheckScanner().catch((error: unknown) => {
      console.error('[renderer] проверка сканера не ответила', error);
    });
  };

  const launch = (): void => {
    // Гейтинг UI_SPEC: без подтверждённого сканера запуск открывает модалку, а не проход.
    if (ready === null) {
      onOpenDevice();
      return;
    }
    onStart();
  };

  const resolutionHint = (value: number): string | undefined => {
    switch (value) {
      case 200:
        return t('setup.params.resolutionHint.200');
      case 300:
        return t('setup.params.resolutionHint.300');
      case 600:
        return t('setup.params.resolutionHint.600');
      default:
        return undefined;
    }
  };

  const schemeBadge = (info: ScannerInfo): ReactNode =>
    info.scheme === 'http' ? (
      <span className="device-row__scheme" title={t('setup.device.scheme.httpTitle')}>
        {t('setup.device.scheme.http')}
      </span>
    ) : null;

  let deviceRow: ReactNode;
  switch (scanner.kind) {
    case 'none':
      deviceRow = (
        <div className="device-row">
          <div className="device-row__none">{t('setup.device.none')}</div>
          <span className="device-row__spacer" />
          <button
            type="button"
            className="btn btn--primary btn--small"
            onClick={() => {
              onOpenDevice();
            }}
          >
            <span aria-hidden="true">+</span> {t('setup.device.add')}
          </button>
        </div>
      );
      break;
    case 'checking':
      deviceRow = (
        <div className="device-row device-row--checking" aria-busy="true">
          <div className="device-row__name">{scanner.scanner.name ?? scanner.scanner.host}</div>
          {schemeBadge(scanner.scanner)}
          <div className="device-row__status">
            <span className="dot dot--checking" aria-hidden="true" />
            <span className="device-row__status-text" role="status">
              {t('setup.device.status.checking')}
            </span>
          </div>
          <span className="device-row__spacer" />
          <button type="button" className="btn btn--ghost" disabled>
            {t('setup.device.change')}
          </button>
        </div>
      );
      break;
    case 'ready':
      deviceRow = (
        <div className="device-row">
          <div className="device-row__name">{scanner.scanner.name ?? scanner.scanner.host}</div>
          {schemeBadge(scanner.scanner)}
          <div className="device-row__status">
            <span className="dot dot--ready" aria-hidden="true" />
            <span className="device-row__status-text">{t('setup.device.status.ready')}</span>
          </div>
          <span className="device-row__spacer" />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              onOpenDevice();
            }}
          >
            {t('setup.device.change')}
          </button>
        </div>
      );
      break;
    case 'unreachable':
      deviceRow = (
        <div className="device-row device-row--unreachable">
          <div className="device-row__name">{scanner.scanner.name ?? scanner.scanner.host}</div>
          {schemeBadge(scanner.scanner)}
          <div className="device-row__status">
            <span className="dot dot--danger" aria-hidden="true" />
            <span className="device-row__status-text" role="status">
              {t('setup.device.status.unreachable')}
            </span>
          </div>
          <span className="device-row__spacer" />
          <button type="button" className="btn btn--ghost" onClick={recheck}>
            {t('setup.device.retry')}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              onOpenDevice();
            }}
          >
            {t('setup.device.change')}
          </button>
        </div>
      );
      break;
    case 'otherDevice':
      deviceRow = (
        <div className="device-row device-row--changed">
          <div className="device-row__name">{scanner.scanner.name ?? scanner.scanner.host}</div>
          {schemeBadge(scanner.scanner)}
          <div className="device-row__status">
            <span className="dot dot--warning" aria-hidden="true" />
            <span
              className="device-row__status-text"
              role="status"
              title={
                scanner.error === null
                  ? t('setup.device.status.changedTitle')
                  : errorText(t, scanner.error)
              }
            >
              {t('setup.device.status.changed')}
            </span>
          </div>
          <span className="device-row__spacer" />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              onOpenDevice(hostOf(scanner.scanner));
            }}
          >
            {t('setup.device.reconnect')}
          </button>
        </div>
      );
      break;
  }

  return (
    <main className="setup-screen">
      <section className="setup-screen__column">
        <header className="setup-screen__intro">
          <div className="kicker">{t('setup.kicker')}</div>
          <h1 className="setup-screen__title">{t('setup.title')}</h1>
          <p className="setup-screen__lead">{t('setup.lead')}</p>
        </header>

        <div className="params">
          {deviceRow}

          <div className="param-row">
            <div className="param-row__label">{t('setup.params.color')}</div>
            <Segments
              label={t('setup.params.color')}
              values={shown.options.colorModes}
              selected={shown.params.colorMode}
              disabled={!enabled}
              format={(value) => t(`setup.params.colorMode.${value}`)}
              onSelect={(value) => {
                sendParams({ ...shown.params, colorMode: value });
              }}
            />
          </div>
          <div className="param-row">
            <div className="param-row__label">{t('setup.params.resolution')}</div>
            <Segments
              label={t('setup.params.resolution')}
              values={shown.options.resolutions}
              selected={shown.params.resolution}
              disabled={!enabled}
              format={(value) => t('setup.params.resolutionValue', { count: value })}
              titleOf={resolutionHint}
              onSelect={(value) => {
                sendParams({ ...shown.params, resolution: value });
              }}
            />
          </div>
          <div className="param-row">
            <div className="param-row__label">{t('setup.params.paperSize')}</div>
            <Segments
              label={t('setup.params.paperSize')}
              values={shown.options.paperSizes}
              selected={shown.params.paperSize}
              disabled={!enabled}
              format={(value) => value}
              titleOf={(value) => t(`setup.params.paperSizeHint.${value}`)}
              onSelect={(value) => {
                sendParams({ ...shown.params, paperSize: value });
              }}
            />
          </div>

          <div className="params__footer">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={!enabled}
              onClick={() => {
                sendParams(resolveScanParams(null, shown.options));
              }}
            >
              {t('setup.params.reset')}
            </button>
          </div>
        </div>

        <div className="setup-screen__launch">
          <button type="button" className="btn btn--primary btn--large" onClick={launch}>
            {t('setup.start')}
          </button>
          <p className="setup-screen__hint">{t('setup.hint')}</p>
        </div>

        {launchFailure !== null && (
          <div
            className={
              launchFailure.code === 'scanNoPaper'
                ? 'notice notice--warning'
                : 'notice notice--danger'
            }
            role="alert"
          >
            <p className="notice__text">
              {launchFailure.code === 'scanNoPaper'
                ? errorText(t, launchFailure)
                : t('setup.launch.failed', { error: errorTextInline(t, launchFailure) })}
            </p>
            {launchFailure.code === 'scannerCertificateChanged' && scanner.kind !== 'none' && (
              <button
                type="button"
                className="btn btn--tinted"
                onClick={() => {
                  onOpenDevice(hostOf(scanner.scanner));
                }}
              >
                {t('setup.device.reconnect')}
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
