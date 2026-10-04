import { onTestFinished } from 'vitest';
import { startEmulator, type Emulator, type EmulatorOptions } from '../emulator/server';

// Эмулятор сканера для теста: поднимается на случайном порту loopback и закрывается по окончании
// теста, который его завёл. Сам эмулятор о vitest не знает — он же идёт и под `npm run emulator`.

/** Вызывать изнутри `it(...)`. */
export async function startTestEmulator(options: EmulatorOptions = {}): Promise<Emulator> {
  const emulator = await startEmulator(options);
  onTestFinished(() => emulator.close());
  return emulator;
}
