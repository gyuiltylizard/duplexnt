import { describe, expect, it } from 'vitest';
import {
  DEVICE_PATH_MAX_LENGTH,
  isUnderBase,
  jobPathFromLocation,
  normalizeBasePath,
} from './device-path';

const BASE = '/eSCL';
const JOB = '/eSCL/ScanJobs/00000000-0000-4000-8000-000000000000';

describe('normalizeBasePath', () => {
  it.each([
    ['/eSCL', '/eSCL'],
    ['eSCL', '/eSCL'],
    ['/eSCL/', '/eSCL'],
    [' /eSCL// ', '/eSCL'],
    ['/printer/eSCL', '/printer/eSCL'],
    ['', ''],
    ['/', ''],
  ])('%j → %j', (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });

  it.each([
    '/eSCL?x=1',
    '/eSCL#top',
    '/eSCL/../admin',
    '/./eSCL',
    '/eSCL%2f..',
    '/e SCL',
    '\\eSCL',
    '/eSCL\\x',
    '//evil.example/eSCL',
    'http://evil.example/eSCL',
    '/eSCL\r\nHost: evil',
    '/eSCL\u0000',
    `/${'a'.repeat(DEVICE_PATH_MAX_LENGTH)}`,
  ])('отклоняет %j', (input) => {
    expect(normalizeBasePath(input)).toBeNull();
  });
});

describe('isUnderBase', () => {
  it('путь под базой — по границе сегмента', () => {
    expect(isUnderBase('/eSCL/ScannerStatus', BASE)).toBe(true);
    expect(isUnderBase(JOB, BASE)).toBe(true);
    expect(isUnderBase('/eSCLx/ScannerStatus', BASE)).toBe(false);
    expect(isUnderBase('/eSCL', BASE)).toBe(false);
    expect(isUnderBase('/eSCL/', BASE)).toBe(false);
    expect(isUnderBase('/other', BASE)).toBe(false);
  });

  it('база в корне: любой простой путь под ней', () => {
    expect(isUnderBase('/ScannerStatus', '')).toBe(true);
    expect(isUnderBase('/', '')).toBe(false);
  });

  it.each([
    'https://evil.example/eSCL/ScannerStatus',
    '//evil.example/eSCL/ScannerStatus',
    '/eSCL/../admin',
    '/eSCL/ScannerStatus?x=1',
    '/eSCL/%2e%2e/admin',
    '/eSCL//ScannerStatus',
    'eSCL/ScannerStatus',
    '/eSCL/Scanner Status',
  ])('не путь под базой: %j', (path) => {
    expect(isUnderBase(path, BASE)).toBe(false);
  });
});

describe('jobPathFromLocation', () => {
  it('Location устройства: абсолютный, с портом — берётся только путь', () => {
    expect(jobPathFromLocation(`https://192.0.2.10:443${JOB}`, BASE)).toBe(JOB);
  });

  it('чужой хост, http:// и путь без хоста приводятся к пути под базой', () => {
    expect(jobPathFromLocation(`https://evil.example${JOB}`, BASE)).toBe(JOB);
    expect(jobPathFromLocation(`http://192.0.2.10:8080${JOB}`, BASE)).toBe(JOB);
    expect(jobPathFromLocation(JOB, BASE)).toBe(JOB);
    expect(jobPathFromLocation(`//evil.example${JOB}`, BASE)).toBe(JOB);
    expect(jobPathFromLocation(`https://user:pass@evil.example${JOB}`, BASE)).toBe(JOB);
  });

  it('схема значения не важна: берётся только путь', () => {
    for (const scheme of ['javascript:', 'file://', 'data:', 'ftp://host']) {
      expect(jobPathFromLocation(`${scheme}${JOB}`, BASE), scheme).toBe(JOB);
    }
  });

  it('относительное значение разрешается от коллекции заданий', () => {
    expect(jobPathFromLocation('ScanJobs/abc', BASE)).toBe('/eSCL/ScanJobs/abc');
    // По правилам URL «abc» от «/eSCL/ScanJobs» — это «/eSCL/abc»: не под коллекцией.
    expect(jobPathFromLocation('abc', BASE)).toBeNull();
  });

  it('база в корне и вложенная база', () => {
    expect(jobPathFromLocation('/ScanJobs/7', '')).toBe('/ScanJobs/7');
    expect(jobPathFromLocation('/printer/eSCL/ScanJobs/7', '/printer/eSCL')).toBe(
      '/printer/eSCL/ScanJobs/7',
    );
  });

  it.each([
    ['точечные сегменты', '/eSCL/ScanJobs/../../admin'],
    ['точечный сегмент внутри', '/eSCL/ScanJobs/x/../y'],
    ['точечный сегмент до базы', '/x/../eSCL/ScanJobs/y'],
    ['кодированные точки', '/eSCL/ScanJobs/%2e%2e/admin'],
    ['кодированные точки, путь остаётся под коллекцией', '/eSCL/ScanJobs/x/%2e%2e/y'],
    ['кодированная точка', '/eSCL/ScanJobs/%2e/y'],
    ['кодированные точки с возвратом в коллекцию', '/eSCL/ScanJobs/%2e%2e/ScanJobs/abc'],
    ['кодированный пробел', '/eSCL/ScanJobs/a%20b'],
    ['кодированный слэш', '/eSCL/ScanJobs/a%2fb'],
    ['кодированный слэш заглавными', '/eSCL/ScanJobs/a%2Fb'],
    ['обратный слэш', '/eSCL/ScanJobs\\..\\admin'],
    ['обратный слэш в конце', '/eSCL/ScanJobs/a\\b'],
    ['запрос', `${JOB}?next=1`],
    ['пустой запрос', `${JOB}?`],
    ['фрагмент', `${JOB}#x`],
    ['соседний префикс', '/eSCLx/ScanJobs/abc'],
    ['соседняя коллекция', '/eSCL/ScanJobsX/abc'],
    ['сама коллекция', '/eSCL/ScanJobs'],
    ['коллекция со слэшем', '/eSCL/ScanJobs/'],
    ['другой ресурс под базой', '/eSCL/ScannerStatus'],
    ['пустой сегмент', '/eSCL/ScanJobs//abc'],
    ['пробел', '/eSCL/ScanJobs/a b'],
    ['перевод строки', `${JOB}\r\nX-Injected: 1`],
    ['не URL', 'http://[::1'],
    ['сверхдлинный', `/eSCL/ScanJobs/${'a'.repeat(DEVICE_PATH_MAX_LENGTH)}`],
  ])('отклоняет: %s', (_name, location) => {
    expect(jobPathFromLocation(location, BASE)).toBeNull();
  });

  it('отсутствующий и пустой Location — отказ', () => {
    expect(jobPathFromLocation(undefined, BASE)).toBeNull();
    expect(jobPathFromLocation(null, BASE)).toBeNull();
    expect(jobPathFromLocation('', BASE)).toBeNull();
  });
});
