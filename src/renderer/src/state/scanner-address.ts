import type { ScannerInfo } from '@shared';

/**
 * Адрес для поля модалки `device`: хост с портом — порт различает две записи одного
 * устройства. Один формат на все пути «Подключить заново» (S4, S6, S17).
 */
export const hostOf = (scanner: ScannerInfo): string => `${scanner.host}:${scanner.port}`;
