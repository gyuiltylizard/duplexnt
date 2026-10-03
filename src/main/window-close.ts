// Закрытие окна во время прохода (план M1, KTD-26): ядро обрывает задание, помечает проход
// прерванным и отправляет `DELETE` в пределах срока — и только потом окно закрывается. Electron
// не импортируется: окно и служба описаны структурно, обработчик проверяется под обычным Node.

/**
 * Сколько ждать закрытия задания на устройстве; дольше окно не держится. Уже ушедший `POST` не
 * обрывается (KTD-10) и ждёт ответа до срока запроса транспорта (10 с), затем `DELETE` (5 с):
 * срок закрытия их покрывает, иначе задание осталось бы на устройстве без записи адреса.
 */
export const CLOSE_INTERRUPT_DEADLINE_MS = 16_000;

interface ClosingWindow {
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
  /** Закрывает окно без повторного события `close`. */
  destroy(): void;
}

interface InterruptibleService {
  /** Идёт ли проход. */
  isPassRunning(): boolean;
  interrupt(deadlineMs: number): Promise<void>;
}

export function installWindowClose(
  window: ClosingWindow,
  service: InterruptibleService,
  deadlineMs = CLOSE_INTERRUPT_DEADLINE_MS,
): void {
  let closing = false;
  window.on('close', (event) => {
    // Повторное закрытие, пока идёт прерывание, не прерывает его второй раз и не закрывает окно
    // раньше: иначе задание осталось бы незакрытым.
    if (closing) {
      event.preventDefault();
      return;
    }
    if (!service.isPassRunning()) {
      return;
    }
    // Первое закрытие откладывается: проход прерывается, окно уничтожается по завершении.
    event.preventDefault();
    closing = true;
    void service.interrupt(deadlineMs).finally(() => {
      window.destroy();
    });
  });
}
