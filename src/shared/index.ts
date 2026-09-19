// Контракт между процессами и общие типы. Это не слой, а контракт: здесь нет ни Node, ни DOM,
// ни Electron.

export const APP_NAME = "Duplexn't";

export {
  BRIDGE_CHANNELS,
  PROBE_TOKEN_MAX_LENGTH,
  type Api,
  type BridgeCommand,
  type BridgeCommands,
  type BridgeHandlers,
  type ProbeRequest,
  type ProbeResult,
} from './bridge';
