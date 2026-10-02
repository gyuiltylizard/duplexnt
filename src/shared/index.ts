// Контракт между процессами и общие типы. Это не слой, а контракт: здесь нет ни Node, ни DOM,
// ни Electron.

export const APP_NAME = "Duplexn't";

export {
  BRIDGE_CHANNELS,
  BRIDGE_EVENT_CHANNELS,
  PROBE_TOKEN_MAX_LENGTH,
  type Api,
  type BridgeCommand,
  type BridgeCommands,
  type BridgeEvent,
  type BridgeEvents,
  type BridgeHandlers,
  type CommandResult,
  type CommandsApi,
  type EventsApi,
  type ProbeRequest,
  type ProbeResult,
  type Unsubscribe,
} from './bridge';

export type { DiscoveredScanner, DiscoveryState } from './discovery';

export {
  ERROR_CODES,
  fail,
  ok,
  type DomainError,
  type ErrorCode,
  type ErrorDetails,
  type Result,
} from './errors';
