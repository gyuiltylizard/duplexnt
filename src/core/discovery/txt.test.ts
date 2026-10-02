import { describe, expect, it } from 'vitest';
import {
  mergeRecord,
  parseTxt,
  recordOf,
  sameScanner,
  type Announcement,
  type ScannerRecord,
} from './txt';

const UUID = '00000000-0000-4000-8000-000000000000';

const txt = (...entries: string[]): Uint8Array[] =>
  entries.map((entry) => new TextEncoder().encode(entry));

// Объявление в том виде, в каком его шлёт ET-3850: `UUID` прописными, запись `note=` пустая.
const announcement = (overrides: Partial<Announcement> = {}): Announcement => ({
  name: 'EPSON ET-3850 Series',
  port: 443,
  addresses: ['192.0.2.10', '2001:db8::10'],
  txt: txt(
    'txtvers=1',
    'vers=2.9',
    'rs=eSCL',
    'is=platen,adf',
    'ty=EPSON ET-3850 Series',
    `UUID=${UUID}`,
    'note=',
    'duplex=F',
  ),
  ...overrides,
});

const record = (overrides: Partial<ScannerRecord> = {}): ScannerRecord => ({
  uuid: UUID,
  name: 'EPSON ET-3850 Series',
  address: '192.0.2.10',
  port: 443,
  basePath: '/eSCL',
  hasAdf: true,
  ...overrides,
});

describe('разбор TXT', () => {
  it('ключ UUID в верхнем регистре и запись note= с пустым значением разбираются', () => {
    const table = parseTxt(txt(`UUID=${UUID}`, 'note=', 'usb_MFG=EPSON'));

    expect(table.get('uuid')).toBe(UUID);
    expect(table.get('note')).toBe('');
    expect(table.get('usb_mfg')).toBe('EPSON');
  });

  it('значение может содержать знак равенства; запись-флаг без него даёт пустую строку', () => {
    const table = parseTxt(txt('adminurl=http://192.0.2.10/?a=b', 'flag'));

    expect(table.get('adminurl')).toBe('http://192.0.2.10/?a=b');
    expect(table.get('flag')).toBe('');
  });

  it('повтор ключа первое значение не перезаписывает — в том числе в другом регистре', () => {
    const table = parseTxt(txt('rs=eSCL', 'RS=evil', 'rs=other'));

    expect(table.get('rs')).toBe('eSCL');
  });

  it('пустой ключ, ключ с пробелом и сверхдлинный ключ пропускаются; записей не больше потолка', () => {
    const table = parseTxt(txt('=value', 'bad key=1', `${'k'.repeat(65)}=1`, 'ok=1'));
    const many = parseTxt(txt(...Array.from({ length: 200 }, (_, index) => `k${index}=v`)));

    expect([...table.keys()]).toEqual(['ok']);
    expect(many.size).toBe(64);
  });

  it('ключ __proto__ остаётся обычным ключом таблицы', () => {
    const table = parseTxt(txt('__proto__=x', 'constructor=y'));

    expect(table.get('__proto__')).toBe('x');
    expect(Object.getPrototypeOf(table)).toBe(Map.prototype);
  });
});

describe('запись о сканере из объявления', () => {
  it('объявление ET-3850 даёт запись с автоподачей, IPv4-адресом и базовым путём', () => {
    expect(recordOf(announcement())).toEqual(record());
  });

  it('устройство без adf в TXT помечено как без автоподачи', () => {
    expect(recordOf(announcement({ txt: txt('rs=eSCL', 'is=platen') }))?.hasAdf).toBe(false);
    expect(recordOf(announcement({ txt: txt('rs=eSCL') }))?.hasAdf).toBe(false);
    expect(recordOf(announcement({ txt: txt('is=Platen, ADF') }))?.hasAdf).toBe(true);
    // `adf` — отдельное слово списка, а не подстрока.
    expect(recordOf(announcement({ txt: txt('is=adfx') }))?.hasAdf).toBe(false);
  });

  it('rs без ведущего слэша, со слэшем и отсутствующий дают базовый путь', () => {
    expect(recordOf(announcement({ txt: txt('rs=eSCL') }))?.basePath).toBe('/eSCL');
    expect(recordOf(announcement({ txt: txt('rs=/scan/eSCL/') }))?.basePath).toBe('/scan/eSCL');
    expect(recordOf(announcement({ txt: txt('is=adf') }))?.basePath).toBe('/eSCL');
    expect(recordOf(announcement({ txt: txt('rs=') }))?.basePath).toBe('/eSCL');
  });

  it.each(['rs=eSCL?x=1', 'rs=../admin', 'rs=eSCL/../..', 'rs=%2e%2e', 'rs=a b', 'rs=eSCL#x'])(
    '«%s» базовым путём не становится',
    (entry) => {
      expect(recordOf(announcement({ txt: txt(entry) }))?.basePath).toBe('/eSCL');
    },
  );

  it('имя с управляющими символами и сверхдлинное имя очищаются и обрезаются', () => {
    const dirty = recordOf(announcement({ txt: txt('ty=Scan\u0000ner\u001b[31m\r\nX') }));
    const long = recordOf(announcement({ txt: txt(`ty=${'N'.repeat(1000)}`) }));

    expect(dirty?.name).toBe('Scan ner [31m  X');
    expect(long?.name).toHaveLength(128);
  });

  it('без ty берётся имя экземпляра сервиса; без обоих — имени нет', () => {
    expect(recordOf(announcement({ txt: [] }))?.name).toBe('EPSON ET-3850 Series');
    expect(recordOf(announcement({ name: ' \u0007 ', txt: [] }))?.name).toBeNull();
  });

  it('UUID приводится к нижнему регистру; не-UUID не становится идентичностью', () => {
    const upper = recordOf(announcement({ txt: txt(`UUID=${UUID.toUpperCase()}`) }));
    const garbage = recordOf(announcement({ txt: txt('UUID=<script>') }));

    expect(upper?.uuid).toBe(UUID);
    expect(garbage?.uuid).toBeNull();
  });

  it('берётся первый годный IPv4; объявление без него записью не становится', () => {
    const second = recordOf(announcement({ addresses: ['2001:db8::10', '0.0.0.0', '192.0.2.77'] }));

    expect(second?.address).toBe('192.0.2.77');
    expect(recordOf(announcement({ addresses: ['2001:db8::10'] }))).toBeNull();
    expect(recordOf(announcement({ addresses: ['224.0.0.251'] }))).toBeNull();
    expect(recordOf(announcement({ addresses: ['999.1.1.1', 'example.com'] }))).toBeNull();
    expect(recordOf(announcement({ addresses: [] }))).toBeNull();
  });

  it.each([0, -1, 65536, 1.5, Number.NaN])('порт %s — не запись', (port) => {
    expect(recordOf(announcement({ port }))).toBeNull();
  });
});

describe('слияние записей (KTD-12)', () => {
  const MAX = 64;

  it('два объявления одного устройства от двух сервисов дают одну запись', () => {
    const first = mergeRecord([], record(), MAX);
    const second = mergeRecord(first, record(), MAX);

    expect(second).toHaveLength(1);
    // Ничего не изменилось — тот же массив: подписчиков будить незачем.
    expect(second).toBe(first);
  });

  it('объявление без UUID схлопывается по адресу и порту и получает UUID от второго', () => {
    const anonymous = record({ uuid: null, name: null, hasAdf: false });

    const merged = mergeRecord(mergeRecord([], anonymous, MAX), record(), MAX);

    expect(merged).toEqual([record()]);
  });

  it('один UUID с двух разных адресов даёт две записи с видимым адресом', () => {
    const merged = mergeRecord([record()], record({ address: '192.0.2.11' }), MAX);

    expect(merged.map((it) => it.address)).toEqual(['192.0.2.10', '192.0.2.11']);
  });

  it('тот же адрес с другим портом и тот же адрес с другим UUID — разные записи', () => {
    const otherUuid = '11111111-1111-4111-8111-111111111111';

    expect(sameScanner(record(), record({ port: 8443 }))).toBe(false);
    expect(sameScanner(record(), record({ uuid: otherUuid }))).toBe(false);
    expect(sameScanner(record(), record({ uuid: null }))).toBe(true);
  });

  it('слияние не меняет место записи в списке', () => {
    const list = [record({ address: '192.0.2.1' }), record({ uuid: null, hasAdf: false })];

    const merged = mergeRecord(list, record(), MAX);

    expect(merged.map((it) => it.address)).toEqual(['192.0.2.1', '192.0.2.10']);
    expect(merged[1]?.hasAdf).toBe(true);
  });

  it('поток объявлений упирается в потолок числа записей', () => {
    let list: readonly ScannerRecord[] = [];
    for (let index = 1; index <= 200; index += 1) {
      list = mergeRecord(list, record({ address: `192.0.2.${index}` }), 5);
    }

    expect(list).toHaveLength(5);
    expect(list.at(-1)?.address).toBe('192.0.2.5');
  });
});
