import type { DomainError, Result } from '@shared';
import type { ConnectedScanner } from '../escl/connect';
import { sameScanner, storedScannerOf, type StoredScanner } from './stored-scanner';

// Исход пробы запомненного сканера (план M5, KTD1): одна функция вместо прежнего «молчит или
// нет». Класс решает, искать ли сканер по сети (U4) и какое состояние у строки устройства.
//
// | Класс      | Что ответило на адресе                                                         |
// | `ok`       | то же устройство                                                               |
// | `silent`   | никто: `scannerUnreachable` с любой причиной                                   |
// | `foreign`  | другое устройство: чужой сертификат, не сканер, негодный сканер, другой UUID   |
// | `busy`     | наш сканер занят дольше потолка ожидания                                       |
// | `garbled`  | наш сканер, но невнятно: ответ не разобран или `5xx`                           |
// | `canceled` | никто не успел: проверку отменили снаружи                                      |

export type ProbeClass = 'ok' | 'silent' | 'foreign' | 'busy' | 'garbled' | 'canceled';

function classOfError({ code, details }: DomainError): ProbeClass {
  switch (code) {
    case 'scannerUnreachable':
      return 'silent';
    case 'scannerBusy':
      return 'busy';
    case 'canceled':
      return 'canceled';
    case 'scannerBadResponse':
      return 'garbled';
    case 'notEsclScanner': {
      // `5xx` под сверенным отпечатком — сбой нашего сканера; `503` проба уже пережидает сама.
      const status = details?.status;
      return typeof status === 'number' && status >= 500 ? 'garbled' : 'foreign';
    }
    default:
      // Чужой сертификат, сканер без автоподачи или JPEG, негодные параметры — ответ другого
      // устройства.
      return 'foreign';
  }
}

export function classifyProbe(
  scanner: StoredScanner,
  probed: Result<ConnectedScanner>,
): ProbeClass {
  if (!probed.ok) {
    return classOfError(probed.error);
  }
  return sameScanner(scanner, storedScannerOf(probed.value)) ? 'ok' : 'foreign';
}
