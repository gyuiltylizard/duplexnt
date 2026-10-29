import {
  fail,
  ok,
  sessionConflict,
  type AssembledPage,
  type Result,
  type SaveDocumentsReport,
  type SaveDocumentsRequest,
  type SavedFile,
  type SaveMode,
  type SessionAssembly,
  type SessionConflictReason,
  type SessionSnapshot,
} from '@shared';
import { assemblePdf, type PdfPageInput } from '../pdf/assemble';
import { writeBatch } from '../pdf/save-batch';
import type { SessionStore } from '../storage/session-store';
import type { StorageIo } from '../storage/storage-fs';
import type { Straightened } from '../storage/straightened';
import { blankRefusal, shownSpansOf } from './blank-flow';
import { straightenRefusal, straightSnapshotOf, type StraightSnapshot } from './straighten-flow';

// Пакетное сохранение в службе проходов (план M3, U4; M4, KTD4; M6, U12, KTD-8): документы
// ленты (или вся лента одним файлом) в PDF по одному, best-effort. Выделено из службы по
// правилу размера файла: служба держит гарды состояния (`run`, `saving`, несовместимость,
// сессия), здесь — гарды ленты, незавершённый пакет и сборка PDF по снимку.
//
// Снимок выправленных страниц (KTD-8) берётся в начале пакета вместе с ревизией журнала:
// `buildPdf` читает байты только по нему, последовательно, подставляя выправленный файл при
// статусе «выправлена»; файла из снимка нет или он другого размера — сбой документа с
// причиной, не молчаливая подмена оригиналом. Повтор пакета сверяет ревизию и дайджест снимка:
// расхождение — отказ «данные изменились» и пересборка целиком.

/** Незавершённый пакет сохранения (M3, U4). */
interface PendingBatch {
  /** Пакет принадлежит сессии: после «Нового сканирования» повторять нечего. */
  readonly sessionId: string;
  readonly mode: SaveMode;
  readonly folder: string;
  readonly documents: number;
  /** Ревизия журнала первой попытки. */
  readonly revision: number;
  /** Выправленные страницы на момент первой попытки и их дайджест (KTD-8). */
  readonly straight: StraightSnapshot;
  readonly digest: string;
  /** Записанные — накопительно. */
  readonly written: readonly SavedFile[];
  /** Номера документов, которые ещё предстоит записать. */
  readonly failed: readonly number[];
}

export interface DocumentWriterDeps {
  readonly store: Pick<
    SessionStore,
    'snapshot' | 'revision' | 'pageInfo' | 'readPage' | 'markSaved'
  >;
  /** Сборка текущего снимка сессии — с оценками и фактами выравнивания службы. */
  readonly assemble: (session: SessionSnapshot) => SessionAssembly;
  readonly straightened: Pick<Straightened, 'resolve'>;
  readonly io: StorageIo;
  /** Отметка «сохранено» записана — новый снимок. */
  readonly onSaved: () => void;
}

export interface DocumentWriter {
  /** Пакет в папку; гарды состояния службы — до вызова. */
  write(folder: string, request: SaveDocumentsRequest): Promise<Result<SaveDocumentsReport>>;
  /** «Новое сканирование»: незавершённый пакет принадлежал закрытой сессии — повтора нет. */
  forget(): void;
  /** Папка последнего пакета, записанного хотя бы частично (M3.5, KTD-9); `null` — не было. */
  lastFolder(): string | null;
}

const conflict = (reason: SessionConflictReason): Result<never> => ({
  ok: false,
  error: sessionConflict(reason),
});

export function createDocumentWriter(deps: DocumentWriterDeps): DocumentWriter {
  const { store, straightened } = deps;
  /**
   * Незавершённый пакет (M3, U4): записанное накапливается, повтор пишет только неудавшиеся.
   * Ревизия и дайджест — первой попытки: правка или поздняя коррекция между попытками делает
   * уже записанные файлы устаревшими, и «сохранено» не ставится.
   */
  let pendingBatch: PendingBatch | null = null;
  let lastBatchFolder: string | null = null;

  /**
   * Страницы ленты → PDF: потерянная страница — отказ, а не молча короче (M2, R11); выправленная
   * — из снимка пакета (KTD-8), размер сверяется с записью о коррекции.
   */
  async function buildPdf(
    pages: readonly AssembledPage[],
    straight: StraightSnapshot,
  ): Promise<Result<Uint8Array>> {
    const inputs: PdfPageInput[] = [];
    for (const page of pages) {
      const info = store.pageInfo(page.key);
      const file = straight.get(page.key);
      let bytes: Result<Uint8Array>;
      if (file === undefined) {
        bytes = await store.readPage(page.key);
      } else {
        try {
          const read = await deps.io.fs.readFile(file.path);
          bytes =
            read.byteLength === file.bytes
              ? ok(read)
              : fail('pageUnavailable', { reason: 'straightened' });
        } catch {
          bytes = fail('pageUnavailable', { reason: 'straightened' });
        }
      }
      if (!bytes.ok) {
        return bytes;
      }
      inputs.push({
        bytes: bytes.value,
        angle: page.angle,
        dpi: info?.dpi ?? null,
        pixelLimit: info?.pixelLimit ?? null,
      });
    }
    return assemblePdf(inputs);
  }

  async function write(
    folder: string,
    request: SaveDocumentsRequest,
  ): Promise<Result<SaveDocumentsReport>> {
    const session = store.snapshot();
    if (session === null) {
      return conflict('noSession');
    }
    const assembly = deps.assemble(session);
    const { order, documents, report } = assembly;
    // Несобранный документ не сохраняется ни одним путём (M3.6, R16; KTD6): лента из двух
    // наборов — ещё не документ.
    if (report.mode === 'sets') {
      return conflict('notAssembled');
    }
    if (order.length === 0) {
      return conflict('nothingToSave');
    }
    // «Один файл» не смотрит на границы (R15): разрезы и имена в журнале остаются. Скрытые
    // пустые обороты в файл не идут (M4, R10): документы режутся по полной ленте, пишутся без них.
    const spans = shownSpansOf(
      request.mode === 'single'
        ? [order]
        : documents.map((doc) => order.slice(doc.start, doc.start + doc.count)),
    );
    if (request.names.length !== spans.length) {
      return fail('invalidInput', { field: 'names', problem: 'count' });
    }
    // Оценки ещё идут или документ из одних скрытых — отказ до записи (M4, KTD4); выравнивание
    // ещё идёт — тоже (M6, KTD-8): отложенные страницы не держат.
    const refused = blankRefusal(assembly.blank, spans) ?? straightenRefusal(assembly.straighten);
    if (refused !== null) {
      return refused;
    }
    const straight = straightSnapshotOf(order, straightened);

    // Новый пакет забывает прежний незавершённый: повтор относится только к последнему.
    const previous = request.retry ? pendingBatch : null;
    pendingBatch = previous;
    if (
      request.retry &&
      (previous?.sessionId !== session.id ||
        previous.mode !== request.mode ||
        previous.documents !== spans.length)
    ) {
      return conflict('noFailedFiles');
    }
    // Лента или выправленные менялись после первой попытки: записанные файлы собраны со старой,
    // и дописать к ним неудавшиеся по новой — значит молча получить пакет, где страница в двух
    // файлах, ни в одном или другим видом. Пакет пишется заново целиком (R13; AE14).
    if (
      previous !== null &&
      (previous.revision !== store.revision() || previous.digest !== straight.digest)
    ) {
      pendingBatch = null;
      return conflict('batchStale');
    }
    const batch: PendingBatch = previous ?? {
      sessionId: session.id,
      mode: request.mode,
      folder,
      documents: spans.length,
      revision: store.revision(),
      straight: straight.snapshot,
      digest: straight.digest,
      written: [],
      failed: spans.map((_pages, index) => index),
    };

    const outcome = await writeBatch(
      batch.folder,
      batch.failed.map((index) => ({
        index,
        name: request.names[index] ?? '',
        build: () => buildPdf(spans[index] ?? [], batch.straight),
      })),
      deps.io,
    );
    if (!outcome.ok) {
      return outcome;
    }
    const written = [...batch.written, ...outcome.value.written].sort(
      (left, right) => left.index - right.index,
    );
    const { failed } = outcome.value;
    if (written.length > 0) {
      lastBatchFolder = batch.folder;
    }
    if (failed.length === 0) {
      pendingBatch = null;
      // Отметка — на набор первой попытки: правка между попытками её не получит (R13).
      await store.markSaved(batch.revision);
      deps.onSaved();
    } else {
      pendingBatch = { ...batch, written, failed: failed.map((file) => file.index) };
    }
    return ok({ folder: batch.folder, written, failed });
  }

  return {
    write,
    forget() {
      pendingBatch = null;
    },
    lastFolder: () => lastBatchFolder,
  };
}
