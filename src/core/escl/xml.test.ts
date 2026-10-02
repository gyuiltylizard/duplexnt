import { describe, expect, it } from 'vitest';
import { ET_3850, readFixture } from '../../../test/support/fixtures';
import {
  childOf,
  childrenOf,
  descendantOf,
  displayText,
  NS_PWG,
  NS_SCAN,
  parseXml,
  textOf,
  uintOf,
  XML_LIMITS,
  type XmlElement,
} from './xml';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function rootOf(text: string): XmlElement {
  const result = parseXml(encode(text));
  if (!result.ok) {
    throw new Error(`не разобрано: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

const reasonOf = (bytes: Uint8Array, limits = XML_LIMITS): unknown => {
  const result = parseXml(bytes, limits);
  return result.ok ? 'ok' : { code: result.error.code, ...result.error.details };
};

const rejected = (reason: string) => ({ code: 'scannerBadResponse', reason });

function utf16le(text: string, bom: boolean): Uint8Array {
  const bytes = new Uint8Array(text.length * 2 + (bom ? 2 : 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  if (bom) {
    view.setUint16(0, 0xfeff, true);
    offset = 2;
  }
  for (let index = 0; index < text.length; index += 1) {
    view.setUint16(offset + index * 2, text.charCodeAt(index), true);
  }
  return bytes;
}

describe('parseXml: дерево', () => {
  it('элементы несут URI пространства имён и имя без префикса', () => {
    const root = rootOf(
      `<s:Status xmlns:s="${NS_SCAN}" xmlns:p="${NS_PWG}"><p:State> Idle </p:State><s:Jobs/></s:Status>`,
    );

    expect(root).toMatchObject({ ns: NS_SCAN, name: 'Status', text: '' });
    expect(root.children.map((it) => [it.ns, it.name, it.text])).toEqual([
      [NS_PWG, 'State', 'Idle'],
      [NS_SCAN, 'Jobs', ''],
    ]);
  });

  it('пространство по умолчанию и префикс дают одно и то же дерево', () => {
    const prefixed = rootOf(`<a:R xmlns:a="${NS_SCAN}"><a:V>1</a:V></a:R>`);
    const defaulted = rootOf(`<R xmlns="${NS_SCAN}"><V>1</V></R>`);

    expect(defaulted).toEqual(prefixed);
  });

  it('одинаковое имя в другом пространстве — другой элемент', () => {
    const root = rootOf(
      `<R xmlns="${NS_SCAN}" xmlns:p="${NS_PWG}" xmlns:x="urn:x"><x:State>чужой</x:State><p:State>Idle</p:State></R>`,
    );

    expect(textOf(root, NS_PWG, 'State')).toBe('Idle');
    expect(childrenOf(root, NS_PWG, 'State')).toHaveLength(1);
    expect(childOf(root, NS_SCAN, 'State')).toBeNull();
  });

  it('текст собирается из кусков и CDATA; предопределённые сущности раскрываются', () => {
    const root = rootOf('<r><a>EPSON &amp; <![CDATA[<ET>]]> 3850</a></r>');

    expect(textOf(root, '', 'a')).toBe('EPSON & <ET> 3850');
  });

  it('помощники обхода: цепочка потомков и целые без приведения', () => {
    const root = rootOf(
      `<R xmlns="${NS_SCAN}"><Adf><Caps><Max>2550</Max><Neg>-1</Neg><Hex>0x10</Hex><Dot>1.5</Dot><Empty/></Caps></Adf></R>`,
    );
    const caps = descendantOf(root, NS_SCAN, 'Adf', 'Caps');

    expect(caps).not.toBeNull();
    expect(descendantOf(root, NS_SCAN, 'Adf', 'Нет', 'Caps')).toBeNull();
    if (caps === null) {
      return;
    }
    expect(uintOf(caps, NS_SCAN, 'Max')).toBe(2550);
    for (const name of ['Neg', 'Hex', 'Dot', 'Empty', 'Missing']) {
      expect(uintOf(caps, NS_SCAN, name), name).toBeNull();
    }
  });

  it('фикстура ET-3850 разбирается: корень, идентичность, оба источника', () => {
    const result = parseXml(readFixture(...ET_3850, 'ScannerCapabilities.xml'));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toMatchObject({ ns: NS_SCAN, name: 'ScannerCapabilities' });
    expect(textOf(result.value, NS_PWG, 'MakeAndModel')).toBe('EPSON ET-3850 Series');
    expect(descendantOf(result.value, NS_SCAN, 'Adf', 'AdfSimplexInputCaps')).not.toBeNull();
    expect(descendantOf(result.value, NS_SCAN, 'Platen', 'PlatenInputCaps')).not.toBeNull();
  });
});

describe('parseXml: правила недоверенного входа', () => {
  it('ответ с DOCTYPE отклоняется до разбора', () => {
    const doc = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "y">]><r>&x;</r>';

    expect(reasonOf(encode(doc))).toEqual(rejected('doctype'));
    expect(reasonOf(encode('<!doctype r><r/>'))).toEqual(rejected('doctype'));
    expect(reasonOf(encode('<r><!ENTITY x "y"></r>'))).toEqual(rejected('doctype'));
  });

  it('тот же документ в UTF-16 отклоняется — с BOM и без', () => {
    const doc = '<?xml version="1.0" encoding="UTF-16"?><r><a>1</a></r>';

    expect(reasonOf(encode(doc.replace('UTF-16', 'UTF-8')))).toBe('ok');
    expect(reasonOf(utf16le(doc, true))).toEqual(rejected('notUtf8'));
    expect(reasonOf(utf16le(doc, false))).toEqual(rejected('malformed'));
  });

  it('битый UTF-8 отклоняется, а не заменяется знаком подстановки', () => {
    const bytes = encode('<r>текст</r>');
    bytes[4] = 0xff;

    expect(reasonOf(bytes)).toEqual(rejected('notUtf8'));
  });

  it('ответ больше потолка размера отклоняется; ровно на потолке — разбирается', () => {
    const limits = { ...XML_LIMITS, maxBytes: 64 };
    const exact = `<r>${'x'.repeat(64 - 7)}</r>`;

    expect(encode(exact).byteLength).toBe(64);
    expect(reasonOf(encode(exact), limits)).toBe('ok');
    expect(reasonOf(encode(`${exact} `), limits)).toEqual(rejected('tooLarge'));
    expect(reasonOf(new Uint8Array(XML_LIMITS.maxBytes + 1))).toEqual(rejected('tooLarge'));
  });

  it('глубоко вложенный документ упирается в потолок глубины, а не в переполнение стека', () => {
    const deep = (levels: number): Uint8Array =>
      encode(`${'<a>'.repeat(levels)}${'</a>'.repeat(levels)}`);

    expect(reasonOf(deep(XML_LIMITS.maxDepth))).toBe('ok');
    expect(reasonOf(deep(XML_LIMITS.maxDepth + 1))).toEqual(rejected('tooDeep'));
    expect(reasonOf(deep(100_000))).toEqual(rejected('tooDeep'));
  });

  it('число узлов ограничено', () => {
    const wide = (count: number): Uint8Array => encode(`<r>${'<a/>'.repeat(count)}</r>`);

    expect(reasonOf(wide(XML_LIMITS.maxNodes - 1))).toBe('ok');
    expect(reasonOf(wide(XML_LIMITS.maxNodes))).toEqual(rejected('tooManyNodes'));
  });

  it('элемент с именем __proto__ не меняет прототип результата', () => {
    const root = rootOf(
      '<r><__proto__><polluted>да</polluted></__proto__><constructor>x</constructor></r>',
    );

    expect(Object.getPrototypeOf(root)).toBe(Object.prototype);
    expect(root.children.map((it) => it.name)).toEqual(['__proto__', 'constructor']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(childOf(root, '', '__proto__')?.children[0]?.text).toBe('да');
  });

  it.each([
    ['пустой ответ', ''],
    ['не XML', 'HTTP/1.1 404 Not Found'],
    ['HTML вместо XML', '<html><body><p>Router login<br></body></html>'],
    ['незакрытый корень', '<r><a>1</a>'],
    ['два корня', '<r/><r/>'],
    ['неизвестная сущность', '<r>&nbsp;</r>'],
    ['необъявленный префикс', '<scan:r/>'],
    ['JSON', '{"state":"Idle"}'],
  ])('испорченная разметка — отказ, а не исключение: %s', (_name, text) => {
    expect(reasonOf(encode(text))).toEqual(rejected('malformed'));
  });
});

describe('displayText', () => {
  it('убирает управляющие символы и обрезает длину', () => {
    expect(displayText('EPSON\u0000 ET\u001b[31m-3850\r\n')).toBe('EPSON  ET [31m-3850');
    expect(displayText('x'.repeat(500))?.length).toBe(128);
  });

  it('пустое и отсутствующее значение — null', () => {
    expect(displayText(null)).toBeNull();
    expect(displayText(' \t\n ')).toBeNull();
  });
});
