import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CommandResult,
  ConnectScannerRequest,
  DiscoveredScanner,
  DiscoveryState,
  DomainError,
} from '@shared';
import { Modal } from '../components/Modal';
import { Segments } from '../components/Segments';
import { errorTextInline } from '../state/error-text';
import './device-modal.css';

// Модалка `device` (план M1, U21; UI_SPEC 7.1 с поправками техбазы; handoff U19, S7–S11).
// Открытие запускает поиск, закрытие останавливает его и отменяет идущее подключение — обе
// команды уходят при размонтировании. Выбор в списке и ввод адреса исключают друг друга.
// Позднее завершение отменённого подключения ничего не меняет: ответ после закрытия отброшен.

/** Через сколько пустой список при идущем поиске заменяется текстом S7 (KTD-14). */
export const EMPTY_SEARCH_DELAY_MS = 10_000;

const SCHEMES = ['https', 'http'] as const;
type Scheme = (typeof SCHEMES)[number];
/** Дефолтный порт схемы — показывается плейсхолдером (техбаза: HTTPS · 443 · /eSCL). */
const DEFAULT_PORTS: Record<Scheme, string> = { https: '443', http: '80' };

export interface DeviceModalProps {
  /** Адрес запомненного сканера — «Подключить заново» открывает модалку с ним (S4). */
  readonly initialAddress?: string | undefined;
  readonly onClose: () => void;
  /** Подключение прошло: подпись для тоста «Сканер подключён: …». */
  readonly onConnected: (label: string) => void;
}

export function DeviceModal({ initialAddress, onClose, onConnected }: DeviceModalProps): ReactNode {
  const { t } = useTranslation();
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null);
  const [waited, setWaited] = useState(false);
  const [selected, setSelected] = useState<DiscoveredScanner | null>(null);
  const [host, setHost] = useState(initialAddress ?? '');
  const [advancedOpen, setAdvancedOpen] = useState(initialAddress !== undefined);
  // `null` — схема не названа: уходит в ядро как есть, то разберёт её из хоста-URL; на
  // сегментах при этом подсвечен HTTPS — дефолт ядра.
  const [scheme, setScheme] = useState<Scheme | null>(null);
  const [port, setPort] = useState('');
  const [path, setPath] = useState('');
  const [connecting, setConnecting] = useState<string | null>(null);
  const [failure, setFailure] = useState<DomainError | 'emptyInput' | null>(null);
  const closed = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Сброс — для повторного монтирования StrictMode: cleanup первого прогона взвёл флаг.
    closed.current = false;
    // Ответы на запросы списка применяются только от последнего запроса: событие поиска могло
    // обогнать ответ на `startDiscovery`, и старый список не должен затирать новый.
    let latest = 0;
    const request = (promise: Promise<CommandResult<'getDiscovery'>>): void => {
      latest += 1;
      const id = latest;
      promise.then(
        (result) => {
          if (!closed.current && result.ok && id === latest) {
            setDiscovery(result.value);
          }
        },
        (error: unknown) => {
          console.error('[renderer] поиск сканеров не прочитан', error);
        },
      );
    };

    request(window.api.startDiscovery());
    const unsubscribe = window.api.onDiscoveryChanged(() => {
      request(window.api.getDiscovery());
    });
    const timer = setTimeout(() => {
      setWaited(true);
    }, EMPTY_SEARCH_DELAY_MS);

    return () => {
      closed.current = true;
      clearTimeout(timer);
      unsubscribe();
      // Найденное ядро сохраняет до следующего поиска — подключение по id переживает стоп.
      window.api.stopDiscovery().catch((error: unknown) => {
        console.error('[renderer] поиск не остановлен', error);
      });
      window.api.cancelConnect().catch((error: unknown) => {
        console.error('[renderer] подключение не отменено', error);
      });
    };
  }, []);

  // «Подключить» выпадает из обхода на время подключения — фокус переносится на «Отмена» (S10).
  useEffect(() => {
    if (connecting !== null) {
      cancelRef.current?.focus();
    }
  }, [connecting]);

  const scanners = discovery?.scanners ?? [];
  const searchFailure = discovery?.failure ?? null;

  const select = (scanner: DiscoveredScanner): void => {
    if (!scanner.hasAdf || connecting !== null) {
      return;
    }
    setSelected(scanner);
    // Два источника адреса не бывают активны одновременно: выбор очищает поле.
    setHost('');
    setFailure(null);
  };

  const optionKeyDown = (event: KeyboardEvent<HTMLElement>, scanner: DiscoveredScanner): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(scanner);
    }
  };

  const connect = (): void => {
    if (connecting !== null) {
      return;
    }
    const trimmed = host.trim();
    let request: ConnectScannerRequest;
    let label: string;
    if (selected !== null) {
      request = { kind: 'discovered', id: selected.id };
      label = selected.name ?? `${selected.address}:${selected.port}`;
    } else if (trimmed !== '') {
      request = {
        kind: 'address',
        host: trimmed,
        scheme,
        port: port.trim() === '' ? null : Number(port),
        basePath: path.trim() === '' ? null : path.trim(),
      };
      label = trimmed;
    } else {
      // Пустой ввод без выбора — подсказка в статусной строке, а не запрос.
      setFailure('emptyInput');
      return;
    }

    setFailure(null);
    setConnecting(label);
    window.api.connectScanner(request).then(
      (result) => {
        if (closed.current) {
          return;
        }
        if (result.ok) {
          onConnected(label);
          onClose();
          return;
        }
        setConnecting(null);
        // Отказ не сбрасывает ни выбор, ни поле (S11); `canceled` текста не даёт.
        if (result.error.code !== 'canceled') {
          setFailure(result.error);
        }
      },
      (error: unknown) => {
        console.error('[renderer] подключение не ответило', error);
        if (!closed.current) {
          setConnecting(null);
        }
      },
    );
  };

  const failureText = (error: DomainError): string =>
    error.code === 'invalidInput'
      ? t('device.address.invalid')
      : t('device.connectFailed', { error: errorTextInline(t, error) });

  let status: ReactNode;
  if (connecting !== null) {
    status = (
      <p className="modal__status" role="status" aria-live="polite">
        {t('device.connectingTo', { target: connecting })}
      </p>
    );
  } else if (failure === 'emptyInput') {
    status = (
      <p className="modal__status modal__status--danger" role="alert">
        {t('device.address.empty')}
      </p>
    );
  } else if (failure !== null) {
    status = (
      <p className="modal__status modal__status--danger" role="alert">
        {failureText(failure)}
      </p>
    );
  } else if (searchFailure !== null) {
    // Текст сбоя стоит в области списка (S8) — статусная строка пустая.
    status = <p className="modal__status" />;
  } else if (scanners.length > 0) {
    status = (
      <p className="modal__status" role="status">
        {t('device.search.found', { count: scanners.length })}
      </p>
    );
  } else {
    status = (
      <p className="modal__status" role="status">
        {t('device.search.searching')}
      </p>
    );
  }

  let list: ReactNode;
  if (searchFailure !== null) {
    list = (
      <div className="device-list device-list--failed">
        <p className="device-list__empty device-list__empty--danger" role="alert">
          {t(`device.search.failure.${searchFailure}`)}
        </p>
      </div>
    );
  } else if (scanners.length === 0) {
    list = waited ? (
      <div className="device-list device-list--empty">
        <p className="device-list__empty">{t('device.search.empty')}</p>
      </div>
    ) : (
      <div className="device-list" aria-hidden="true">
        <span className="device-skeleton" />
        <span className="device-skeleton" />
        <span className="device-skeleton" />
      </div>
    );
  } else {
    list = (
      <div className="device-list" role="listbox" aria-label={t('device.listLabel')}>
        {scanners.map((scanner) => {
          const classes = [
            'device-item',
            scanner.id === selected?.id ? 'device-item--selected' : null,
            scanner.hasAdf ? null : 'device-item--disabled',
          ]
            .filter((name) => name !== null)
            .join(' ');
          return (
            <div
              key={scanner.id}
              role="option"
              aria-selected={scanner.id === selected?.id}
              aria-disabled={scanner.hasAdf ? undefined : true}
              tabIndex={scanner.hasAdf ? 0 : -1}
              className={classes}
              onClick={() => {
                select(scanner);
              }}
              onKeyDown={(event) => {
                optionKeyDown(event, scanner);
              }}
            >
              <div className="device-item__main">
                <div
                  className={
                    scanner.name === null
                      ? 'device-item__name device-item__name--unnamed'
                      : 'device-item__name'
                  }
                >
                  {scanner.name ?? t('device.item.unnamed')}
                </div>
                {/* Адрес и порт видны у всех найденных — их не прячут (S9). */}
                <div className="device-item__address">
                  {scanner.address}:{scanner.port}
                </div>
              </div>
              <div
                className={
                  scanner.hasAdf
                    ? 'device-item__status'
                    : 'device-item__status device-item__status--no-adf'
                }
              >
                {scanner.hasAdf ? t('device.item.status.ready') : t('device.item.status.noAdf')}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <Modal labelledBy="device-title" busy={connecting !== null} className="device-modal">
      <header className="modal__header">
        <h2 id="device-title" className="modal__title">
          {t('device.title')}
        </h2>
      </header>

      <div className="modal__body">
        <div className="modal__section">
          <div className="kicker">{t('device.sectionScanners')}</div>
          {list}
        </div>

        <div className="modal__section">
          <div className="kicker">{t('device.sectionAddress')}</div>
          <input
            className="input"
            placeholder={t('device.address.placeholder')}
            aria-label={t('device.sectionAddress')}
            value={host}
            onChange={(event) => {
              // Ввод адреса снимает выбор в списке — и наоборот.
              setHost(event.target.value);
              setSelected(null);
              setFailure(null);
            }}
          />
          <button
            type="button"
            className="device-advanced__toggle"
            aria-expanded={advancedOpen}
            onClick={() => {
              setAdvancedOpen((open) => !open);
            }}
          >
            {t('device.advanced.toggle')}
            <span aria-hidden="true">{advancedOpen ? '▴' : '▾'}</span>
          </button>
          {advancedOpen && (
            <div className="device-advanced">
              <div className="field">
                <span className="field__label">{t('device.advanced.scheme')}</span>
                <Segments<Scheme>
                  label={t('device.advanced.scheme')}
                  values={SCHEMES}
                  selected={scheme ?? 'https'}
                  format={(value) => value.toUpperCase()}
                  onSelect={(value) => {
                    setScheme(value);
                    setFailure(null);
                  }}
                />
              </div>
              <label className="field device-advanced__port">
                <span className="field__label">{t('device.advanced.port')}</span>
                <input
                  className="input input--small"
                  inputMode="numeric"
                  placeholder={DEFAULT_PORTS[scheme ?? 'https']}
                  value={port}
                  onChange={(event) => {
                    setPort(event.target.value.replace(/\D/g, '').slice(0, 5));
                    setFailure(null);
                  }}
                />
              </label>
              <label className="field device-advanced__path">
                <span className="field__label">{t('device.advanced.path')}</span>
                <input
                  className="input input--small"
                  placeholder="/eSCL"
                  value={path}
                  onChange={(event) => {
                    setPath(event.target.value);
                    setFailure(null);
                  }}
                />
              </label>
            </div>
          )}
        </div>
      </div>

      <footer className="modal__footer">
        {status}
        <button ref={cancelRef} type="button" className="btn btn--ghost" onClick={onClose}>
          {t('device.cancel')}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={connecting !== null}
          aria-busy={connecting !== null ? true : undefined}
          onClick={connect}
        >
          {connecting !== null ? t('device.connecting') : t('device.connect')}
        </button>
      </footer>
    </Modal>
  );
}
