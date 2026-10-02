import { BRIDGE_EVENT_CHANNELS, type BridgeEvent, type BridgeEvents } from '@shared';

// Отправка событий main → renderer (ADR 0005). Событие — подсказка, а не источник правды: оно
// несёт номер, состояние интерфейс берёт командой-запросом. Electron не импортируется: окно
// описано структурно, как в ./bridge.ts.

interface EventWindow {
  isDestroyed(): boolean;
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

export type EventSender = <K extends BridgeEvent>(event: K, payload: BridgeEvents[K]) => void;

// Ядро сообщает о ходе работы и после закрытия окна: проход обрывается не мгновенно. Отправка в
// разрушенное окно бросила бы исключение посреди записи страницы — событие просто теряется.
export function createEventSender(window: EventWindow): EventSender {
  return (event, payload) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      return;
    }
    window.webContents.send(BRIDGE_EVENT_CHANNELS[event], payload);
  };
}
