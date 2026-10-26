/**
 * Референс текущего интерфейса для дизайн-агента (B-6, план 2026-10-26-002).
 *
 * Рендерит НАСТОЯЩИЕ экраны и модалки приложения — боевые React-компоненты на фикстурных снимках
 * — в jsdom и собирает их в одну страницу с вкладками: `docs/design/reference/index.html`. Рядом
 * — стили приложения одним файлом (`app.css`), шрифты (`fonts/`) и картинки страниц (`pages/`) из
 * фикстур устройства. Дизайн-агент строит мок от копии этой страницы (`docs/design/README.md`),
 * так что доработка идёт от реализованного интерфейса, а не от мока M0 из `archive/`.
 *
 * Не входит в `npm test` и `test:all` (свой проект vitest): `npm run design:snapshot`. Читает
 * приложение и пишет только под `docs/design/` — `src/` не трогается.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_EDITS,
  PAGE_IMAGE_SCHEME,
  ok,
  type BlankVerdicts,
  type PassSnapshot,
  type SessionEdits,
  type SessionSnapshot,
  type Snapshot,
} from '@shared';
import '../../src/renderer/src/i18n';
import { App } from '../../src/renderer/src/App';
import { FOUND, makeSnapshot, PARAMS, READY, stubApi } from '../../src/renderer/src/app-fixture';
import { MergeScreen } from '../../src/renderer/src/screens/MergeScreen';
import { assemblyOf, assemblyWithEditsOf } from '../../src/renderer/src/state/assembly-fixture';

const ROOT = process.cwd(); // vitest запускается из корня репозитория
const DESIGN_DIR = join(ROOT, 'docs', 'design');
const OUT_DIR = join(DESIGN_DIR, 'reference');
const RENDERER_DIR = join(ROOT, 'src', 'renderer', 'src');
const DEVICE_FIXTURES = join(ROOT, 'test', 'fixtures', 'escl', 'et-3850');

/** Кадр окна: размер, под который рисовался исходный мок (KTD-5). */
const FRAME = { width: 1280, height: 800 } as const;

/** Дата в именах документов по умолчанию: перегенерация не должна менять файлы (R5). */
const FIXED_NOW = new Date('2026-10-26T12:00:00');

// ── Снимки ──────────────────────────────────────────────────────────────────────────────────

const SHEETS = 6;

const keyOf = (pass: number, index: number): string =>
  `p${String(pass).padStart(2, '0')}-s01-${String(index).padStart(4, '0')}`;

function passOf(
  number: number,
  kind: PassSnapshot['kind'],
  count: number,
  state: PassSnapshot['state'] = 'completed',
): PassSnapshot {
  return {
    number,
    state,
    paramsKnown: true,
    scanner: null,
    kind,
    after: null,
    pair: null,
    backsDecision: null,
    rotate180: false,
    pages: Array.from({ length: count }, (_, index) => ({
      key: keyOf(number, index + 1),
      number: index + 1,
      lost: false,
    })),
  };
}

function sessionOf(passes: PassSnapshot[], over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 'session.reference',
    backsDeclined: false,
    saved: false,
    edits: EMPTY_EDITS,
    assembled: null,
    blankMode: 'keep',
    passes,
    ...over,
  };
}

/**
 * Картинка страницы по ключу: лица — нечётные листы-фикстуры, обороты — чётные. Пачка оборотов
 * приходит после разворота в обратном порядке: первый оборот — оборот последнего листа.
 */
function fixturePageOf(key: string, backsCount: number): string {
  const match = /^p(\d{2})-s\d{2}-(\d{4})$/.exec(key);
  if (match === null) {
    throw new Error(`не ключ страницы: ${key}`);
  }
  const [pass, index] = [Number(match[1]), Number(match[2])];
  const page = pass === 1 ? 2 * index - 1 : 2 * (backsCount - index + 1);
  return `page-${String(page).padStart(2, '0')}.jpg`;
}

/** Оборот, который детектор счёл пустым, — на картинке настоящий пустой скан. */
const BLANK_BACK = keyOf(2, 1);
const BLANK_IMAGE = 'blank.jpg';

// ── Рендер сцены ────────────────────────────────────────────────────────────────────────────

interface Scene {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  readonly html: string;
}

const scenes: Scene[] = [];
const usedPages = new Set<string>();

/** Сцена готова: картинки «загружены», `src` — файлы референса; разметка — в список сцен. */
async function capture(
  container: HTMLElement,
  scene: Omit<Scene, 'html'>,
  { backsCount = SHEETS, blank = false }: { backsCount?: number; blank?: boolean } = {},
): Promise<void> {
  const images = [...container.querySelectorAll('img')];
  await act(async () => {
    for (const image of images) {
      fireEvent.load(image);
    }
    await Promise.resolve();
  });
  for (const image of container.querySelectorAll('img')) {
    const src = image.getAttribute('src') ?? '';
    if (!src.startsWith(`${PAGE_IMAGE_SCHEME}://`)) {
      continue;
    }
    const key = src.slice(src.lastIndexOf('/') + 1);
    const file = blank && key === BLANK_BACK ? BLANK_IMAGE : fixturePageOf(key, backsCount);
    usedPages.add(file);
    image.setAttribute('src', `pages/${file}`);
    // Ленивая загрузка в кадре с transform не срабатывает у части браузеров — миниатюры пустые.
    image.removeAttribute('loading');
  }
  // Скелетон остался — значит, картинка не дошла до «загружено»: сцена была бы неправдой.
  expect(container.querySelectorAll('.skeleton').length).toBe(0);
  scenes.push({ ...scene, html: container.innerHTML });
}

function renderApp(snapshot: Snapshot, overrides: Parameters<typeof stubApi>[1] = {}) {
  stubApi(snapshot, overrides);
  return render(<App />);
}

// ── Сборка папки референса ──────────────────────────────────────────────────────────────────

const CSS_FILES = [
  'styles/tokens.css',
  'styles/base.css',
  'app.css',
  'screens/setup-screen.css',
  'screens/scan-screen.css',
  'screens/flip-screen.css',
  'screens/merge-screen.css',
  'screens/editor-screen.css',
  'modals/device-modal.css',
  'modals/add-modal.css',
  'modals/save-modal.css',
];

function appCss(): string {
  const header =
    '/* СГЕНЕРИРОВАНО `npm run design:snapshot` из стилей src/renderer/src — руками не править. */\n';
  return (
    header +
    CSS_FILES.map(
      (file) =>
        `\n/* ── ${file} ── */\n\n${readFileSync(join(RENDERER_DIR, file), 'utf8').replaceAll('\r\n', '\n')}`,
    ).join('')
  );
}

const FONT_PACKAGES = [
  { pkg: 'golos-text', family: 'Golos Text' },
  { pkg: 'ibm-plex-mono', family: 'IBM Plex Mono' },
] as const;
const FONT_SUBSETS = ['cyrillic', 'latin'] as const;
const FONT_WEIGHTS = [400, 500, 600] as const;

/** Начертания приложения (`styles/fonts.ts`) файлами: референс открывается без сети (KTD-4). */
function writeFonts(): void {
  const dir = join(OUT_DIR, 'fonts');
  mkdirSync(dir, { recursive: true });
  const faces: string[] = [];
  for (const { pkg, family } of FONT_PACKAGES) {
    const source = join(ROOT, 'node_modules', '@fontsource', pkg);
    for (const weight of FONT_WEIGHTS) {
      const css = readFileSync(join(source, `${String(weight)}.css`), 'utf8');
      for (const subset of FONT_SUBSETS) {
        const file = `${pkg}-${subset}-${String(weight)}-normal.woff2`;
        const block = new RegExp(
          String.raw`/\* ${pkg}-${subset}-${String(weight)}-normal \*/\s*@font-face \{[^}]*?unicode-range: ([^;]+);`,
        ).exec(css);
        if (block === null) {
          throw new Error(`нет начертания ${file} в @fontsource/${pkg}`);
        }
        copyFileSync(join(source, 'files', file), join(dir, file));
        faces.push(
          `@font-face {\n  font-family: '${family}';\n  font-style: normal;\n  font-display: swap;\n` +
            `  font-weight: ${String(weight)};\n  src: url(./${file}) format('woff2');\n` +
            `  unicode-range: ${block[1] ?? ''};\n}\n`,
        );
      }
    }
  }
  writeFileSync(
    join(dir, 'fonts.css'),
    `/* СГЕНЕРИРОВАНО \`npm run design:snapshot\` из @fontsource — руками не править. */\n\n${faces.join('\n')}`,
  );
}

async function writePages(): Promise<void> {
  const dir = join(OUT_DIR, 'pages');
  mkdirSync(dir, { recursive: true });
  for (const file of [...usedPages].sort()) {
    if (file === BLANK_IMAGE) {
      // Настоящий пустой скан тяжёлый (300 dpi) — ужат до размера листов-фикстур.
      const blank = await sharp(join(DEVICE_FIXTURES, 'scans', 'blank-gray-300.jpg'))
        .resize({ width: 620 })
        .jpeg({ quality: 80 })
        .toBuffer();
      writeFileSync(join(dir, file), blank);
    } else {
      copyFileSync(join(DEVICE_FIXTURES, 'pages', file), join(dir, file));
    }
  }
}

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function indexHtml(): string {
  const tabs = scenes
    .map(
      (scene, index) =>
        `      <button type="button" class="ref-tab" data-scene="${scene.id}"${index === 0 ? ' aria-selected="true"' : ''}>${escapeHtml(scene.title)}</button>`,
    )
    .join('\n');
  const frames = scenes
    .map(
      (scene, index) =>
        `    <section class="ref-scene" id="scene-${scene.id}"${index === 0 ? '' : ' hidden'}>\n` +
        `      <p class="ref-note">${escapeHtml(scene.note)}</p>\n` +
        `      <div class="ref-frame" style="width:${String(FRAME.width)}px;height:${String(FRAME.height)}px">\n` +
        `        <div class="ref-root">${scene.html}</div>\n      </div>\n    </section>`,
    )
    .join('\n');
  return `<!doctype html>
<!-- СГЕНЕРИРОВАНО \`npm run design:snapshot\` (test/design-snapshot/reference.test.tsx) — руками не
     править: ручная правка теряется при следующей перегенерации. -->
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <title>Duplexn't — референс интерфейса</title>
    <link rel="stylesheet" href="fonts/fonts.css" />
    <link rel="stylesheet" href="app.css" />
    <link rel="stylesheet" href="wrapper.css" />
  </head>
  <body class="ref-page">
    <nav class="ref-tabs" aria-label="Сцены">
${tabs}
    </nav>
${frames}
    <script>
      // Вкладка — по клику; сцена открывается и по адресу: index.html#editor.
      const show = (id) => {
        const tab = document.querySelector('.ref-tab[data-scene="' + id + '"]');
        if (!tab) return;
        for (const other of document.querySelectorAll('.ref-tab')) other.removeAttribute('aria-selected');
        tab.setAttribute('aria-selected', 'true');
        for (const scene of document.querySelectorAll('.ref-scene')) {
          scene.hidden = scene.id !== 'scene-' + id;
        }
      };
      for (const tab of document.querySelectorAll('.ref-tab')) {
        tab.addEventListener('click', () => {
          history.replaceState(null, '', '#' + tab.dataset.scene);
          show(tab.dataset.scene);
        });
      }
      show(location.hash.slice(1));
    </script>
  </body>
</html>
`;
}

/** Оформление страницы референса — вкладки и кадр окна; не стили приложения. */
const WRAPPER_CSS = `/* СГЕНЕРИРОВАНО \`npm run design:snapshot\` — оформление страницы референса (вкладки, кадр),
   не стили приложения. Руками не править. */

.ref-page {
  height: auto;
  min-height: 100%;
  padding: 16px 24px 40px;
  background: #d9d5cc;
}

.ref-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.ref-tab {
  padding: 6px 12px;
  border: 1px solid #b5afa4;
  border-radius: 8px;
  background: #f4f1ea;
  font: 500 12.5px/1 'Golos Text', system-ui, sans-serif;
  cursor: pointer;
}

.ref-tab[aria-selected='true'] {
  background: #2f2c27;
  border-color: #2f2c27;
  color: #fff;
}

.ref-note {
  margin: 0 0 8px;
  max-width: 1280px;
  font: 400 12.5px/1.45 'Golos Text', system-ui, sans-serif;
  color: #4a463f;
}

/* Окно приложения: transform делает кадр контейнером для position: fixed — модалки и тосты
   ложатся в кадр, а не на всю страницу. */
.ref-frame {
  position: relative;
  overflow: hidden;
  transform: translateZ(0);
  border-radius: 8px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  background: var(--color-bg-app);
}

.ref-root {
  height: 100%;
}
`;

// ── Сцены ───────────────────────────────────────────────────────────────────────────────────

const ASSEMBLED_EDITS: SessionEdits = {
  ...EMPTY_EDITS,
  cuts: [6],
  names: ['Договор аренды', 'Приложение 1'],
};
/** Детектор оценил все обороты; пустым счёл один. */
const BLANK: BlankVerdicts = new Map(
  Array.from({ length: SHEETS }, (_, index) => {
    const key = keyOf(2, index + 1);
    return [key, key === BLANK_BACK] as const;
  }),
);

function editorSnapshot(): Snapshot {
  // «Помечать»: пустой оборот виден в ленте с меткой «ПУСТО» (при «Скрывать» его бы не было).
  const session = sessionOf([passOf(1, 'fronts', SHEETS), passOf(2, 'backs', SHEETS)], {
    edits: ASSEMBLED_EDITS,
    blankMode: 'mark',
  });
  return makeSnapshot({
    scanner: READY,
    session,
    assembly: assemblyWithEditsOf(session, BLANK),
  });
}

/** Сколько сцен в референсе: столько `it` ниже. */
const SCENE_COUNT = 11;

const EDITOR_OVERRIDES = {
  getSaveFolder: vi.fn(() => Promise.resolve(ok('C:\\Users\\Анна\\Documents\\Сканы'))),
};

describe('референс интерфейса (B-6)', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    vi.useRealTimers();
    // Упавшая сцена — референс не переписывается: неполная страница хуже прежней.
    if (scenes.length !== SCENE_COUNT) {
      throw new Error(
        `сцен ${String(scenes.length)} из ${String(SCENE_COUNT)} — референс не записан`,
      );
    }
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'index.html'), indexHtml());
    writeFileSync(join(OUT_DIR, 'app.css'), appCss());
    writeFileSync(join(OUT_DIR, 'wrapper.css'), WRAPPER_CSS);
    writeFonts();
    await writePages();
    // Шаблон handoff'а — копией в папку: папка отдаётся дизайн-агенту целиком (R8).
    copyFileSync(
      join(ROOT, 'docs', 'templates', 'handoff.md'),
      join(DESIGN_DIR, 'handoff-template.md'),
    );
  });

  it('setup — сканер готов', async () => {
    const { container } = renderApp(makeSnapshot({ scanner: READY }));
    await screen.findByRole('button', { name: 'Сканировать лицевые стороны' });
    await capture(container, {
      id: 'setup',
      title: 'setup',
      note: 'Стартовый экран: запомненный сканер готов, параметры сканирования, запуск первого прохода.',
    });
  });

  it('device — выбор сканера', async () => {
    const discovery = ok({
      scanners: [
        FOUND,
        { ...FOUND, id: 'abcdef02-1', name: 'EPSON ET-3850', address: '192.0.2.24' },
      ],
      failure: null,
    });
    const { container } = renderApp(makeSnapshot({ scanner: READY }), {
      startDiscovery: vi.fn(() => Promise.resolve(discovery)),
      getDiscovery: vi.fn(() => Promise.resolve(discovery)),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Сменить' }));
    await screen.findByRole('dialog');
    await screen.findByText('EPSON ET-3850');
    await capture(container, {
      id: 'device',
      title: 'модалка device',
      note: 'Модалка выбора сканера: найденные в сети устройства и ручной ввод адреса.',
    });
  });

  it('scan — лицевые стороны', async () => {
    const running = passOf(1, 'fronts', 4, 'running');
    const { container } = renderApp(
      makeSnapshot({
        scanner: READY,
        session: sessionOf([running]),
        pass: {
          phase: 'scanning',
          resumed: false,
          kind: 'fronts',
          expected: null,
          params: PARAMS,
          pages: 4,
        },
      }),
    );
    await screen.findByText('СКАНИРУЕМ ЛИЦЕВЫЕ СТОРОНЫ');
    await capture(container, {
      id: 'scan-fronts',
      title: 'scan · лица',
      note: 'Идёт первый проход: подача (анимация), счётчик, параметры, лента последних пяти страниц.',
    });
  });

  it('scan — обороты', async () => {
    const running = passOf(2, 'backs', 3, 'running');
    const { container } = renderApp(
      makeSnapshot({
        scanner: READY,
        session: sessionOf([passOf(1, 'fronts', SHEETS), running]),
        pass: {
          phase: 'scanning',
          resumed: false,
          kind: 'backs',
          expected: SHEETS,
          params: PARAMS,
          pages: 3,
        },
      }),
    );
    await screen.findByText('СКАНИРУЕМ ОБОРОТЫ');
    await capture(container, {
      id: 'scan-backs',
      title: 'scan · обороты',
      note: 'Второй проход: счётчик «N из M» — число листов известно по первому проходу.',
    });
  });

  it('flip — разворот пачки', async () => {
    const session = sessionOf([passOf(1, 'fronts', SHEETS)]);
    const { container } = renderApp(makeSnapshot({ scanner: READY, session }));
    await screen.findByRole('heading', { level: 1, name: 'Разверните листы на 180° — все разом' });
    await capture(container, {
      id: 'flip',
      title: 'flip',
      note: 'Пауза между проходами: развернуть пачку и вставить в лоток (анимация разворота).',
    });
  });

  it('merge — сопоставление проходов', async () => {
    const session = sessionOf([passOf(1, 'fronts', SHEETS), passOf(2, 'backs', SHEETS)]);
    const { container } = render(
      // В приложении экран живёт внутри `.app` (колонка на всю высоту) — без неё он прижат к верху.
      <div className="app">
        <MergeScreen assembly={assemblyOf(session)} />
      </div>,
    );
    await screen.findByText('Сопоставляем проходы');
    await capture(container, {
      id: 'merge',
      title: 'merge',
      note: 'Пауза ~1,6 с после второго прохода: лица и обороты сводятся в листы, затем editor. Редизайн — B-5.',
    });
  });

  it('editor — собранный документ', async () => {
    const { container } = renderApp(editorSnapshot(), EDITOR_OVERRIDES);
    await screen.findByText(/документ 1 из 2/);
    expect(container.querySelectorAll('.thumb__blank')).toHaveLength(1);
    await capture(
      container,
      {
        id: 'editor',
        title: 'editor',
        note: 'Редактор: лента по документам (граница после 6-й страницы), превью, инспектор; один оборот помечен «ПУСТО».',
      },
      { blank: true },
    );
  });

  it('editor — модалка save', async () => {
    const { container } = renderApp(editorSnapshot(), EDITOR_OVERRIDES);
    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить 2 файла' }));
    await screen.findByRole('dialog');
    await screen.findByText(/Сканы/);
    await capture(
      container,
      {
        id: 'save',
        title: 'модалка save',
        note: 'Сохранение: имена файлов документов и папка. После записи модалка сменяется ИТОГом (высота — B-4).',
      },
      { blank: true },
    );
  });

  it('editor — модалка add', async () => {
    const { container } = renderApp(editorSnapshot(), EDITOR_OVERRIDES);
    fireEvent.click(await screen.findByRole('button', { name: /Добавить/ }));
    await screen.findByRole('dialog');
    await capture(
      container,
      {
        id: 'add',
        title: 'модалка add',
        note: 'Досканирование к документу: двустороннее или одностороннее, место вставки.',
      },
      { blank: true },
    );
  });

  it('editor — модалка newscan', async () => {
    const { container } = renderApp(editorSnapshot(), EDITOR_OVERRIDES);
    fireEvent.click(await screen.findByRole('button', { name: /Новое сканирование/ }));
    await screen.findByRole('dialog');
    await capture(
      container,
      {
        id: 'newscan',
        title: 'модалка newscan',
        note: 'Новое сканирование закрывает сессию: страницы стираются с диска — только через эту модалку.',
      },
      { blank: true },
    );
  });

  it('editor — наборы не сошлись, модалка mismatch', async () => {
    const backs = SHEETS - 1;
    const session = sessionOf([passOf(1, 'fronts', SHEETS), passOf(2, 'backs', backs)]);
    const { container } = renderApp(makeSnapshot({ scanner: READY, session }), EDITOR_OVERRIDES);
    const dialog = await screen.findByRole('dialog');
    within(dialog).getByText('Лицевых сторон 6, оборотов — 5');
    await capture(
      container,
      {
        id: 'mismatch',
        title: 'mismatch · наборы',
        note: 'Проходы не сошлись: лица и обороты лежат раздельными наборами, модалка объясняет, что делать.',
      },
      { backsCount: backs },
    );
  });
});
