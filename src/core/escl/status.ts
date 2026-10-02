import { fail, ok, type Result } from '@shared';
import {
  childOf,
  childrenOf,
  isElement,
  NS_PWG,
  NS_SCAN,
  parseXml,
  textOf,
  uintOf,
  type XmlElement,
} from './xml';

// Разбор `ScannerStatus` (ADR 0006). Неизвестное значение состояния даёт `null`, а не строку
// устройства: дальше по коду идут только значения перечислений.

export const SCANNER_STATES = ['Idle', 'Processing', 'Testing', 'Stopped', 'Down'] as const;
export type ScannerState = (typeof SCANNER_STATES)[number];

// С ET-3850 сняты `Empty`, `Loaded`, `Processing` и `Jam` (журнал M1, U1); остальные — из
// спецификации eSCL.
export const ADF_STATES = [
  'ScannerAdfEmpty',
  'ScannerAdfLoaded',
  'ScannerAdfProcessing',
  'ScannerAdfJam',
  'ScannerAdfMispick',
  'ScannerAdfHatchOpen',
  'ScannerAdfDuplexPageTooShort',
  'ScannerAdfDuplexPageTooLong',
  'ScannerAdfMultipickDetected',
  'ScannerAdfInputTrayFailed',
  'ScannerAdfInputTrayOverloaded',
] as const;
export type AdfState = (typeof ADF_STATES)[number];

export const JOB_STATES = ['Pending', 'Processing', 'Completed', 'Canceled', 'Aborted'] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface ScanJobInfo {
  /** Адрес задания, как его назвало устройство. Это данные: перед запросом — проверка пути. */
  readonly uri: string;
  readonly state: JobState | null;
  readonly imagesCompleted: number | null;
  /** Секунды с последнего обращения к заданию. */
  readonly age: number | null;
}

export interface ScannerStatus {
  readonly state: ScannerState | null;
  /** `null` — устройство не сообщило состояние лотка или сообщило неизвестное. */
  readonly adfState: AdfState | null;
  /** В порядке устройства: ET-3850 держит два последних задания, идущее — первым. */
  readonly jobs: readonly ScanJobInfo[];
}

const JOB_URI_MAX_LENGTH = 512;

function oneOf<T extends string>(values: readonly T[], value: string | null): T | null {
  return values.find((it) => it === value) ?? null;
}

function jobOf(info: XmlElement): ScanJobInfo[] {
  const uri = textOf(info, NS_PWG, 'JobUri');
  if (uri === null || uri === '' || uri.length > JOB_URI_MAX_LENGTH) {
    return [];
  }
  return [
    {
      uri,
      state: oneOf(JOB_STATES, textOf(info, NS_PWG, 'JobState')),
      imagesCompleted: uintOf(info, NS_PWG, 'ImagesCompleted'),
      age: uintOf(info, NS_SCAN, 'Age'),
    },
  ];
}

export function parseStatus(bytes: Uint8Array): Result<ScannerStatus> {
  const parsed = parseXml(bytes);
  if (!parsed.ok) {
    return parsed;
  }
  const root = parsed.value;
  if (!isElement(root, NS_SCAN, 'ScannerStatus')) {
    return fail('notEsclScanner');
  }

  const jobs = childOf(root, NS_SCAN, 'Jobs');
  return ok({
    state: oneOf(SCANNER_STATES, textOf(root, NS_PWG, 'State')),
    adfState: oneOf(ADF_STATES, textOf(root, NS_SCAN, 'AdfState')),
    jobs: jobs === null ? [] : childrenOf(jobs, NS_SCAN, 'JobInfo').flatMap(jobOf),
  });
}
