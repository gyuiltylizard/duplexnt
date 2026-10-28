import { describe, expect, it } from 'vitest';
import { BLANK_THRESHOLD, blankRatio, isBlank } from '../../src/core/detect/blank';
import { pageFixture, scanFixture, scanFixtureNames } from '../support/fixtures';

// Калибровка детектора пустых страниц на настоящих сканах ET-3850 (план M4, U2, R5; спека →
// «Тестирование»: детектор срабатывает где надо и молчит на бледном тексте). Таблица — класс по
// имени скана; тест печатает доли, проверяет класс каждого скана и запас между классами.
// Фикстуры — `test/fixtures/escl/et-3850/scans/`, их заводит автор (U1).

/** Предел пикселей ET-3850 при 600 dpi на A4 с запасом — как в журнале прохода. */
const PIXEL_LIMIT = 5100 * 8400;

/** Класс по началу имени скана. */
// Чистый лист с дырками дырокола — тоже пустой: такой оборот пользователь хочет скрыть.
// `pencil-number-gray-200` — оборот с одним бледным карандашным номером с приёмки M4: при
// пороге 5e-4 он скрывался; порог снижен до середины между ним и дыроколом (версия 2).
// Сканы детектора перекоса (M6, U1: косые листы `fan-*`, сетка с кривой закладкой, фото) —
// страницы с содержимым: детектор пустых их не скрывает.
const BLANK_PREFIXES = ['blank-', 'bleed-', 'punched-'];
const CONTENT_PREFIXES = ['pencil-', 'text-', 'signature-', 'fan-', 'tilt-', 'photo-'];

const classOf = (name: string): 'blank' | 'content' | null =>
  BLANK_PREFIXES.some((prefix) => name.startsWith(prefix))
    ? 'blank'
    : CONTENT_PREFIXES.some((prefix) => name.startsWith(prefix))
      ? 'content'
      : null;

const names = scanFixtureNames();

describe('детектор пустых страниц на сканах ET-3850 (M4, U2)', () => {
  it('каталог сканов заведён и каждый скан отнесён к классу', () => {
    expect(names, 'сканов нет — U1: снять и положить в scans/').not.toEqual([]);
    for (const name of names) {
      expect(classOf(name), name).not.toBeNull();
    }
  });

  it('пустые — пусто, с содержимым — не пусто; запас между классами не меньше двукратного', async () => {
    const ratios = new Map<string, number | null>();
    for (const name of names) {
      ratios.set(name, await blankRatio(scanFixture(name), PIXEL_LIMIT));
    }
    const rows = [...ratios].map(
      ([name, ratio]) => `${name.padEnd(28)} ${ratio?.toExponential(3) ?? 'null'}`,
    );
    console.log(
      `доли чернильных пикселей (порог ${BLANK_THRESHOLD.toExponential(1)}):\n${rows.join('\n')}`,
    );

    const blanks: number[] = [];
    const contents: number[] = [];
    for (const [name, ratio] of ratios) {
      expect(ratio, name).not.toBeNull();
      if (ratio === null) {
        continue;
      }
      if (classOf(name) === 'blank') {
        expect(isBlank(ratio), `${name}: ${ratio} — должен быть пустым`).toBe(true);
        blanks.push(ratio);
      } else {
        expect(isBlank(ratio), `${name}: ${ratio} — не должен быть пустым`).toBe(false);
        contents.push(ratio);
      }
    }
    expect(blanks, 'в таблице нет пустых сканов').not.toEqual([]);
    expect(contents, 'в таблице нет сканов с содержимым').not.toEqual([]);
    expect(Math.max(...blanks) * 2, 'запас между классами').toBeLessThanOrEqual(
      Math.min(...contents),
    );
  });

  it('синтетическая страница с текстом — не пусто; битый JPEG и не JPEG — null', async () => {
    expect(isBlank(await blankRatio(pageFixture(1), PIXEL_LIMIT))).toBe(false);
    expect(await blankRatio(Uint8Array.of(0xff, 0xd8, 1, 2, 0xff, 0xd9), PIXEL_LIMIT)).toBeNull();
    expect(await blankRatio(new TextEncoder().encode('<html>'), PIXEL_LIMIT)).toBeNull();
  });

  it('предел пикселей ниже размера страницы — null, без исключения', async () => {
    expect(await blankRatio(pageFixture(1), 100 * 100)).toBeNull();
  });
});
