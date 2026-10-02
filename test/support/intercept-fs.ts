// Перехват вызовов файловой системы для тестов хранилища: журнал вызовов и ввод сбоя на любом
// шаге. Помощник обобщённый и не знает типов приложения — оборачивает любой объект с
// асинхронными методами, у которых первый аргумент — путь.

export interface FsCall {
  /** Имя метода; у открытого файла — `write`, `sync`, `close`. */
  readonly op: string;
  readonly path: string;
  /** Второй путь у переименования. */
  readonly to?: string;
}

export const fsError = (code: string): Error => Object.assign(new Error(code), { code });

type AnyMethod = (...args: unknown[]) => unknown;

const isHandle = (value: unknown): value is Record<'write' | 'sync' | 'close', AnyMethod> =>
  typeof value === 'object' && value !== null && 'sync' in value && 'close' in value;

/**
 * Оборачивает файловую систему: `before` вызывается перед каждой операцией и может бросить
 * исключение — операция тогда не выполняется. Чтение каталога и файла тоже проходит через него.
 */
export function interceptFs<T extends object>(
  real: T,
  before: (call: FsCall) => void = () => undefined,
): { readonly fs: T; readonly calls: FsCall[] } {
  const calls: FsCall[] = [];
  const step = (call: FsCall): void => {
    calls.push(call);
    before(call);
  };

  const fs = new Proxy(real, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function' || typeof property !== 'string') {
        return member;
      }
      return async (...args: unknown[]) => {
        const [path, to] = args as [string, unknown];
        step(
          typeof to === 'string' && property === 'rename'
            ? { op: property, path, to }
            : { op: property, path },
        );
        const result: unknown = await (member as AnyMethod).apply(target, args);
        if (!isHandle(result)) {
          return result;
        }
        const wrap =
          (op: 'write' | 'sync' | 'close') =>
          async (...handleArgs: unknown[]) => {
            try {
              step({ op, path });
            } catch (error) {
              // Дескриптор закрывается и при «сбое»: иначе открытый файл держал бы каталог теста.
              if (op === 'close') {
                await (result.close() as Promise<unknown>);
              }
              throw error;
            }
            return await (result[op](...handleArgs) as Promise<unknown>);
          };
        return { write: wrap('write'), sync: wrap('sync'), close: wrap('close') };
      };
    },
  });
  return { fs, calls };
}
