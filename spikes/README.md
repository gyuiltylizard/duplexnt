# spikes — одноразовый код спайка M0

Скрипты для трёх критериев спайка из [ADR 0003](../docs/decisions/0003-shell-build-delivery.md).
Это **исследование, а не поставка**: код вне сборки, вне типизированного линта, не рефакторится
и тестами не покрывается. Ценность — записи в
[журнале вехи](../docs/solutions/0001-m0-scaffold.md). Клиент сканера M1 пишется заново, отсюда
ничего не переиспользуется.

Правило приватности действует и здесь: в скриптах нет адресов и идентификаторов устройства —
они приходят аргументами или из `local-test-data/` (вне git). Сырой вывод пишется туда же.

## Критерий 3 — установщик на чистой машине (U16)

1. `npm run dist` — собирает `release/duplexnt-<версия>-setup.exe`.
2. `node spikes/make-sandbox-config.mjs` — кладёт установщик в `release/sandbox-share/` и
   генерирует `release/duplexnt-sandbox.wsb` из шаблона `sandbox.template.wsb`.
3. Двойной щелчок по `release/duplexnt-sandbox.wsb`. Sandbox видит только каталог с
   установщиком, на чтение, сеть выключена.
4. Дальше — по чеклисту в `docs/output/`.

## Критерий 2 — HTTPS с самоподписанным сертификатом (U8)

Адрес сканера в скриптах не записан — он приходит аргументом или из `DUPLEXNT_SCANNER_HOST`.
Перед запросами сканер будят кнопкой на панели.

- Node (OpenSSL): `node spikes/tls-capabilities.mjs <адрес>`
- Electron main (BoringSSL), при снятой `ELECTRON_RUN_AS_NODE`:
  `node_modules\electron\dist\electron.exe spikes\tls-electron-main.cjs <адрес>`

Сценарий один на оба рантайма: `ScannerCapabilities` и `ScannerStatus` через выделенный
`https.Agent`, затем — в том же процессе — негативные проверки: локальный сервер с плохим
сертификатом и сам сканер обязаны быть отклонены через агент по умолчанию, глобальный `fetch` и
(в Electron) сетевой стек Chromium. Сертификат локального сервера делается на лету `openssl` из
поставки Git for Windows; ключ на диске не остаётся. Код выхода 0 — всё прошло.

Сырые ответы и полный отчёт — `local-test-data/device/`. Они же — источник для фикстур (U9).

## Критерий 1 — mDNS без Bonjour (U8)

`node spikes/mdns-discover.mjs [секунд] [each|default]`

Нужен `bonjour-service` в `node_modules` (в U11 удаляется из `package.json`; вернуть —
`npm i -D bonjour-service`). Режим `each` (по умолчанию) явно перебирает внешние IPv4-интерфейсы;
`default` отдаёт выбор интерфейса системе — на машине с Hyper-V и WSL он сканер не находит.
Критерий проверяется при **остановленной** службе Bonjour; состояние службы записывается до и
возвращается после.
