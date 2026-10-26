import { z } from 'zod';
import { fail, ok, type Result } from '@shared';
import { layoutOf } from './layout';
import { ioOf, serialQueue, storageFailure, type StorageOptions } from './storage-fs';
import { fitsSchema, readVersioned, setAside, writeVersioned } from './versioned-file';

// Размер и положение окна между запусками (B-3, KTD-1). Отдельный файл, а не поле настроек: новая
// версия схемы настроек ради окна заморозила бы их при откате приложения на прежнюю версию. Файл
// — удобство, не данные пользователя: без него окно откроется размером по умолчанию.

export const WINDOW_STATE_VERSION = 1;

/** Предел координат и размеров: больше не бывает ни у одного набора мониторов. */
const MAX_PX = 100_000;

const coordinate = z.number().int().min(-MAX_PX).max(MAX_PX);
const size = z.number().int().min(1).max(MAX_PX);

const boundsSchema = z.strictObject({ x: coordinate, y: coordinate, width: size, height: size });

const windowStateSchema = z.strictObject({
  version: z.literal(WINDOW_STATE_VERSION),
  /** Границы обычного (не развёрнутого) окна: к ним возвращает «Восстановить». */
  bounds: boundsSchema,
  maximized: z.boolean(),
});

export type WindowBounds = z.infer<typeof boundsSchema>;

export interface WindowState {
  readonly bounds: WindowBounds;
  readonly maximized: boolean;
}

export interface WindowStateStore {
  /** Состояние с прошлого запуска; `null` — файла нет, он нечитаем или более новой версии. */
  get(): WindowState | null;
  save(state: WindowState): Promise<Result<void>>;
}

export async function openWindowStateStore(
  dataRoot: string,
  options: StorageOptions = {},
): Promise<WindowStateStore> {
  const { root, windowFile } = layoutOf(dataRoot);
  const io = ioOf(options);
  const { fs } = io;

  let state: WindowState | null = null;
  // Файл более новой версии или не прочитанный вовсе не переписывается до конца работы.
  let frozen = false;
  try {
    const read = await readVersioned(fs, windowFile, windowStateSchema, WINDOW_STATE_VERSION);
    if (read.kind === 'ok') {
      state = { bounds: read.value.bounds, maximized: read.value.maximized };
    } else if (read.kind === 'incompatible') {
      frozen = true;
    } else if (read.kind === 'unreadable') {
      await setAside(windowFile, io);
    }
  } catch (error) {
    // Файл не открылся или не отодвинулся: что в нём, неизвестно — запись его затёрла бы. Окно
    // откроется размером по умолчанию.
    console.error('[window-state] файл состояния окна не прочитан', error);
    frozen = true;
  }

  const enqueue = serialQueue();
  return {
    get: () => state,
    save: ({ bounds, maximized }) =>
      enqueue(async (): Promise<Result<void>> => {
        const document = { version: WINDOW_STATE_VERSION, bounds, maximized };
        if (!fitsSchema(windowStateSchema, document)) {
          return fail('storageFailed', { reason: 'schema' });
        }
        state = { bounds, maximized };
        if (frozen) {
          return ok(undefined);
        }
        try {
          await fs.mkdir(root);
          await writeVersioned(windowFile, windowStateSchema, WINDOW_STATE_VERSION, document, io);
          return ok(undefined);
        } catch (error) {
          return { ok: false, error: storageFailure(error) };
        }
      }),
  };
}
