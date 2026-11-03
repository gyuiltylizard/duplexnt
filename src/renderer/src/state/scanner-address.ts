import type { ScannerInfo, ScannerState } from '@shared';

/**
 * Адрес для поля модалки `device`: хост с портом — порт различает две записи одного
 * устройства. Один формат на все пути «Подключить заново» (S4, S6, S17).
 */
export const addressOf = (scanner: ScannerInfo): string => `${scanner.host}:${scanner.port}`;

/** Имя сканера для строки устройства; без имени — хост (одно правило на `setup` и `add`). */
export const scannerLabel = (scanner: ScannerInfo): string => scanner.name ?? scanner.host;

/** Адрес запомненного сканера для «Подключить заново»; сканера нет — модалка без адреса. */
export const reconnectAddress = (state: ScannerState): string | undefined =>
  state.kind === 'none' ? undefined : addressOf(state.scanner);

/**
 * Прерванный проход заменён (B-29, KTD-10): сканер готов, досканировать нельзя, а хост сканера
 * прохода совпадает с текущим — по этому адресу теперь другое устройство, и ссылка «подключите
 * заново» бессмысленна. Другой сканер на другом хосте — прежняя плашка со ссылкой. Вызывающий
 * проверяет `canResume` сам: признак отвечает только за «тот же адрес».
 */
export const isPassReplaced = (state: ScannerState, passScanner: ScannerInfo | null): boolean =>
  state.kind === 'ready' && passScanner !== null && passScanner.host === state.scanner.host;
