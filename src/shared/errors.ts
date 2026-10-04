// Доменные ошибки моста (ADR 0005). Команда возвращает результат-конверт: успех со значением или
// отказ с кодом. Текст для пользователя живёт в локали интерфейса и выбирается по коду — ядро
// отдаёт данные, не текст. Отказ `invoke` остаётся только для ошибок программы: нарушение
// контракта, чужой отправитель, баг.
//
// Каждый новый код — строка здесь и строка в `errors.<код>` локали.

export const ERROR_CODES = [
  'invalidInput',
  // Ответ устройства не разобран: не XML, не UTF-8, с DOCTYPE, больше потолка. Причина — в деталях.
  'scannerBadResponse',
  'notEsclScanner',
  'scannerNoAdf',
  'scannerNoJpeg',
  // Параметр сканирования, которого нет у устройства; какой именно — в деталях (`field`).
  'scanParamsUnsupported',
  // Соединение со сканером не состоялось или оборвалось; причина — в деталях (`reason`).
  'scannerUnreachable',
  // По адресу сканера отвечает устройство с другим сертификатом (план M1, KTD-40).
  'scannerCertificateChanged',
  // Действие требует подключённого сканера, а его нет: не подключали, не ответил при запуске.
  'scannerNotConnected',
  // В лотке автоподачи нет бумаги: по статусу перед заданием или задание кончилось без страниц (R9).
  'scanNoPaper',
  // Устройство занято дольше потолка ожидания: `POST /ScanJobs` отвечает `503`.
  'scannerBusy',
  // Устройство ответило `409` на параметры задания: заявило их в capabilities, но не берёт.
  'scanParamsRejected',
  // Устройство оборвало задание: сбой подачи (`410`) или страница так и не стала готова.
  'scanFeedFailed',
  // Операция отменена самим приложением: «Остановить», закрытие окна, новое подключение.
  'canceled',
  // На диске не хватает места: перед проходом или при записи страницы и журнала.
  'storageFull',
  // Запись или удаление на диске не удались; код файловой системы — в деталях (`reason`).
  'storageFailed',
  // В каталоге данных лежат данные более новой версии приложения: хранилище в режиме отказа и
  // ничего не меняет (план M1, KTD-35).
  'storageIncompatible',
  // Действие недопустимо в текущем состоянии сессии; какое именно — в деталях (`reason`):
  // проход идёт, прохода нет, проход не прерван, параметры прохода неизвестны.
  'sessionConflict',
  // Каталог сессии не удалось закрыть: сессия осталась целой и рабочей (KTD-33).
  'sessionCloseFailed',
  // Страницы с таким ключом нет в текущей сессии или её файл потерян (`reason`).
  'pageUnavailable',
  // Сборка PDF (M2, U5): страница больше предела пикселей, с которым работает приложение.
  'pdfPageTooLarge',
  // Сборка PDF (M2, U5): файл страницы не читается как JPEG-изображение.
  'pdfPageUnreadable',
  // Запись PDF в выбранный пользователем файл не удалась (M2, U6); код ФС — в деталях.
  'saveWriteFailed',
  // Миниатюра не построилась: исходник не JPEG, больше предела пикселей, не декодируется.
  'thumbnailFailed',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Почему действие недоступно (`sessionConflict`, `details.reason`): интерфейс выбирает текст по
 * причине, поэтому набор — контракт, а не свободная строка.
 */
export const SESSION_CONFLICT_REASONS = [
  /** Идёт проход: второй старт, «Новое сканирование», «оставить как есть» отклоняются. */
  'passRunning',
  /** Прохода нет: «Остановить» опоздало. */
  'noRunningPass',
  /** «Остановить» уже нажато и ещё не доведено. */
  'stopping',
  /** Последний проход не прерван: досканировать и принимать нечего. */
  'notInterrupted',
  /** Журнал пересобран по файлам: параметры прохода неизвестны. */
  'paramsUnknown',
  /** Досканировать можно только на сканере прохода (KTD-27). */
  'otherScanner',
  /** Сессии нет. */
  'noSession',
  /** В наборе нет прохода оборотов: поворачивать нечего (M2, KTD-2). */
  'noBacksPass',
  /** Обороты уже отсканированы: «обороты не нужны» опоздало, новый проход не нужен (M2). */
  'backsPresent',
  /** От оборотов отказались: набор закрыт односторонним, новый проход не начинается (M2). */
  'backsDeclined',
] as const;

export type SessionConflictReason = (typeof SESSION_CONFLICT_REASONS)[number];

export function sessionConflict(reason: SessionConflictReason): DomainError {
  return { code: 'sessionConflict', details: { reason } };
}

/** Детали — для диагностики и подстановок в текст; только то, что переживает structured clone. */
export type ErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

export interface DomainError {
  readonly code: ErrorCode;
  readonly details?: ErrorDetails;
}

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DomainError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(code: ErrorCode, details?: ErrorDetails): Result<never> {
  return { ok: false, error: details === undefined ? { code } : { code, details } };
}
