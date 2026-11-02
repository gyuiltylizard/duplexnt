import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CommandResult,
  ConnectScannerOutcome,
  ConnectScannerRequest,
  DiscoveredScanner,
  DiscoveryState,
  DomainError,
} from '@shared';
import { Modal } from '../components/Modal';
import { Segments } from '../components/Segments';
import { errorTextInline } from '../state/error-text';
import { addressOf, scannerLabel } from '../state/scanner-address';
import './device-modal.css';
import { isValidPort } from '@shared';

// Модалка `device` (план M1, U21; UI_SPEC 7.1 с поправками техбазы; handoff U19, S7–S11).
// Открытие запускает поиск, закрытие останавливает его и отменяет идущее подключение — обе
// команды уходят при размонтировании. Выбор в списке и ввод адреса исключают друг друга.
// Позднее завершение отменённого подключения ничего не меняет: ответ после закрытия отброшен.
//
// Шаг подтверждения смены устройства (B-29; handoff `scanner-change`, вариант 1b): ядро
// ответило «нужно подтверждение» — список и «Дополнительно» скрыты, поле адреса приглушено с
// прежним вводом, под ним карточка; подтверждение шлёт только токен показанной пробы. Фокус —
// на «Отмене», чтобы Enter по привычке не проскочил шаг.

/** Через сколько пустой список при идущем поиске заменяется текстом S7 (KTD-14). */
export const EMPTY_SEARCH_DELAY_MS = 10_000;

const SCHEMES = ['https', 'http'] as const;
type Scheme = (typeof SCHEMES)[number];
/** Дефолтный порт схемы — показывается плейсхолдером (техбаза: HTTPS · 443 · /eSCL). */
const DEFAULT_PORTS: Record<Scheme, string> = { https: '443', http: '80' };

type Confirmation = Extract<ConnectScannerOutcome, { kind: 'confirmation' }>;

/**
 * Отказы со своим текстом: пустой ввод и негодный порт — до запроса; `confirmStale` и
 * `confirmBusy` — отказы подтверждения смены устройства (handoff `scanner-change`, Copy).
 */
type Failure = DomainError | 'emptyInput' | 'invalidPort' | 'confirmStale' | 'confirmBusy';

export interface DeviceModalProps {
  /** Адрес запомненного сканера — «Подключить заново» открывает модалку с ним (S4). */
  readonly initialAddress?: string | undefined;
  readonly onClose: () => void;
  /**
   * Подключение прошло: подпись для тоста «Сканер подключён: …». `settingsSaved: false` — смена
   * устройства подтверждена, но настройки не записались: тост предупреждает (решение автора).
   */
  readonly onConnected: (label: string, settingsSaved?: boolean) => void;
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
  const [failure, setFailure] = useState<Failure | null>(null);
  // Шаг подтверждения: показанная проба с токеном; `confirming` — подтверждение в полёте.
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const closed = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const stepShown = useRef(false);

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
      // Гасит и идущее подключение, и ожидающую пробу смены устройства (B-29).
      window.api.cancelConnect().catch((error: unknown) => {
        console.error('[renderer] подключение не отменено', error);
      });
    };
  }, []);

  // «Подключить» выпадает из обхода на время подключения — фокус переносится на «Отмена» (S10).
  // В шаге подтверждения фокус тоже на «Отмене»: Enter по привычке шаг не проскакивает.
  useEffect(() => {
    if (connecting !== null || confirming || confirmation !== null) {
      cancelRef.current?.focus();
    }
  }, [connecting, confirming, confirmation]);

  // Возврат к вводу из шага — отменой или отказом — ставит фокус в поле адреса.
  useEffect(() => {
    if (confirmation !== null) {
      stepShown.current = true;
    } else if (stepShown.current) {
      stepShown.current = false;
      addressRef.current?.focus();
    }
  }, [confirmation]);

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
      // Порт проверяется здесь (B-17): схема main отвергнет его как `invalidInput` без поля, а
      // пользователю нужен текст именно про порт. Фильтр ввода пропускает до пяти цифр.
      const portNumber = port.trim() === '' ? null : Number(port);
      if (portNumber !== null && !isValidPort(portNumber)) {
        setFailure('invalidPort');
        return;
      }
      request = {
        kind: 'address',
        host: trimmed,
        scheme,
        port: portNumber,
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
        if (result.ok && result.value.kind === 'connected') {
          // Имя — из ответа ядра (B-17): снимок в этот момент может быть ещё прежним.
          onConnected(result.value.scanner.name ?? label);
          onClose();
          return;
        }
        setConnecting(null);
        if (result.ok) {
          // Устройство не доказано тем же (B-29): шаг подтверждения с показанной пробой.
          if (result.value.kind === 'confirmation') {
            setConfirmation(result.value);
          }
          return;
        }
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

  // «Подключить это устройство»: только токен показанной пробы (KTD-7); одно подтверждение на
  // шаг — повторное нажатие и Enter во время ожидания ничего не делают.
  const confirm = (): void => {
    if (confirmation === null || confirming) {
      return;
    }
    const { token, scanner } = confirmation;
    setFailure(null);
    setConfirming(true);
    window.api.confirmScannerChange({ token }).then(
      (result) => {
        if (closed.current) {
          return;
        }
        if (result.ok) {
          onConnected(result.value.scanner.name ?? addressOf(scanner), result.value.settingsSaved);
          onClose();
          return;
        }
        // Любой отказ возвращает к вводу с нетронутым полем; проба в ядре уже погашена.
        setConfirming(false);
        setConfirmation(null);
        const { error } = result;
        if (error.code === 'scannerChangeStale') {
          setFailure('confirmStale');
        } else if (error.code === 'sessionConflict' && error.details?.reason === 'passRunning') {
          setFailure('confirmBusy');
        } else if (error.code !== 'canceled') {
          setFailure(error);
        }
      },
      (error: unknown) => {
        console.error('[renderer] подтверждение смены устройства не ответило', error);
        if (!closed.current) {
          setConfirming(false);
          setConfirmation(null);
        }
      },
    );
  };

  // «Отмена» в шаге: назад к вводу, прежний сканер остаётся, проба в ядре гасится.
  const cancelStep = (): void => {
    setConfirmation(null);
    window.api.cancelConnect().catch((error: unknown) => {
      console.error('[renderer] проба смены устройства не отменена', error);
    });
  };

  const failureText = (error: Failure): string => {
    switch (error) {
      case 'emptyInput':
        return t('device.address.empty');
      case 'invalidPort':
        return t('device.address.invalidPort');
      case 'confirmStale':
        return t('device.confirm.failStale');
      case 'confirmBusy':
        return t('device.confirm.failBusy');
      default:
        return error.code === 'invalidInput'
          ? t('device.address.invalid')
          : t('device.connectFailed', { error: errorTextInline(t, error) });
    }
  };

  const inStep = confirmation !== null;
  const waiting = connecting !== null || confirming;

  let status: ReactNode;
  if (connecting !== null || (confirming && confirmation !== null)) {
    status = (
      <p className="modal__status" role="status" aria-live="polite">
        {t('device.connectingTo', {
          target: connecting ?? (confirmation === null ? '' : scannerLabel(confirmation.scanner)),
        })}
      </p>
    );
  } else if (failure !== null) {
    status = (
      <p className="modal__status modal__status--danger" role="alert">
        {failureText(failure)}
      </p>
    );
  } else if (inStep || searchFailure !== null) {
    // В шаге статусная строка пуста; текст сбоя поиска стоит в области списка (S8).
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

  // Карточка шага: что ответило, кого заменит, цена смены — строка только когда она есть
  // (прерванный проход или ожидание оборотов; обе сразу не встречаются).
  let step: ReactNode = null;
  if (confirmation !== null) {
    const cost = confirmation.awaitingBacks
      ? t('device.confirm.costFlip')
      : confirmation.interruptedPass
        ? t('device.confirm.costInterrupted')
        : null;
    const describedBy = ['device-confirm-text', 'device-confirm-replace'];
    if (cost !== null) {
      describedBy.push('device-confirm-cost');
    }
    step = (
      <div
        className="device-confirm device-confirm--enter"
        role="alertdialog"
        aria-labelledby="device-confirm-title"
        aria-describedby={describedBy.join(' ')}
      >
        <h3 className="device-confirm__title" id="device-confirm-title">
          {t('device.confirm.title')}
        </h3>
        <div className="device-confirm__who">
          <span
            className={
              confirmation.scanner.name === null
                ? 'device-confirm__name device-confirm__name--unnamed'
                : 'device-confirm__name'
            }
          >
            {confirmation.scanner.name ?? t('device.confirm.unnamed')}
          </span>
          <span className="device-confirm__address">{addressOf(confirmation.scanner)}</span>
        </div>
        <p className="device-confirm__text" id="device-confirm-text">
          {t('device.confirm.text')}
        </p>
        <p className="device-confirm__replace" id="device-confirm-replace">
          <span className="device-confirm__replace-key">{t('device.confirm.replaceKey')}</span>
          <span>
            {t('device.confirm.replace', { name: scannerLabel(confirmation.remembered) })}
          </span>
        </p>
        {cost !== null && (
          <p className="device-confirm__cost" id="device-confirm-cost">
            {cost}
          </p>
        )}
      </div>
    );
  }

  return (
    <Modal
      labelledBy="device-title"
      busy={waiting}
      className={inStep ? 'device-modal device-modal--confirming' : 'device-modal'}
      // «Отмена» доступна и во время подключения — отменяет его (S10); Esc — она же (B-11).
      // Из шага Esc закрывает модалку: прежний сканер остаётся запомненным.
      onEscape={onClose}
    >
      <header className="modal__header">
        <h2 id="device-title" className="modal__title">
          {t('device.title')}
        </h2>
      </header>

      <div className="modal__body">
        <div className="device-modal__pick">
          {!inStep && (
            <div className="modal__section device-modal__list">
              <div className="kicker">{t('device.sectionScanners')}</div>
              {list}
            </div>
          )}

          <div className="modal__section">
            <div className="kicker">{t('device.sectionAddress')}</div>
            <input
              ref={addressRef}
              className="input"
              placeholder={t('device.address.placeholder')}
              aria-label={t('device.sectionAddress')}
              value={host}
              disabled={inStep}
              onChange={(event) => {
                // Ввод адреса снимает выбор в списке — и наоборот.
                setHost(event.target.value);
                setSelected(null);
                setFailure(null);
              }}
            />
            {!inStep && (
              <>
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
                        disabled={inStep}
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
                        disabled={inStep}
                        onChange={(event) => {
                          setPath(event.target.value);
                          setFailure(null);
                        }}
                      />
                    </label>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        {step}
      </div>

      <footer className="modal__footer">
        {status}
        <button
          ref={cancelRef}
          type="button"
          className="btn btn--ghost"
          onClick={inStep && !confirming ? cancelStep : onClose}
        >
          {t('device.cancel')}
        </button>
        {inStep ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={confirming}
            aria-busy={confirming ? true : undefined}
            onClick={confirm}
          >
            {confirming ? t('device.connecting') : t('device.confirm.action')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            disabled={connecting !== null}
            aria-busy={connecting !== null ? true : undefined}
            onClick={connect}
          >
            {connecting !== null ? t('device.connecting') : t('device.connect')}
          </button>
        )}
      </footer>
    </Modal>
  );
}
