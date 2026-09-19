import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { aliases } from './tooling/aliases';

// Терминал редактора на машине автора наследует ELECTRON_RUN_AS_NODE=1: с ней Electron
// стартует как обычный Node и окна нет. Конфиг грузится в процессе electron-vite до запуска
// Electron, а дочерний процесс наследует это окружение — поэтому снимаем переменную здесь.
delete process.env['ELECTRON_RUN_AS_NODE'];

// Входы и выходы — по умолчанию electron-vite: src/{main,preload}/index.ts и
// src/renderer/index.html → out/{main,preload,renderer}. В package.json нет поля `type`,
// поэтому main и preload выходят в CJS: под sandbox preload обязан быть одним CJS-файлом.
export default defineConfig({
  main: {
    resolve: { alias: aliases },
  },
  preload: {
    resolve: { alias: aliases },
  },
  renderer: {
    resolve: { alias: aliases },
    plugins: [react()],
  },
});
