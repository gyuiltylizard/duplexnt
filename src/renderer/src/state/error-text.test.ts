import { describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import { errorText, errorTextInline } from './error-text';

const t = i18n.t.bind(i18n);

describe('errorText', () => {
  it('код без причины — базовый текст', () => {
    expect(errorText(t, { code: 'scanNoPaper' })).toBe(
      'В лотке нет бумаги. Положите листы в автоподатчик и запустите ещё раз.',
    );
  });

  it('причина недоступности сканера выбирает свой вариант', () => {
    expect(errorText(t, { code: 'scannerUnreachable', details: { reason: 'dns' } })).toBe(
      'Такое имя не найдено в сети. Проверьте адрес.',
    );
  });

  it('параметр, которого нет у устройства, называется по полю', () => {
    expect(errorText(t, { code: 'scanParamsUnsupported', details: { field: 'resolution' } })).toBe(
      'Сканер не поддерживает выбранное разрешение.',
    );
  });

  it('причина конфликта сессии выбирает свой вариант', () => {
    expect(errorText(t, { code: 'sessionConflict', details: { reason: 'passRunning' } })).toBe(
      'Сейчас идёт проход — дождитесь его конца или остановите.',
    );
  });

  it('потерянная страница — свой вариант', () => {
    expect(errorText(t, { code: 'pageUnavailable', details: { reason: 'lost' } })).toBe(
      'Файл этой страницы потерян.',
    );
  });

  it('причина без строки в локали получает базовый текст кода', () => {
    expect(errorText(t, { code: 'sessionConflict', details: { reason: 'stopping' } })).toBe(
      'Сейчас это действие недоступно.',
    );
    expect(errorText(t, { code: 'storageFailed', details: { reason: 'EBUSY' } })).toBe(
      'Не удалось записать данные на диск. Проверьте, не блокирует ли папку приложения антивирус или другая программа.',
    );
  });

  it('для подстановки в составное сообщение первая буква понижается', () => {
    expect(errorTextInline(t, { code: 'scanNoPaper' })).toBe(
      'в лотке нет бумаги. Положите листы в автоподатчик и запустите ещё раз.',
    );
  });
});
