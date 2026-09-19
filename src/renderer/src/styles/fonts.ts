// Шрифты макета едут в сборке — статические пакеты Fontsource, обращений к внешним хостам нет.
// Начертания 400 / 500 / 600 — ровно те, что названы в токенах (--font-weight-*). Подмножества —
// все: имена документов пользователя могут выйти за кириллицу и базовую латиницу.
// IBM Plex Mono не бывает вариативным, поэтому оба семейства — статическими файлами.
import '@fontsource/golos-text/400.css';
import '@fontsource/golos-text/500.css';
import '@fontsource/golos-text/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
