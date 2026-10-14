# Threat Model — Smart Lists

**Актуальная сводка: 2026-10-14.** STRIDE по потокам/границам, LINDDUN для AI. Аудит этой даты проверяет доказательства документа; полной новой проверки приложения и живой инфраструктуры не проводилось.

## Карта документа

- [Реестр допущений](docs/threat-model/assumptions.md) — 102 стабильных ID, контроль, границы, дата и статус сверки.
- [Риски и план](docs/threat-model/risks.md) — открытые пробелы, принятые риски и условия пересмотра.
- [Отчёт аудита](docs/threat-model/audit-2026-10-14.md) — источники, воспроизведённые пропуски и ограничения.
- [Исторический снимок](docs/threat-model/archive-2026-10-14.md) — прежние rollout/digest; содержит устаревшие/опровергнутые утверждения, не источник текущих гарантий.

Связанные источники: [память проекта](PROJECT_MEMORY.md), [DB security](DATABASE_SECURITY.md), [секреты и доступ](SECRETS.md). Источники истины — исходники, schema, миграции и конфигурация обоих репозиториев.

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
| TB8 | backup workflow → S3 | OIDC/ограниченная роль; external trust/bucket policy unknown |
| TB9 | main CI → preview → Vercel | защищённый workflow синхронизирует проверенный SHA; branch/rulesets unknown |
| TB10 | workflow → Neon enforcement | target guards, Environment, catalog contract, locks, транзакционный apply; среды отдельно |
| TB11 | scanner → metadata / Registry | traffic/tagged revisions, offline evidence; read-only IAM отдельная live-проверка |
| TB12 | deploy → Registry → Cloud Run | exact digest/SBOM/attestation до защищённого deploy; ручной путь не запрещён Binary Authorization |

SDK выполняют дополнительные запросы (БД, S3, Pusher, JWKS, ADC); DFD и egress-тесты не полная опись сетевых соединений.

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
