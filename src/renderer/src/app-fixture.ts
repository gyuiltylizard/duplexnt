import { ok, type Api, type DiscoveredScanner, type ScannerState, type Snapshot } from '@shared';
import { vi } from 'vitest';
import { assemblyOf } from './state/assembly-fixture';

// Общий пролог тестов App (разрез `App.test.tsx` по правилу размера тестового файла, M3.5):
// снимок по умолчанию, сканер, фикстура страниц и заглушка моста.

export function makeSnapshot(overrides: Partial<Snapshot>): Snapshot {
  const snapshot: Snapshot = {
    seq: 1,
    scanner: { kind: 'none' },
    session: null,
    assembly: null,
    pass: null,
    canResume: false,
    canAccept: false,
    storage: { incompatible: false, unsaved: false },
    notices: [],
    blankMode: 'hide',
    ...overrides,
  };
  if (snapshot.session !== null && snapshot.assembly === null) {
    return { ...snapshot, assembly: assemblyOf(snapshot.session) };
  }
  return snapshot;
}

export const PARAMS = { colorMode: 'Grayscale8', resolution: 300, paperSize: 'A4' } as const;

export const READY: ScannerState = {
  kind: 'ready',
  scanner: { name: 'ScanPro 200', scheme: 'https', host: '192.0.2.10', port: 443 },
  options: { colorModes: ['Grayscale8'], resolutions: [300], paperSizes: ['A4'] },
  params: PARAMS,
};

export const FOUND: DiscoveredScanner = {
  id: 'abcdef01-1',
  name: 'ScanPro 200',
  address: '192.0.2.10',
  port: 443,
  hasAdf: true,
};

export function pages(count: number, from = 1): { key: string; number: number; lost: boolean }[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `p01-s01-${String(from + index).padStart(4, '0')}`,
    number: from + index,
    lost: false,
  }));
}

export function stubApi(snapshot: Snapshot, overrides: Partial<Record<keyof Api, unknown>> = {}) {
  const unsubscribe = vi.fn();
  const api = {
    getSnapshot: vi.fn(() => Promise.resolve(ok(snapshot))),
    onSnapshotChanged: vi.fn(() => unsubscribe),
    onDiscoveryChanged: vi.fn(() => () => undefined),
    startDiscovery: vi.fn(() => Promise.resolve(ok({ scanners: [], failure: null }))),
    getDiscovery: vi.fn(() => Promise.resolve(ok({ scanners: [], failure: null }))),
    stopDiscovery: vi.fn(() => Promise.resolve(ok(undefined))),
    cancelConnect: vi.fn(() => Promise.resolve(ok(undefined))),
    connectScanner: vi.fn(() => Promise.resolve(ok(undefined))),
    setScanParams: vi.fn(() => Promise.resolve(ok(undefined))),
    setBlankMode: vi.fn(() => Promise.resolve(ok(undefined))),
    recheckScanner: vi.fn(() => Promise.resolve(ok(undefined))),
    startPass: vi.fn(() => new Promise(() => undefined)),
    stopPass: vi.fn(() => Promise.resolve(ok(undefined))),
    acceptPass: vi.fn(() => Promise.resolve(ok(undefined))),
    closeSession: vi.fn(() => Promise.resolve(ok(undefined))),
    ...overrides,
  } as unknown as Api;
  vi.stubGlobal('api', api);
  return { unsubscribe };
}
