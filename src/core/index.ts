// Ядро: всё, что работает без Electron, — сеть, файлы, изображения. Импортировать `electron`
// и вышележащие слои отсюда нельзя (ловит lint).

export { handleProbe } from './probe/handle-probe';
