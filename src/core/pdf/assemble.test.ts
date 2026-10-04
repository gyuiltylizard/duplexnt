import { PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ET_3850, readFixture } from '../../../test/support/fixtures';
import { assemblePdf, jfifDpi, type PdfPageInput } from './assemble';

// Сборка PDF (план M2, U5) — обязательная зона тест-политики: против реальных JPEG устройства
// проверяется, что байты изображения в PDF РАВНЫ исходнику (нет перекодирования), а поворот —
// только свойством страницы.

const fixture = (number: number): Buffer =>
  readFixture(...ET_3850, 'pages', `page-${String(number).padStart(2, '0')}.jpg`);

const pageOf = (bytes: Uint8Array, extra: Partial<PdfPageInput> = {}): PdfPageInput => ({
  bytes,
  rotate180: false,
  dpi: 300,
  pixelLimit: null,
  ...extra,
});

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) {
    throw new Error(`отказ: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

/** Байты потоков изображений документа — в порядке страниц, без декодирования фильтров. */
async function imageStreams(pdfBytes: Uint8Array): Promise<Uint8Array[]> {
  const document = await PDFDocument.load(pdfBytes);
  const streams: Uint8Array[] = [];
  for (const page of document.getPages()) {
    const resources = page.node.Resources();
    const xobjects = resources?.lookup(PDFName.of('XObject'));
    if (xobjects === undefined || !('entries' in xobjects)) {
      continue;
    }
    for (const [, value] of (xobjects as { entries(): [unknown, unknown][] }).entries()) {
      const stream = page.node.context.lookup(value as never);
      if (stream instanceof PDFRawStream) {
        streams.push(stream.getContents());
      }
    }
  }
  return streams;
}

describe('сборка PDF: без перекодирования, порядок, поворот', () => {
  it('байты потока каждой страницы равны исходному JPEG; порядок сохранён', async () => {
    const sources = [fixture(1), fixture(4), fixture(2)];
    const pdf = unwrap(await assemblePdf(sources.map((bytes) => pageOf(bytes))));

    const streams = await imageStreams(pdf);
    expect(streams).toHaveLength(3);
    for (const [index, source] of sources.entries()) {
      expect(Buffer.from(streams[index] ?? []).equals(source), `страница ${index + 1}`).toBe(true);
    }

    const document = await PDFDocument.load(pdf);
    expect(document.getPageCount()).toBe(3);
  });

  it('фильтр потока — DCTDecode: JPEG вложен, а не перекодирован', async () => {
    const pdf = unwrap(await assemblePdf([pageOf(fixture(1))]));
    const document = await PDFDocument.load(pdf);
    const page = document.getPage(0);
    const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'));
    const entries = (xobjects as { entries(): [unknown, unknown][] }).entries();
    const stream = page.node.context.lookup(entries[0]?.[1] as never) as PDFRawStream;

    expect(String(stream.dict.get(PDFName.of('Filter')))).toBe('/DCTDecode');
  });

  it('/Rotate 180 стоит только на повёрнутых страницах; байты изображения не меняются', async () => {
    const source = fixture(2);
    const pdf = unwrap(
      await assemblePdf([pageOf(fixture(1)), pageOf(source, { rotate180: true })]),
    );

    const document = await PDFDocument.load(pdf);
    expect(document.getPage(0).getRotation().angle).toBe(0);
    expect(document.getPage(1).getRotation().angle).toBe(180);

    const streams = await imageStreams(pdf);
    expect(Buffer.from(streams[1] ?? []).equals(source)).toBe(true);
  });

  it('размер страницы — пиксели / DPI × 72 (KTD-9)', async () => {
    const source = fixture(1);
    const meta = await sharp(source).metadata();
    const pdf = unwrap(await assemblePdf([pageOf(source, { dpi: 300 })]));

    const page = (await PDFDocument.load(pdf)).getPage(0);
    expect(page.getWidth()).toBeCloseTo((meta.width / 300) * 72, 3);
    expect(page.getHeight()).toBeCloseTo((meta.height / 300) * 72, 3);
  });
});

describe('сборка PDF: DPI неизвестен (KTD-9, origin = null)', () => {
  const plainJpeg = (): Promise<Buffer> =>
    sharp({
      create: { width: 100, height: 140, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .jpeg()
      .toBuffer();

  /** Вставляет JFIF APP0 с плотностью сразу после SOI: единицы 1 — dpi, 2 — на сантиметр. */
  const withJfif = (jpeg: Buffer, units: number, density: number): Buffer =>
    Buffer.concat([
      jpeg.subarray(0, 2),
      Buffer.from([
        0xff,
        0xe0,
        0x00,
        0x10,
        0x4a,
        0x46,
        0x49,
        0x46,
        0x00,
        0x01,
        0x01,
        units,
        (density >> 8) & 0xff,
        density & 0xff,
        (density >> 8) & 0xff,
        density & 0xff,
        0x00,
        0x00,
      ]),
      jpeg.subarray(2),
    ]);

  it('плотность берётся из JFIF-заголовка (дюймы и сантиметры)', async () => {
    const source = withJfif(await plainJpeg(), 1, 150);
    expect(jfifDpi(source)).toBe(150);
    expect(jfifDpi(withJfif(await plainJpeg(), 2, 59))).toBe(150); // 59 dpcm ≈ 150 dpi

    const pdf = unwrap(await assemblePdf([pageOf(source, { dpi: null })]));
    const page = (await PDFDocument.load(pdf)).getPage(0);
    expect(page.getWidth()).toBeCloseTo((100 / 150) * 72, 3);
  });

  it('плотности нет (JPEG устройства — вообще без APP0) — дефолт 300, сборка не падает', async () => {
    expect(jfifDpi(fixture(1))).toBeNull();
    const source = await plainJpeg();
    expect(jfifDpi(source)).toBeNull();
    // Единицы «0» — только пропорции: плотность не задана.
    expect(jfifDpi(withJfif(source, 0, 72))).toBeNull();

    const pdf = unwrap(await assemblePdf([pageOf(source, { dpi: null })]));
    const page = (await PDFDocument.load(pdf)).getPage(0);
    expect(page.getWidth()).toBeCloseTo((100 / 300) * 72, 3);
  });

  it('jfifDpi: не JPEG и обрезанный заголовок — null', () => {
    expect(jfifDpi(Uint8Array.of(1, 2, 3))).toBeNull();
    expect(jfifDpi(fixture(1).subarray(0, 4))).toBeNull();
  });
});

describe('сборка PDF: отказы кодом, не падением', () => {
  it('страница свыше предела пикселей — pdfPageTooLarge с номером', async () => {
    const result = await assemblePdf([pageOf(fixture(1)), pageOf(fixture(2), { pixelLimit: 100 })]);

    expect(result).toEqual({
      ok: false,
      error: { code: 'pdfPageTooLarge', details: { page: 2 } },
    });
  });

  it('битые байты вместо JPEG — pdfPageUnreadable', async () => {
    expect(await assemblePdf([pageOf(Uint8Array.of(1, 2, 3, 4))])).toEqual({
      ok: false,
      error: { code: 'pdfPageUnreadable', details: { page: 1 } },
    });
  });

  it('пустой список — отказ, а не пустой PDF', async () => {
    expect(await assemblePdf([])).toEqual({
      ok: false,
      error: { code: 'invalidInput', details: { field: 'pages', problem: 'empty' } },
    });
  });
});
