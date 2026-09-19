import sharp from 'sharp';
import type { ProbeResult } from '@shared';

const PROBE_SIZE = 8;

export type ImagingProbeResult = Pick<ProbeResult, 'image'> & {
  readonly sharp: string;
  readonly libvips: string;
};

// Настоящая операция, а не просто загрузка модуля: создать крошечное изображение, закодировать
// в JPEG, прочитать метаданные обратно. Так проба ловит и «бинарник не доехал до установщика»,
// и «доехал, но libvips не грузится».
export async function imagingProbe(): Promise<ImagingProbeResult> {
  const encoded = await sharp({
    create: {
      width: PROBE_SIZE,
      height: PROBE_SIZE,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
    },
  })
    .jpeg()
    .toBuffer();

  const metadata = await sharp(encoded).metadata();

  return {
    sharp: sharp.versions.sharp,
    libvips: sharp.versions.vips,
    image: {
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      bytes: encoded.byteLength,
    },
  };
}
