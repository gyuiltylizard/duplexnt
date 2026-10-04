// Контракт между процессами и общие типы. Это не слой, а контракт: здесь нет ни Node, ни DOM,
// ни Electron.

export const APP_NAME = "Duplexn't";

export {
  BRIDGE_CHANNELS,
  BRIDGE_EVENT_CHANNELS,
  PAGE_IMAGE_SCHEME,
  PAGE_IMAGE_VIEWS,
  pageImageUrl,
  PROBE_TOKEN_MAX_LENGTH,
  type Api,
  type BridgeCommand,
  type BridgeCommands,
  type BridgeEvent,
  type BridgeEvents,
  type BridgeHandlers,
  type CommandResult,
  type CommandsApi,
  type ConnectScannerRequest,
  type EventsApi,
  type NoRequest,
  type PageImageView,
  type ProbeRequest,
  type ProbeResult,
  type Unsubscribe,
} from './bridge';

export type { DiscoveredScanner, DiscoveryState } from './discovery';

export {
  COLOR_MODES,
  DEFAULT_SCAN_PARAMS,
  PAPER_SIZES,
  resolveScanParams,
  type ColorMode,
  type PaperSize,
  type ScanOptions,
  type ScanParams,
} from './scan-params';

export type {
  PageSnapshot,
  PassProgress,
  PassReport,
  PassSnapshot,
  PassState,
  ScannerInfo,
  ScannerState,
  SessionSnapshot,
  Snapshot,
  StartupNotice,
} from './snapshot';

export {
  ERROR_CODES,
  fail,
  ok,
  SESSION_CONFLICT_REASONS,
  sessionConflict,
  type SessionConflictReason,
  type DomainError,
  type ErrorCode,
  type ErrorDetails,
  type Result,
} from './errors';
