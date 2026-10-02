import { SaxesParser } from 'saxes';
import { fail, ok, type Result } from '@shared';

// Разбор XML устройства (ADR 0006; план M1, KTD-32). Сканер — единственный недоверенный удалённый
// вход приложения, и разбирается он в main-процессе. Здесь живут все правила недоверенного входа;
// остальной клиент получает дерево и XML не видит.
//
// - элементы сопоставляются по URI пространства имён, а не по префиксу: чужая прошивка может
//   назвать `scan:` и `pwg:` иначе;
// - `<!DOCTYPE` и `<!ENTITY` — отказ: до разбора по тексту и на событии разборщика;
// - текст — строгий UTF-8; размер, глубина и число узлов ограничены, превышение — отказ, а не
//   усечение;
// - имена элементов — значения полей, а не ключи объектов: `<__proto__>` ничего не подменяет.

export const NS_SCAN = 'http://schemas.hp.com/imaging/escl/2011/05/03';
export const NS_PWG = 'http://www.pwg.org/schemas/2010/12/sm';

export interface XmlElement {
  /** URI пространства имён; пустая строка — без пространства. */
  readonly ns: string;
  /** Имя без префикса. */
  readonly name: string;
  /** Собственный текст элемента без текста потомков, с обрезанными краями. */
  readonly text: string;
  readonly children: readonly XmlElement[];
}

export interface XmlLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

// Capabilities ET-3850 — 7 КБ, глубина 9, около 250 элементов; статус — до 0,9 КБ.
export const XML_LIMITS: XmlLimits = {
  maxBytes: 1024 * 1024,
  maxDepth: 32,
  maxNodes: 20_000,
};

export type XmlFailure =
  'tooLarge' | 'notUtf8' | 'doctype' | 'malformed' | 'tooDeep' | 'tooManyNodes';

/** Все причины отказа `scannerBadResponse` — одним списком: опечатка в причине не компилируется. */
export type BadResponseReason =
  | XmlFailure
  | 'adfRegion'
  | 'adfProfile'
  | 'http'
  | 'foreignPath'
  // Задание (./scan-job.ts): неожиданный статус, негодный `Location`, страница не JPEG или
  // пустая, страниц больше потолка.
  | 'status'
  | 'location'
  | 'notJpeg'
  | 'emptyPage'
  | 'tooManyPages';

export const badResponse = (reason: BadResponseReason): Result<never> =>
  fail('scannerBadResponse', { reason });

class Rejected extends Error {
  constructor(readonly reason: XmlFailure) {
    super(reason);
  }
}

interface Building {
  readonly ns: string;
  readonly name: string;
  text: string;
  readonly children: XmlElement[];
}

const DTD = /<!(DOCTYPE|ENTITY)/i;

export function parseXml(bytes: Uint8Array, limits: XmlLimits = XML_LIMITS): Result<XmlElement> {
  if (bytes.byteLength > limits.maxBytes) {
    return badResponse('tooLarge');
  }

  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return badResponse('notUtf8');
  }
  if (DTD.test(source)) {
    return badResponse('doctype');
  }

  const parser = new SaxesParser({ xmlns: true });
  const stack: Building[] = [];
  // Поле объекта, а не переменная: присваивание идёт из обработчика, и сужение типа по потоку
  // управления иначе считает значение неизменным.
  const built: { root: XmlElement | null } = { root: null };
  let nodes = 0;

  parser.on('doctype', () => {
    throw new Rejected('doctype');
  });
  parser.on('opentag', (tag) => {
    nodes += 1;
    if (nodes > limits.maxNodes) {
      throw new Rejected('tooManyNodes');
    }
    if (stack.length >= limits.maxDepth) {
      throw new Rejected('tooDeep');
    }
    stack.push({ ns: tag.uri, name: tag.local, text: '', children: [] });
  });
  const appendText = (text: string): void => {
    const current = stack.at(-1);
    if (current !== undefined) {
      current.text += text;
    }
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.on('closetag', () => {
    const closed = stack.pop();
    if (closed === undefined) {
      return;
    }
    const element: XmlElement = { ...closed, text: closed.text.trim() };
    const parent = stack.at(-1);
    if (parent === undefined) {
      built.root = element;
    } else {
      parent.children.push(element);
    }
  });

  // Обработчика ошибок нет намеренно: без него `saxes` бросает исключение на первой же ошибке
  // разметки, и разбор останавливается, а не продолжается по испорченному документу.
  try {
    parser.write(source).close();
  } catch (error) {
    return badResponse(error instanceof Rejected ? error.reason : 'malformed');
  }

  return built.root === null ? badResponse('malformed') : ok(built.root);
}

// ---------------------------------------------------------------------------------------------
// Обход дерева. Сравнение — по паре «пространство имён, имя».
// ---------------------------------------------------------------------------------------------

export function isElement(element: XmlElement, ns: string, name: string): boolean {
  return element.ns === ns && element.name === name;
}

export function childrenOf(element: XmlElement, ns: string, name: string): XmlElement[] {
  return element.children.filter((it) => isElement(it, ns, name));
}

export function childOf(element: XmlElement, ns: string, name: string): XmlElement | null {
  return element.children.find((it) => isElement(it, ns, name)) ?? null;
}

/** Потомок по цепочке имён в одном пространстве; `null`, если звена нет. */
export function descendantOf(
  element: XmlElement,
  ns: string,
  ...path: string[]
): XmlElement | null {
  let current: XmlElement | null = element;
  for (const name of path) {
    current = current === null ? null : childOf(current, ns, name);
  }
  return current;
}

export function textOf(element: XmlElement, ns: string, name: string): string | null {
  return childOf(element, ns, name)?.text ?? null;
}

const UINT = /^\d{1,9}$/;

/** Неотрицательное целое из текста элемента; всё остальное — `null`, без приведения. */
export function uintOf(element: XmlElement, ns: string, name: string): number | null {
  const text = textOf(element, ns, name);
  return text !== null && UINT.test(text) ? Number(text) : null;
}

// Строка устройства для показа: без управляющих символов (C0, DEL, C1) и не длиннее потолка.
export const DISPLAY_TEXT_MAX_LENGTH = 128;

const isControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f);

export function displayText(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const clean = Array.from(value, (char) => (isControl(char.charCodeAt(0)) ? ' ' : char))
    .join('')
    .trim()
    .slice(0, DISPLAY_TEXT_MAX_LENGTH);
  return clean === '' ? null : clean;
}
