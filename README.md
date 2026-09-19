# Duplexn't

Десктопное приложение для Windows: сканирует двусторонние документы на сканере с
автоподачей, но без автоматического дуплекса (целевое устройство — Epson EcoTank ET-3850),
в два прохода, и само собирает страницы в правильном порядке.

- Спека и правила: [`docs/duplexnt.md`](docs/duplexnt.md)
- Техническая база (eSCL, возможности устройства, проверенное на железе):
  [`docs/duplexnt-tech.md`](docs/duplexnt-tech.md)
- Роадмап: [`docs/roadmap.md`](docs/roadmap.md) · бэклог: [`docs/backlog.md`](docs/backlog.md)
  · баги: [`docs/bugs.md`](docs/bugs.md)
- Решения: [`docs/decisions/`](docs/decisions/) · журналы реализации:
  [`docs/solutions/`](docs/solutions/)

Стек: Electron, TypeScript, React — [`docs/decisions/`](docs/decisions/), ADR 0001–0003.

## Запуск

Нужен Node 22.18 или новее. Сейчас приложение — каркас (веха M0): окно с технической проверкой
сквозного среза, продуктовых экранов ещё нет.

```
npm install
npm run dev
```

Бинарник Electron качается при первом запуске, и `dev` в это время молча ждёт. Чтобы скачать его
заранее: `npx install-electron --no`.

Установщик для Windows (NSIS, без подписи; не публикуется) — в `release/`:

```
npm run dist
```

## Качество

```
npm run typecheck        npm run lint        npm run format:check
npm run test             npm run test:integration            npm run test:all
```

Подробности и назначение каждой команды — спека → «Команды».
