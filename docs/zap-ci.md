# Пассивный ZAP в CI

Этап 4 [плана](zap-plan.md), 2026-10-17. Workflow
`.github/workflows/zap-passive.yml` реализован отдельно от обязательного `CI`.
Он запускается на PR, push в main и вручную. Это важно для `Sync Preview Proxy`:
тот ждёт завершения workflow `CI`, поэтому добавление ZAP внутрь него задержало
бы Preview даже без зависимости в `gate.needs`.

## Исполнение и результат

Классификатор использует тот же `scripts/ci-policy.mjs`, полный PR diff и
`ENABLE_DOCS_ONLY_CI`, что обязательный CI. При docs-only записывается skipped,
Docker/сценарии не запускаются. Неизвестный режим/ошибка классификации дают error,
а не чистый отчёт. Небольшая установка report dependencies пока выполняется и
для docs-only; она не входит в обязательный CI gate.

ZAP job имеет только `contents: read`, checkout с `persist-credentials: false`,
без production Environment, secrets, OIDC и write-полномочий. Используется
обычный `pull_request`, не `pull_request_target`. Установки без npm-хуков;
production-сборка, Chromium, ZAP и БД из [локального пилота](zap-pilot.md).
Приложение, БД и сканер используют internal Docker network; сборка загружает
пакеты/браузер до фазы скана. Фиксированные fake credentials не заменяют этот
сетевой барьер. Реальные OAuth/S3/Pusher/AI в набор не входят.

Пилоту оставлены 20 минут, scan step — 22, job — 25: запас нужен для cleanup и
отчётности. Смена лимитов не расширяет покрытие. `continue-on-error` на job
делает ошибки advisory; технический outcome отдельно отмечается последним шагом.
High остаётся находкой completed-прогона, не превращается в технический failure.
`gate`, миграция production, обязательные E2E и Preview-синхронизация ZAP не ждут.
Не назначать `ZAP passive (advisory)` required check в ruleset.

Внутри 10-минутного анализа очередь ожидается до трёх минут: первая живая
проверка показала, что минуты на GitHub runner недостаточно. Pending по истечении
срока всё равно даёт incomplete. В диагностику выходят только ID выполняемых
правил/время без URL и имён; очередь не очищается, правила не отключаются.

`always()` запускает publisher и upload после обычного сбоя/timeout шага.
Hard timeout всей job, отмена workflow, потеря runner или сбой GitHub могут
не оставить summary/artifact: это не гарантия доставки. Сигнал давности и
уведомления — этап 6. Обрыв хоста/Docker может также помешать cleanup.

## Доверенные входы

Вторая checkout-копия содержит default branch. Из её зафиксированного HEAD
читаются только обычные Git blobs `config/zap/decisions.json` и `baseline.json`.
Код этой копии не исполняется; symlink mode не принимается. Рабочие файлы PR и
загруженные PR-артефакты не являются источником решений или истории.

Проверенные входы копируются в `/tmp/zap-ci-input` контейнера. CI-пилот читает
только этот каталог, не `config/zap` из образа PR. Исходники checkout не меняются.
Сводка показывает trusted SHA, источник каждого файла и отдельные признаки
`policyChanged`/`baselineChanged` для проверяемой ветки. Содержимое этих изменений
не копируется в summary. После merge решения начнут действовать из default branch.

Нет доверенной политики/checkout — пустой набор решений и отсутствие baseline.
Нет baseline — сравнение недоступно. Повреждённый/incomplete trusted baseline
даёт invalid, прежние решения не применяются. Первый PR внедрения обычно попадёт
именно в режим отсутствующей истории. История — последний явно просмотренный и
принятый в Git completed-снимок, а не автоматически последний CI-артефакт.
Обновление выполняется [командой baseline](zap-triage.md#начальная-точка-сравнения)
с обычным review diff; CI сам ничего не коммитит.

Это защита от случайной подмены конфигурации PR, не sandbox для произвольного
враждебного workflow/host-скрипта. Код PR исполняется на одноразовом GitHub runner;
права runner, GitHub Actions и проверка изменений workflow остаются границей
доверия. Синтетические данные и отсутствие боевых credentials обязательны.

## Сводка и артефакт

После job открой GitHub Step Summary и артефакт `zap-passive-<run_id>-<attempt>`:

- `summary.md` — статус, ссылка на run, UTC/SHA, trusted-источник, изменения
  policy/baseline, High и таблица очищенных находок.
- `run.json` — CI provenance и очищенная диагностика: реальные scenario IDs,
  покрытие/Actions/контексты, очередь, счётчики, длительность, ZAP/addon versions.
- `report.json` и `report.html` — только при валидном детальном отчёте.

Publisher заново проверяет схемы и генерирует HTML/Markdown; он не копирует HTML
из scan-каталога. При сбое/неустановленных зависимостях остаётся stdlib-only
error-summary без произвольного exception/stdout. В upload перечислены только
четыре точных файла; session DB, HAR, request/response, traces, screenshots,
`zap-ci-input` и промежуточные каталоги не публикуются. Job Summary ограничена
по размеру; полная безопасная таблица остаётся в артефакте.

Retention задан 30 дней; доступность зависит от GitHub и настроек репозитория,
это не долговременный архив. Объяснения и решения сохраняются в Git.
Ограничения санитайзера, expiry и смыслы known/new — в [triage](zap-triage.md).

## Локальная проверка CI-обвязки

На рабочем компьютере без соседнего trusted checkout сводка корректно покажет
unavailable и не возьмёт решения из локальной рабочей ветки:

```powershell
$env:ZAP_CI_MODE = 'full'
$env:ZAP_CLASSIFY_RESULT = 'success'
npm run test:zap:ci
node scripts/zap/ci.mjs publish
node scripts/zap/ci.mjs check
```

Выход — `test-results/zap-ci/`. Для контрольных проб передай `-- --probe=queue`
или `-- --probe=report` команде npm. Первая даёт incomplete с недоступным
сравнением, вторая — error без детального экспорта. Для skipped используй
`ZAP_CI_MODE=docs`; при `ZAP_CLASSIFY_RESULT=failure` скан не запускается.
После пробы нужно отдельно вызвать publish, даже если scan вернул ненулевой код.

Тесты `test/zap/ci.test.ts` проверяют фактическое чтение Git blob/отказ symlink,
trusted-vs-PR, статусы/High, неполное покрытие/очередь, очистку вывода и известные
формы YAML. Последний detector текстовый, не общий YAML/shell AST. Полная схема
GitHub, реальные permissions/required checks, загрузка и retention артефакта
требуют первого настоящего Actions-прогона после публикации изменений.

## Локальная приёмка 2026-10-17

| Проверка | Результат |
|---|---|
| Полный CI-wrapper на настоящем Docker/ZAP | completed; 22/22, 545 запросов, pending=0, 69.2 секунды анализа на готовом стенде |
| Нет trusted checkout | Все 66 групп неразобраны; сравнение unavailable; локальные PR decisions не применились |
| Docs-only | skipped; Docker/сценарии не запускались |
| Classifier failure | error; scan/check вернули 2; безопасная сводка |
| Подстановка pending=1 | incomplete; scan/check=2; сравнение unavailable |
| Невалидный alert с приватным маркером | error; scan/check=2; report.json/HTML отсутствуют, маркер не экспортирован |
| Искусственный отказ импорта zod у publisher | Stdlib-only error-summary, без содержимого исключения |
| Реальный Bash из YAML при отсутствии checkout | Синтаксис и fallback проверены offline в контейнере без сети/mounts |
| YAML | Разобран установленным js-yaml; проверены triggers/permissions/advisory и четыре upload-пути |
| Git source | Тест изменённого worktree и symlink mode подтвердил чтение только допустимых blobs HEAD |

Сохранённый полный безопасный пример локально:
`test-results/zap-ci-checks/completed/`; пробы — `incomplete/` и `error/` рядом.
Это локальные примеры, не ссылки на успешные GitHub runs. Локальные проверки:
lint, typecheck, 738 юнит-тестов, 500 security-контрактов; production build и
22 E2E прошли в пилоте. Обычные 143 E2E на этом этапе не менялись и заново не
запускались. Нет новых зависимостей и изменений runtime/Server Actions/БД.
Impact-check обновил TZ3 и A105; живые настройки платформы остаются unknown.

Источники: [workflow syntax GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[официальный upload-artifact](https://github.com/actions/upload-artifact).
