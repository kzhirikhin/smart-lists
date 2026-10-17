# Ручной двухэтапный ZAP

Этап 5 [плана](zap-plan.md): локальная реализация и приёмка выполнены 2026-10-17.
Ручной Actions workflow подготовлен, но ещё не опубликован и не проверен в GitHub.
Первый профиль — локальная production-сборка, не production URL и не Preview.
Он не заменяет ручную проверку прав, CSRF, заметок или всех Server Actions.

## Запуск

```powershell
npm run test:zap:manual
```

Требуются Docker и локальные npm dependencies. БД/credentials хоста не нужны:
используются тот же Dockerfile, fixed test DB и internal network, что у
[пассивного пилота](zap-pilot.md). Все порты остаются внутри namespace БД.
Сеть для установки пакетов/Chromium нужна до фазы скана. ZAP digest закреплён,
`-silent` сохраняется. Никакие адреса target CLI не принимает.

Подготовлен отдельный `.github/workflows/zap-manual.yml` с `workflow_dispatch`
без входного SHA: checkout закреплён за `github.sha` выбранной ветки/тега
workflow. Он собирает эту ревизию локально на
одноразовом runner; SHA production-коммита не означает атаку production-сайта.
Job advisory, token read-only, checkout без сохранения credentials, без secrets,
Environment/OIDC. Нет автоматического запуска на push/PR и нет расписания.
Общий npm cache и автоматический package-manager cache выключены: выбранный
выбранная ревизия не должна отравлять кеш default branch. Произвольный SHA
через input не исполняется. CodeQL alert #7
(`js/reflected-xss`) относится только к намеренно уязвимой учебной мишени
`probe=control` на loopback:3101; разобран как used in tests. Правило для
приложения и остальные CodeQL-проверки сохранены.
Кроме отсутствия cache-шагов, `cache-mode: none` запрещает доступ к cache на
уровне runtime token: одного выключения setup-node cache для этого недостаточно.
Живой запуск этого workflow требует отдельной приёмки после публикации.

## Фазы и ограничения

1. Фаза A выполняет 22 сценария пассивного пилота: публичные локали, guest,
   owner/recipient, мутации и пространства. Требуются coverage, completed,
   pending=0 и успешная проверка внешнего egress. Неполный результат закрывает
   фазу B; старый отчёт не используется как разрешение на новый active scan.
2. Фаза B поднимает тот же production-сервер, создаёт отдельные synthetic
   owner/recipient, сессии и shared list. Через браузер выполняются createList
   владельца и addItem получателя, проверяется успешный UI/DB-поток. Их Action
   ID сверяются с server-reference-manifest именно этой сборки.
3. ZAP получает захваченные multipart-запросы, а не придуманный JSON.
   Только boundary приводится к фиксированному нижнему регистру: native parser
   закреплённого ZAP иначе не атакует поля WebKit boundary. Имена и значения
   всех полей сохраняются и проверяются после нормализации; response Content-Type
   приложения не меняется. Синтетическая native-проба воспроизвела различие.
   До первой атаки проверяются обе сессии через `/api/auth/session`, затем перед,
   во время и после каждого скана. Ещё один target — публичный `/en?zap=baseline`.
4. Активные запросы идут через внутренний reverse proxy `localhost:3102` к
   `localhost:3100`. Он допускает только выбранные метод/путь и изменение одного
   текстового поля: title, itemName или публичного query. Формат FormData,
   служебные RSC-поля, listId/spaceId и остальные значения фиксируются seed.
   Иные формы, файлы, дубликаты, oversized body и пути отклоняются до upstream.

Gate передаёт исходные session/Action headers и корректный Origin приложению,
а заголовки атакующего не переносит. Поэтому это проверка обработки выбранного
input при заданной роли, **не** тест browser-origin/CORS/CSRF или подмены прав.
Успех HTTP 200 сам по себе недостаточен: для Action требуются изменённое поле
и успешный Action-result хотя бы в части атак. Нет таких запросов — incomplete.

Разрешены только 40012 (reflected XSS) и 40018 (обычная SQL injection), LOW,
threshold MEDIUM, один активный поток, без рекурсии. Маски векторов 3/1 из
закреплённого ScannerParam означают query + POST и multipart; cookie/headers/
URL path/plain body/JSON/XML/script vectors не атакуются. Все остальные поля
multipart дополнительно исключаются из ZAP; gate проверяет неизменность сам.

Лимит — 600 допускаемых к обработке попыток сканера через gate, включая seed
и отклонённые до достижения лимита запросы. После достижения новые попытки
отклоняются без передачи приложению; они входят в rejected, а не requests.
Подготовка браузеров и read-only проверки сессий не входят в этот счётчик.
Native scan останавливается
при polling; hard-limit upstream обеспечивается gate независимо от polling.
Предел active-фазы — 30 минут, orchestration — 60 минут, Actions job — 65 минут
с запасом на публикацию. Истечение лимита, redirect, потеря сессии или очереди
дают incomplete, не clean. Ручная отмена выполняется Ctrl+C или Cancel workflow;
при hard cancel/потере runner отчёты и cleanup не гарантированы.

## Отчёты

Локальный каталог: `test-results/zap-manual/<timestamp>-<probe>/`:

- `run.json`, `summary.md`, `report.html` — закрытая схема статуса/фаз, SHA,
  dirty, safe-диагностики A, счётчиков, coverage активных полей и проверок сессий.
- `phase-a.json/html` — passive pilot с его собственной историей/политикой.
- `phase-b-active.json/html` — только active source ZAP, отдельный scope.
- `phase-b-passive.json/html` — passive source во время активных запросов.

Phase-B не использует baseline/решения пассивного CI; неизвестные evidence
остаются отредактированными и несопоставимыми. Текущая версия санитайзера не
экспортирует XSS/SQL payload и полное доказательство: найденное нужно повторить
в том же изолированном окружении. Учебная мишень имеет отдельный scope.

Сырые запросы, cookie/session и тела живут только внутри удаляемых контейнеров.
Host проверяет строгую схему до сохранения отчёта; Actions publisher повторно
генерирует отчёты и загружает девять точных файлов с retention 30 дней. При
отсутствии dependencies/checkout действует фиксированная error-сводка.
Hard cancel может пропустить always-шаги. Локальные файлы удаляет владелец
рабочей копии; GitHub retention на них не распространяется.

Штатный cleanup удаляет только случайный Docker project и его ephemeral data.
При сбое очистки статус incomplete; после hard cancel нужно проверить остатки
project из лога. Чужие dev/E2E-контейнеры не удаляются.

## Контрольные пробы

```powershell
npm run test:zap:manual -- --probe=precondition
npm run test:zap:manual -- --probe=session
npm run test:zap:manual -- --probe=budget
npm run test:zap:manual -- --probe=control
```

Каждая проба создаёт новый изолированный project. Precondition запрещает B
после A; session удаляет только synthetic session получателя до атак; budget
снижает gate-limit до одной попытки и отправляет второй контрольный запрос
через ZAP: он должен быть отклонён до upstream, native scan не начинается.
Это проверка hard-limit gate, а не искусственное изменение счётчика в отчёте.
Все три должны дать incomplete и ненулевой
exit code. Control поднимает отдельную намеренно уязвимую учебную HTTP-мишень
на внутреннем 3101; Smart Lists не изменяется. Успех control требует настоящего
active alert 40012 от ZAP; простая запись строки в JSON этим не считается.

## Локальная приёмка 2026-10-17

| Проверка | Результат |
|---|---|
| Полный профиль | completed A/B, 22/22 сценария A, 545 пассивных запросов, pending=0; active 41 попытка, 0 rejected; 111.6 секунды фаз без cold build |
| Входы/роли | anonymous: 17 изменённых запросов; owner createList и recipient addItem — по 6 успешных изменённых запросов, обе сессии before/after валидны. Счётчики каждого правила сохранены |
| Находки Smart Lists | Новых active-находок в этом узком профиле не обнаружено; это не гарантия остальных входов/типов атак |
| Учебная мишень | control completed, реальный alert 40012 High/Medium confidence; 10 запросов. Отдельный scope, результат не приписывается Smart Lists |
| Потеря сессии | incomplete / active-session-lost, 0 активных запросов |
| Предпосылка | incomplete A/B aggregate, B skipped, 0 активных запросов; принудительная precondition-проба, отдельно наблюдался реальный incomplete A с отказом B |
| Бюджет | incomplete / active-budget, requests=1, rejected=1; вторая wire-попытка через ZAP не прошла к upstream |
| Publisher | Девять safe-файлов, раздельные scope, валидные схемы; повреждение JSON с приватным маркером даёт два error-файла без маркера и без старых phase-отчётов |
| Cleanup | После завершённых проб `docker ps -a` и `docker network ls` не нашли ресурсов smart-lists-zap; hard cancel/сбой daemon не воспроизводились |
| Статика | lint, typecheck, 771 unit, 533 static security; Gitleaks diff/new files без находок. Локальный исходный YAML разобран js-yaml; опубликованный профиль сужен до github.sha без input, 7 шагов, 9 upload-путей |

Полный safe-снимок: `test-results/zap-manual/acceptance-20261017/`.
Control: `1792233556154-control`, session: `1792233554992-session`, precondition:
`1792233777266-precondition`, budget: `1792234294172-budget` в `test-results/zap-manual/`.
Это результаты рабочей копии с dirty=true; SHA указывает базовый main, не
фиксирует незакоммиченный код. Raw-трафик/сессии в снимки не включены.

Unit-проверки закрепляют A106 только для перечисленных форм wire и границ;
они не доказывают настройку GitHub или отсутствие уязвимостей вне трёх входов.
Остаток приёмки публикации — первый настоящий workflow_dispatch и проверка
artifact/permissions/timeout на GitHub. Расписание/давность — этап 6, не начат.

Источники: [политики ZAP](https://www.zaproxy.org/docs/desktop/start/features/scanpolicy/),
[векторы](https://www.zaproxy.org/docs/desktop/ui/dialogs/options/ascaninput/),
[active source](https://github.com/zaproxy/zaproxy/blob/main/zap/src/main/java/org/parosproxy/paros/core/scanner/Alert.java).
