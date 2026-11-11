# Threat Model — Smart Lists

**Актуальная сводка: 2026-11-11 (локальные зависимости; rollout не выполнен).** STRIDE по потокам/границам, LINDDUN для AI. Дополнения 2026-10-22 — подготовка backup (A108), устранение Critical certifi FastAPI (A109) и разбор advisory High (A66/A100); приёмка ручного ZAP workflow — 2026-10-18; аудит остальных разделов — 2026-10-14. Полной новой проверки приложения и живой инфраструктуры не проводилось.

**Image-scan 2026-11-04 / production-исправление 2026-11-05 (A110).**
[Run 41816747488](https://github.com/kzhirikhin/smart-lists-fastapi-service/actions/runs/41816747488)
успешно проверил provenance/evidence прежнего serving `sha256:b36483f5…96c4c9b`,
но заблокировал Python 3.14.9 / CVE-2026-115557 (Critical) и четыре исправимых
High pyasn1 0.6.4; 60 неисправимых High остаются advisory по A100. Certifi-фикс
A109 остаётся действующим, но не покрывает runtime-level distrust eMudhra
intermediate CA keys. Затронуты TB4/TB5 (TLS и зависимости проверки вызывающего).
FastAPI закрепляет Python 3.14.10 в builder/runtime/трёх workflow и
pyasn1 0.6.5 в обоих hash-lock; другие Python-версии пакетов не изменены.
299 тестов без сети, pip check, production build и health/auth/TLS smoke прошли.
Локальный Grype 0.117.0 со свежей базой: PASS, Critical=0, блокирующих High=0,
advisory High=60, VEX/waiver=0; это не serving/provenance-проверка production.
Минимальные установленные версии и равенство patch pins проверяет CI-контракт;
он не доказывает TLS-handshake distrust или недостижимость ASN.1 DoS во всех
SDK/ADC-путях. Новых границ, IAM-прав, секретов или состава AI-данных нет;
колёса/хеши, fail-closed scan, OIDC/WIF, квоты и прежние риски сохранены.
Исправление опубликовано [FastAPI PR #96](https://github.com/kzhirikhin/smart-lists-fastapi-service/pull/96),
commit `d8140c23dbd4a2f627b4ff7e603c8a5ce9769541`.
[Deploy 41958660134](https://github.com/kzhirikhin/smart-lists-fastapi-service/actions/runs/41958660134)
прошёл test, provenance, attestation, SBOM и pre-deploy Grype; ревизия
`insights-api-00069-5fl` получает 100% трафика по результату deploy.
[Serving scan 41959094732](https://github.com/kzhirikhin/smart-lists-fastapi-service/actions/runs/41959094732)
подтвердил provenance/evidence и policy PASS: Critical=0, блокирующих High=0,
advisory High=60, VEX/waiver=0. Parent OCI
`sha256:b2c70a6841c62706164434f218c5e2a8db624991e36b7cc090f47a74e4e24ced`,
serving child
`sha256:5839780ab8f1207495c4511400c3b5fc0a4c2010bbc75d529d0daa2f82c06e8a`.
Внешние health/insights без токена дают ожидаемый IAM 403. Владелец 2026-11-05 подтвердил получение реального AI-инсайта через production UI
после выкладки. Это общая ручная проверка, не полный набор AI-сценариев.
Подробный review: FastAPI `security/reviews/2026-11-05-image-scan.md`.

## Security-обновление Next.js (2026-11-09, A52/A58)

Next.js и `eslint-config-next` обновлены с 16.4.0 до 16.4.5:
[октябрьский релиз](https://nextjs.org/blog/nextjs-security-update-october-14-2026)
закрывает RCE в Cache Components/оптимизации изображений и DoS через Server Actions;
[16.4.5](https://github.com/vercel/next.js/releases/tag/v16.4.5) включает семь
ноябрьских advisory. App Router и Server Actions используются, поэтому октябрьский
DoS применим к прежней версии независимо от отсутствия `use cache`/`next/image`.
Затронута реализация TB1 и доступность приложения; новых активов, прав,
границ доверия, credentials или внешних сервисов нет. Прикладные auth/space guards,
Zod, CSP, квоты, noteVersion и realtime-протокол не меняются.
Для подтверждённой уязвимости принято разовое security-исключение из A52:
релиз 2026-11-03 младше семи дней. Установка без хуков и Linux lock сохранены.
Контракт `test/next-config.test.ts` повышает минимальную версию до 16.4.5 и
сверяет Next/ESLint/lock. Он не проверяет отсутствие будущих CVE, эксплуатацию
уязвимостей или фактическую версию production. Rollout подтверждён отдельно:
PR #260, `main@590a031a3cbf0b606bf431e4b91d9b88dc391484`,
[main CI](https://github.com/kzhirikhin/smart-lists/actions/runs/42609609994)
и production migration успешны;
[Vercel](https://vercel.com/kirills-projects-ed9814e1/smart-lists/C7P8CCLHvMKW4D8BAKoHXZRuAoas)
сообщил success для того же SHA. Production `/en` дал 200; чистый Chromium
подтвердил гостевые список/пункт/подпись и reload без ошибок JavaScript.
Это датированная проверка выкладки, не постоянный контроль deployed-версии.
Локальный npm audit после обновления не содержит `next`, но сообщает 7 high
и 9 moderate записей по другим пакетам/зависимым цепочкам. Их достижимость
не установлена этим обновлением; отдельный пробел записан в `risks.md`.
Проверены lint/typecheck, 833 unit, 579 static security, 320 integration
(15 skipped) и 146 E2E на production-сборке Next.js 16.4.5 с локальными
тестовыми БД. Live OAuth/Pusher/S3/AI не проверялись; тестовые сессии и
фиктивные сервисные credentials не подтверждают внешние интеграции.

## Локальные зависимости (2026-11-11, A112)

OIDC 4.0.6 + AWS provider 3.3.18 сводят обе цепочки к cli-config 0.3.6 и
Zod 4.6.7, устраняя GHSA-mrhx-c7xc-m3w5 во вложенных копиях. Основная
валидация приложения уже использовала исправленный Zod. В просмотренном
CLI-config пути проверяются локальные файлы; путь от HTTP-входа к уязвимому
массиву не найден. Это review, не утверждение о всех SDK-путях.
fast-uri@3 3.1.9 закрывает четыре URI advisory без смены мажора.
Локальный npm audit итогового lock: Critical=0, High=0, Moderate=8, одна
GHSA-g3hv-75wg-m249 в minimatch 10.2.6 через typescript-eslint. Совместимый
upstream требует @10; override @11 не введён. Просмотренный вызов в
useProgramFromProjectService.js передаёт dot:true без optimizationLevel>=2,
необходимого по advisory; это ограниченное свидетельство, не blanket VEX.

Затронуты runtime identity/TB2/TB4 и цепочка поставок, загрузка окружения
(dotenv 18.0.9), клиентские анимации/порядок (Motion 14.9.0). Новых сервисов,
IAM-прав, прикладных URL allowlist или передаваемых AI-данных нет. Сохраняются
auth/space guards, WIF, noteVersion, S3 two-phase и revalidation/realtime.
OIDC 4 добавляет VERCEL_OIDC_TOKEN_FILE: путь приходит из доверенного env,
приложение не формирует его из HTTP. Пустой файл не даёт тихий env fallback;
SDK перечитывает файл при ротации. Это проверяется на фиктивных токенах,
без STS и не является доказательством production WIF.

Девять изменённых lock-записей старше семи дней; integrity сверена с registry.
Официальные tarball OIDC/provider/cli-config, fast-uri, dotenv и Motion
сверены по SHA-512, install-хуки не исполнялись. Это не полный аудит upstream.
Контракты проверяют все присутствующие копии Zod/fast-uri/OIDC в lock, но
не находят новые CVE и не контролируют deployed-версию. План/проверки:
[обновления](docs/dependency-updates-2026-11.md). Live S3 на Preview, AI WIF
и rollout нового набора пока не подтверждены. A52 без нового исключения,
A58 и прежние статусы других угроз не пересматриваются.
Итоговые локальные проверки: lint/typecheck, 840 unit, 586 static security,
335 integration под ограниченной runtime-ролью, backup/restore gate и 146 E2E
на новой production-сборке прошли; снимки 320px/light и 1280px/dark просмотрены.
Prisma generate с пустым DIRECT_URL прошёл. Это не live S3/AI/OAuth/Pusher.

## Подпись состояния пункта (2026-11-09, A111)

Добавлено общее для участников поле `Item.statusText`: одна строка plain text
до 120 символов, не связанная с enum статуса или версией заметки. Затронуты
активы содержимого списков, TB1/TB6 и гостевое localStorage; передача
подписи в AI затрагивает также TB4/TB5. Новых границ,
сервисов или credentials нет. Доступ проверяется по БД в текущем пространстве
и повторяется в UPDATE; сохранены auth, суточный бюджет, scoped DB, layout
revalidation и after/Pusher с исключением socketId. Pusher передаёт только
refresh; подпись не логируется. В AI-контекст она включается как отдельное
поле `status_text` у отобранных пунктов и подпунктов после повторного Zod
safeParse. FastAPI независимо проверяет тип, trim, одну строку и 120 символов,
при отсутствии/пустом значении сохраняет совместимость старого клиента.
Бюджеты 50 пунктов/100 подпунктов и фактического тела 100 КБ сохранены;
подписей не более 18 000 символов. State text сериализуется только в общий
экранированный untrusted JSON; system prompt трактует его как ситуацию/блокер,
не меняющий enum статуса, и запрещает исполнять вложенные команды.
Уведомление о составе данных обновлено в четырёх локалях; opt-out и квоты
сохранены, прежние риски внешней обработки распространяются на подпись.
Проверены обе стороны контракта, граничные значения и prompt injection
без сети и вызовов модели; это не подтверждение послушания реальной модели.
Выкладка требует FastAPI перед web. Zod ограничивает ввод,
React отображает текст без разбора HTML. Миграция добавляет nullable VARCHAR(120),
не меняет RLS, FK и права ролей. Проверены schema/guest unit и DB-интеграции
owner/editor, другого пространства, постороннего, отзыва share и валидации;
39 E2E подтвердили новый редактор, reload, отмену, удаление, поиск, гостя
и существующие потоки пунктов/подпунктов. Снимки на 320/1280 px в тёмной/светлой
темах просмотрены; это не live-проверка Pusher или платформенных настроек.
Одновременные изменения подписи разрешаются последним сохранением, как у
названия; защита noteVersion заметок сохранена. Перенос сохраняет подпись,
новая копия сбрасывает её. Production/Preview миграции уже применены
защищёнными jobs: web CI 42589710225 и Preview sync 42590375617; read-only
production catalog audit 42590524160 успешен. AI PR #100, deploy 42588589538:
insights-api-00070-q8b получил 100% трафика; serving scan 42589128871
подтвердил provenance/evidence и PASS (Critical=0, блокирующих High=0,
advisory High=59, VEX/waiver=0). Web PR #258, SHA f82b342 опубликован вручную
из main через Vercel Create Deployment после зелёной миграции: deployment
ERDQcFW9eXztpPVcxmLzbQs7vGNA имеет Ready. Автозапуск main deployment
не произошёл; причина неизвестна, настройки integration не менялись.
Production guest smoke подтвердил /en=200, создание/сохранение подписи после
reload и её положение над названием; это не проверка OAuth, live Pusher или
ответа Vertex AI на новое поле. Новые пользовательские credentials не брались.

## Карта документа

**Image review 2026-10-22, TB11/A66/A100.** Artifact scan `39732626472`
для serving `b36483f…96c4c9b` проверен по SHA-256: 55 advisory High по 14 CVE,
Critical=0, VEX/waiver=0. Четыре CVE без прежнего review изучены по upstream.
Новые проверки strfmon, libstdc++ и Pod::Text в FastAPI PR #89 локально
подтверждены на exact serving rootfs: PASS 29 checks, 30 candidates, 752 ELF,
без запуска контейнера. PR #89 слит;
[main-scan 39783031067](https://github.com/kzhirikhin/smart-lists-fastapi-service/actions/runs/39783031067)
подтвердил provenance/evidence/policy PASS, те же 29 checks/30 candidates,
Critical=0, 55 advisory High и VEX/waiver=0.
PBDS erase_if — header-only; отсутствие динамической
libstdc++ не исключает статически встроенный шаблон. Sdist шести native-
зависимостей не содержит известных PBDS-маркеров; соответствие wheel и
полнота native build inputs не доказаны. Новых исключений/waiver нет,
политика A100 и её принятый остаток сохраняются. Read-only Cloud Run API
подтвердил тот же digest, 100% трафика и отсутствие command/volume overrides;
это ручная проверка на дату, не CI-контроль конфигурации.

**Dependency review 2026-10-18:** плановые minor/patch-обновления прямых зависимостей AWS SDK,
Next.js/ESLint, OIDC, Google Auth, UI/i18n, логирования и тестового стека.
Затронуты реализации TB1/TB2/TB4, но не состав данных, права,
границы доверия или прикладные лимиты. Сохранены A51 (установка без хуков),
A52 (семидневный cooldown Dependabot), минимальная security-версия Next.js
и равенство версий Next/ESLint в `test/next-config.test.ts` (A58).
Новые React Compiler lint-правила имеют пять построчных исключений для
существующей синхронизации RSC/гидратации и событий: это не отключает
`react/no-danger`, валидацию или проверки доступа. Зелёный CI не доказывает
отсутствие закладки; live OAuth/S3/Pusher/AI требуют отдельной ручной проверки.
AWS provider 3.3.11 имеет прежний runtime-код, но транзитивно использует OIDC
4.0.0: после request header добавлен источник `VERCEL_OIDC_TOKEN_FILE`,
затем прежний env token. Прямой OIDC 3.8.10 (GCP) отличается от 3.8.9 только
версией. Новый env-путь приложение не задаёт; он относится к доверенной
runtime-конфигурации, не к пользовательскому вводу. Наличие переменной на
живой платформе не проверялось. 71 изменённый npm-артефакт production/dev
сверен с registry: integrity совпадает, каждому более семи дней.
На синтетических токенах проверены env fallback, приоритет и ротация файла,
отказ при отсутствии файла (без платформенных credentials/сетевых вызовов).
Новая граница или доступ не вводятся; принятые риски сохраняются.

- [Реестр допущений](docs/threat-model/assumptions.md) — 111 стабильных ID, контроль, границы, дата и статус сверки.
- [Риски и план](docs/threat-model/risks.md) — открытые пробелы, принятые риски и условия пересмотра.
- [Отчёт аудита](docs/threat-model/audit-2026-10-14.md) — источники, воспроизведённые пропуски и ограничения.
- [Исторический снимок](docs/threat-model/archive-2026-10-14.md) — прежние rollout/digest; содержит устаревшие/опровергнутые утверждения, не источник текущих гарантий.

Связанные источники: [память проекта](PROJECT_MEMORY.md), [DB security](DATABASE_SECURITY.md), [секреты и доступ](SECRETS.md). Источники истины — исходники, schema, миграции и конфигурация обоих репозиториев.

**Дополнение 2026-10-16: локальный ZAP.** По [спецификации](docs/zap-plan.md)
реализован [пассивный пилот](docs/zap-pilot.md): эфемерная БД, синтетические
сессии, internal Docker network, техническая сводка без raw-трафика. A103
фиксирует узкое покрытие. [Этап 3](docs/zap-triage.md), A104: очищенные локальные
отчёты, нормализация, точные решения/expiry и явная точка сравнения. Неизвестные
evidence редактируются и остаются несопоставимыми. CSP — открытый confirmed gap.
Обычные E2E не используют ZAP по умолчанию. [Этап 4](docs/zap-ci.md), A105:
независимый advisory workflow, trusted Git-входы, publisher/точные upload paths.
Локальная приёмка есть. Первый PR-run 38996621804 подтвердил безопасный
error-артефакт с retention 30 дней; ruleset не требует ZAP, обязательный CI
38996621674 завершился успешно независимо от ZAP failure. Полный PR-run
38998447566 completed: 22/22, 551 запрос, pending=0; CI 38998447572 зелёный.
PR #231 слит. Main-run 39000032408 completed: 22/22, 549 запросов, pending=0;
trusted policy/baseline из main, comparison available, применены три решения.
Основной CI 39000032432 и production-публикация успешны. Живые пробы
incomplete/skipped опубликованы; ожидание update metadata правилом 10116
устраняется штатным `-silent` без открытия egress. Актуальность сканера
этот изолированный профиль не доказывает: digest/addons требуют отдельного review.
[Этап 5](docs/zap-manual.md), A106, проверен локально: отдельный manual профиль
после passive coverage, internal gate с allowlist одного поля и hard-budget,
низкая сила/два правила/один поток. Completed A/B: 545 пассивных запросов,
pending=0, 41 активная попытка; две Actions получили по 6 успешных мутаций входа.
Контрольная мишень дала XSS alert, session/precondition/budget-пробы отказали.
Ручной Actions workflow опубликован через PR #235: main-run 39045344867
completed A/B, dirty=false, 546 passive/pending=0, 41 active, обе Actions по 6
успешных изменений поля. Девять safe-файлов/схемы/точное воспроизведение проверены,
Contents/Metadata read, API retention 30 дней; fault-пробы только локальные.
Этап 5 завершён в этих границах. Gate фиксирует
session/Origin/служебные поля: это не тест CORS/CSRF/обхода прав.
[Этап 6](docs/zap-operations.md), A107: месячный скан и ежедневный
контроллер давности/сбоев, журнал в bot Issue без срока удаления. Новая граница
TZ5: source run/artifact → доверенный default-branch контроллер → GitHub Issue.
Только он получает actions:read/issues:write, не source scanner. Run/attempt,
repo/ветка/workflow перепроверяются REST; строгий JSON и успешные шаги нужны для
обновления последнего успеха. Более 40 дней — stale; сбой не сдвигает дату.
PR #237 слит. Live bootstrap #238, изолированные failure/stale/recovery #239
и отсутствие повторного stale-комментария проверены. Source 39091016597
completed A/B → workflow_run 39091399377 обновил настоящий lastSuccess;
история содержит только настоящие completed, без записей проб. Оба workflows
active, token контроллера read/Issues write подтверждён логом. Будущие cron и
email не наблюдались; общий сбой Actions не обнаруживается независимым сервисом.
High-triage здесь не автоматизируется.
[Карта покрытия](docs/zap-coverage.md), review 2026-10-18, уточняет остаток A106:
manual-v2 добавляет renameList/title owner и renameItem/itemName recipient
к anonymous query и полям createList/addItem. Reflected XSS на RSC
не проверяет выполнение сохранённого текста при последующем отображении.
Локально A/B completed: 545 passive/pending=0, 61 active, у обеих новых целей
по 6 успешных мутаций, persisted/rendered=true. Пять точных целей, seed success,
оба native-правила и UI/DB-проверки обязательны в completed-схеме. Инвентарь
Actions — разовый review, не CI-гарантия полноты. A107 сохраняет digest политики
и проверяет точные scope фаз B: прежний lastSuccess сохраняет дату, но не
подтверждает новое покрытие (profile-outdated). PR #241 слит; main-run 39107196382
completed A/B, dirty=false: 559 passive/pending=0, 61 active, persisted/rendered
новых целей true. Девять safe-файлов валидированы/воспроизведены, Gitleaks чистый.
Контроллер 39107211069 подтвердил profile-outdated с прежней датой; workflow_run
39107635885 обновил #238 до нового digest/healthy и даты анализа 07:25:56Z.
Daily schedule 39107674127 success; запуск создан 07:26:36Z вместо 02:43 UTC,
что подтверждает возможную задержку, не SLA. Будущие cron/email не гарантированы.
Остатки CSRF/прав/полноты XSS и изоляция внешних сервисов сохранены.
Первый PR-run manual-v2 39094262001 не считается completed: A прошла, B error
на seed до атак, technical outcome failure; зелёная advisory-обёртка не успех.
Подготовка ждёт HTTP 200 и запись в БД; диагностика seed — закрытые поля.
PR-run 39095114639 подтвердил все 61 active и persisted обеих новых целей,
но UI-проверка завершилась ошибкой чтения browser response body и не засчитана.
Подтверждение UI-мутаций теперь использует HTTP 200 и scoped БД,
без чтения освобождаемого Chromium body; native gate продолжает проверять RSC.
Run 39095895555 достиг общего тайм-аута без завершения B; причина внутри ожиданий
не локализована. UI/nav ожидания ограничены 10/20 секундами, SDK finished не нужен.
Две фиксированные store-and-read пробы после закрытия gate используют frozen
rename-seed вне бюджета native scan: меняется только разрешённое поле, проверяются
RSC success, scoped БД и текст после reload. Это не полнота stored XSS.
Веточная приёмка и артефакты — [PR #241](https://github.com/kzhirikhin/smart-lists/pull/241).
Она проверена отдельно от описанной выше main-приёмки и обновления журнала.
Повторная верификация временно недоступных jobs/artifact не запускает новые
атаки. Подтверждённый тот же attempt заменяет временный отказ, сохраняя дату
анализа; этот крайний случай проверен unit-тестом, не live-сбоем GitHub API.
Production active scan исключён.
Ручной checkout использует github.sha выбранной ветки/тега, без SHA input,
и не использует общий npm/автоматический cache
runner: PR-проверка выявила риск cache poisoning, кеширование отключено.
`cache-mode: none` ограничивает сам cache runtime token, в том числе для
исполняемого кода выбранной ревизии; одного отсутствия cache-шагов недостаточно.
CodeQL alert #7 — намеренный reflected XSS только в изолированной учебной
мишени control, исключение used in tests; правило приложения не отключено.

## Critical: доверие TLS FastAPI (2026-10-22)

Serving image scan [39569700298](https://github.com/kzhirikhin/smart-lists-fastapi-service/actions/runs/39569700298)
заблокирован GHSA-6q48-6c7w-9gw2: certifi 2026.7.22 доверяет emSign ECC Root CA - G3
с скомпрометированными промежуточными CA. Затронуты получение Google signing keys
в TB4 и исходящий TLS TB5. Успех scan 2026-10-14 не описывает текущую базу уязвимостей.
Исправление certifi 2026.10.19 опубликовано FastAPI PR #86, commit
`24dbe7b6924da0bfe603537bd209b7bde9dfb328`. Deploy `39732206290` прошёл gates;
ревизия `insights-api-00068-mdn` получает 100% трафика. Serving scan
[39732626472](https://github.com/kzhirikhin/smart-lists-fastapi-service/actions/runs/39732626472)
подтвердил exact provenance/evidence и policy PASS: Critical=0, certifi matches=0,
VEX/waiver=0. Parent OCI `sha256:9a8508060c8286fc7bfd676284e366f5030ed59d2b825b23e3d30575d7ccf78b`,
serving child `sha256:b36483f57518b5b9889b97f6323186763ffe24cb869689b6e9ee9100096c4c9b`.
Critical закрыт для проверенного serving digest; это датированная M, не гарантия
будущего rollout или отсутствия других уязвимостей.
Wheel сверён с PyPI SHA-256 и всеми файлами upstream commit
`662df63d7906df66f1f07c0751a3dfe9da14d914`; из CA-набора удалён один root,
новых roots нет. Runtime-код core.py не меняется. Срочное исключение A52
из семидневной выдержки соответствует приоритету владельца; gates не ослабляются.
A109 закрепляет отсутствие exact DER root в requests/httpx; это не проверка
всех TLS consumers/окружения или свидетельство отсутствия MITM.
Из локального production-образа с новым certifi проверены HTTPS к Google signing
keys (200, непустой набор) и Vertex endpoint (TLS/404, без credentials/модели).
Анонимные внешние health/insights Cloud Run дают IAM 403. Владелец 2026-10-22 подтвердил работу AI-инсайта в production UI. Это общая
ручная UI-проверка, не все AI-сценарии; browser runtime агента недоступен.
Остальные 55 High advisory не пересматриваются этой задачей.

## Состояние доказательств

Есть прикладные/DB-контроли доступа, ограничения входа/квот, security gate и защищённые release-пути. Наличие контроля не доказывает полноту всех способов доступа или невозможность регрессии.

Аудит уточнил 30 записей. A29/A74 не покрывают все формы экспорта и не доказывают исполнение найденного контроля. A56/A68 инвентаризируют распознаваемые конструкции, не весь egress. A51/A54/A70/A71/A75/A79 тоже имеют более узкие границы, чем обещали заголовки. Перенесённые записи явно не перепроверены; прежняя T не свежая гарантия.

**Внешние настройки сегодня — unknown**, пока их не прочитали/проверили в текущей задаче. Датированная M — историческое наблюдение. IAM/CORS/versioning/rulesets/caps/расписания могут дрейфовать без изменения кода. T — тест узкого контракта в выполняющем его прогоне; docs-only CI может тесты пропустить.

## Область и активы

Авторизованные данные — PostgreSQL; гостевые — localStorage. AI-сервис получает контекст из Next.js и БД не читает. Гостевой режим без sharing, Pusher, вложений и AI.

| Актив | Основной ущерб и граница |
|---|---|
| Списки, записи, заметки, группы, пространства, sharing | Чужое содержимое/права; личная классификация участника не должна уходить в AI (A38) |
| Account, Session, AllowedEmail | Вход, отзыв, персональные данные; OAuth scope/срок оценивать отдельно, не обещать отсутствие refresh_token по старому снимку |
| Вложения lists/* | Раскрытие/подмена, хранение после удаления; S3 не удаляется DB-каскадом |
| Дампы backups/*, PITR | Полная копия БД, восстановление/утрата; сроки/права/restore отдельно |
| DB credentials, scoped context | Data plane; DB-права и control plane — разные границы (A31/A43/A83) |
| Runtime/deploy identities, локальные credentials | Данные, подмена кода, платные вызовы; RCE получает runtime-полномочия (A25) |
| AI-контекст, ответ, квоты | Внешняя обработка, injection, расходы; caps не точный hard limit (A96) |
| AuditEvent, логи, SBOM/provenance | Privacy, атрибуция, происхождение; SBOM не доказательство полноты/безопасности |

## DFD и границы доверия

Схема — функциональные пути кода. Размещение/IAM — исторически описанная конфигурация; платформы 2026-10-14 не проверялись.

~~~mermaid
flowchart LR
    B[Браузер] -->|TB1: RSC / Server Actions| N[Next.js / Vercel]
    B -->|TB2: presigned POST / GET| S[S3 lists]
    B -->|TB3: private WSS| P[Pusher]
    N -->|TB6: scoped Prisma / TLS| D[Neon PostgreSQL]
    N -->|presign / Head / prefix / Delete| S
    N -->|refresh без содержимого| P
    N -->|TB4: ID token + контекст| F[FastAPI / Cloud Run]
    F -->|TB5: ADC + prompt| V[Vertex AI]
    G[GitHub Actions] -->|release / audit| D
    G -->|TB8: backup OIDC| K[S3 backups]
    G -->|TB11/TB12: image / provenance / SBOM| A[Artifact Registry]
    A -->|exact digest deploy| F
    G -->|TB9: проверенный SHA| Q[Vercel Preview]
    PB[Chromium / local pilot] -->|TZ1: synthetic Session| Z[ZAP / internal network]
    Z --> LN[Next production build / local]
    Z -->|TZ4: active / query или одно поле| WG[Внутренний gate / budget]
    WG -->|seed Session / Origin / FormData| LN
    WG -->|только control probe| LAB[Отдельная учебная HTTP-мишень]
    LN --> TD[Эфемерная PostgreSQL]
    Z --> C[Сборщик пилота]
    C -->|TZ2: схема / allowlist evidence| O[Локальный test-results]
    O -->|TZ3: повторная схема / точные файлы| ZA[GitHub summary / artifacts]
    TC[Default branch Git blobs] -->|TZ3: policy / baseline| C
    ZA -->|TZ5: REST / ZIP / строгий JSON| OC[Контроллер из default branch]
    OC -->|issues write / только safe metadata| J[Bot Issue / журнал состояния]
~~~

| ID | Граница | Контроль и существенный предел |
|---|---|---|
| TB1 | браузер → Next.js | auth/AllowedEmail, Zod, ownership/space guards; A74 частичный. Vercel Authentication M/unknown (A101) |
| TB2 | браузер → S3 | подписанная policy, тип/размер/TTL; confirm Head/префикс, не весь файл. Подпись пригодна до TTL |
| TB3 | браузер → Pusher | private channel по сессии; Force TLS/client events внешние |
| TB4 | Next.js → FastAPI | ID token, повторная caller/audience-проверка, byte/payload budgets, quota/locale; IAM unknown |
| TB5 | FastAPI → Vertex AI | genai.Client: ADC, project/global/v1, timeout; generate_content без tools. A39/A56 частичные; качество/privacy не следуют из mocks |
| TB5-legacy | прежний Anthropic | код удалён; одно rule архивировано по сообщению владельца. Другие каналы не инвентаризированы (A93) |
| TB6 | Next.js → Neon | verify-full, runtime-роль, scoped context/RLS/guards; deployed каталог требует live audit |
| TB7 | пользователь/пространство A ↔ B | listInSpaceWhere, scoped транзакции/DB enforcement; логическая граница внутри потока |
| TB8 | backup workflow → S3 | OIDC/ограниченная роль; клиент PGDG по HTTPS с отдельным signed-by (A108). External trust/bucket policy unknown |
| TB9 | main CI → preview → Vercel | защищённый workflow синхронизирует проверенный SHA; branch/rulesets unknown |
| TB10 | workflow → Neon enforcement | target guards, Environment, catalog contract, locks, транзакционный apply; среды отдельно |
| TB11 | scanner → metadata / Registry | traffic/tagged revisions, offline evidence; read-only IAM отдельная live-проверка |
| TB12 | deploy → Registry → Cloud Run | exact digest/SBOM/attestation до защищённого deploy; ручной путь не запрещён Binary Authorization |
| TZ1 | тестовый браузер → локальный ZAP → тестовое приложение | Отдельный Docker project/БД, internal network, localhost proxy/API без published ports; 22 выбранных сценария, не весь HTTP/API; A103 |
| TZ2 | память ZAP → сборщик → локальные отчёты | Конечные словари признаков, строгая схема, лимиты размера, экранирование HTML/Markdown; raw headers/body/session DB/trace не экспортируются. Неизвестное несопоставимо, error запрещает детальный экспорт. A104 |
| TZ3 | default branch / PR-runner → CI publisher → GitHub artifacts | Обычные blobs trusted checkout, без PR fallback; повторная схема и генерация отчёта, точный upload allowlist, stdlib error fallback. Независимый advisory workflow без боевых secrets/OIDC/write; runner/workflow-код доверен, произвольный PR host-код этим не sandboxed. PR completed/error/incomplete/skipped и trusted main после merge подтверждены 2026-10-17; A105 |
| TZ4 | active ZAP → внутренний gate → synthetic приложение | Fixed origin/пути/методы/одно поле, hard-budget до upstream; seed session/Origin сохранены, redirect не передаются, другие Actions не сканируются. Только internal network, не production/Preview. Локальные success/control/fault-пробы прошли; Actions success run 39045344867 проверен 2026-10-18, Actions fault/forced timeout не проверены; A106 |
| TZ5 | source run/artifact → controller → GitHub Issue | Checkout только default branch, не head_sha события; source API/attempt/ветка/собственный repo, точные имена ZIP без extraction/исполнения, строгие JSON, issues:write только контроллеру. Live bootstrap/probes/workflow_run проверены 2026-10-18. Журнал/владельцы repo доверены, будущий cron/email и общий сбой Actions не гарантируются; A107 |

SDK выполняют дополнительные запросы (БД, S3, Pusher, JWKS, ADC); DFD и egress-тесты не полная опись сетевых соединений.

Подготовка backup (2026-10-22): ключ PGDG ограничен одной APT source через
`signed-by`, загрузка по HTTPS с отказом на HTTP-ошибку. Глобальное доверие
через `apt-key` снято. Актив — полный дамп БД; установка пакетов остаётся
доверенным кодом раннера. TLS БД, Environment Backup, OIDC и путь S3
сохранены; новая внешняя платформа или credential не вводятся. Статический
контракт A108 не доказывает доступность PGDG, отсутствие закладки или
восстановимость дампа; live bucket policy и restore остаются unknown.

## Контроли, которые нужно сохранять

- Сессия до защищённой операции; владелец/редактор различаются, клиентские ID/role не источник прав.
- spaceId от URL/адаптера до Action/Prisma; scoped context/RLS/guards/составные ограничения. Live rollout не выводится из миграций.
- Серверный safeParse, ожидаемая noteVersion; суточный бюджет и структурные потолки — разные ограничения.
- Layout revalidation, after/realtime с исключением socketId автора; ошибка уведомления не отменяет БД.
- PENDING → S3 → HeadObject/префикс → UPLOADED; SDK/credentials только на сервере; отдельная cleanup/reconciliation.
- AI opt-out/quota/payload budgets; экранированный JSON отдельно от system prompt. Это ограничение injection-поверхности, не доказательство послушания модели.
- Валидация AI-ответа, SafeMarkdown без ссылок/картинок; response.json читает тело до ограничения строки (A59).
- Install-хуки отключены на известных путях; SHA pins, gates, exact digest/provenance/CVE-policy в пределах их проверяемых механизмов.
- Не логировать содержимое/credentials; hashId где уместно. A79 не гарантирует чистоту любых stdout/внешних логов.

## Impact-check и обновление

Перед значимой правкой открыть сводку, затронутые TB/допущения/риски; зафиксировать актив, недоверенный ввод, контроль, остаток/проверку. Повторить по diff. Полнота не следует из имени теста или обхода каталога без проверки детектора.

Обновлять текущую запись, не добавлять rollout в начало. SHA/run/digest — датированное свидетельство конкретного события. Перед commit/push сводка/риски/реестр должны согласовываться.

Полный пересмотр: новая граница/сервис, права, hosting, credential/IAM, AI provider/model/location/tools, file origin/type, DB driver/TLS, image gate, публичный доступ/распространяемый артефакт. Подробности — [риски и план](docs/threat-model/risks.md).
