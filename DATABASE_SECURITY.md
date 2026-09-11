# Безопасность PostgreSQL

**Состояние:** runtime least privilege и tenant-RLS включены в Preview и
Production для всех tenant-таблиц. Снимок актуален на 2026-08-28.

Документ фиксирует действующие DB-инварианты, специальные потоки, условия
изменения схемы и аварийный откат. История поэтапного rollout хранится в Git и
в актуальных статусах `THREAT_MODEL.md`; этот файл не является журналом работ.

## Границы контроля

PostgreSQL — второй слой рядом с обязательными прикладными проверками:

- `auth()` подтверждает серверную сессию;
- Zod валидирует недоверенные данные;
- `listInSpaceWhere`, `canAccessListInSpace` и владельческие фильтры задают
  прикладную матрицу доступа;
- transaction-local `app.user_id` и `app.space_id` ограничивают tenant-запросы;
- RLS и column guards не дают пропущенному Prisma-фильтру раскрыть или перенести
  строки другого пользователя/пространства.

Runtime credential способен самостоятельно установить custom GUC. Поэтому RLS
закрывает ошибки приложения, но не считается защитой от полного RCE Next.js или
кражи строки подключения. Прикладные проверки нельзя удалять после появления
policy.

## Роли

| Роль | Где доступна | Контракт |
|---|---|---|
| `smartlists_owner` | `NOLOGIN` | Владелец прикладной схемы, таблиц, типов, routines и policy |
| `smartlists_migrator` | GitHub release workflow | Прямое подключение, применение миграций через owner; без runtime-доступа |
| `smartlists_runtime` | Vercel runtime | Минимальные DML/EXECUTE, без DDL, ownership, membership и `BYPASSRLS` |
| `smartlists_backup` | Production backup workflow | Read-only полный dump с `BYPASSRLS`, без write, DDL и membership |

`neondb_owner` остаётся операторской break-glass ролью Neon. Её credential не
должен находиться в Vercel, GitHub Actions или локальном `.env`. `DIRECT_URL`
доступен только защищённым migration/audit операциям соответствующего GitHub
Environment; обычные CI jobs и работающий Next.js его не получают.

Локальная разработка использует те же роли, что и Preview с Production:
`smartlists_runtime` в `DATABASE_URL` и `smartlists_migrator` в `DIRECT_URL`.
Это не только убирает владельческий credential с рабочей машины: под
`neondb_owner` действовал `BYPASSRLS`, поэтому весь RLS-контур локально молча не
применялся и расхождение с боевым поведением нельзя было заметить. Следствие для
инструментов: у migrator нет `CREATEDB`, а `prisma migrate dev` создаёт shadow-базу,
поэтому её адрес задаётся явно через `SHADOW_DATABASE_URL` и указывает на
одноразовый контейнер из `docker-compose.test.yml`. Guard в `prisma.config.ts`
принимает только петлевой адрес: Prisma стирает эту базу перед каждым запуском.

Пароли ролей создаются вне репозитория, но **секретными не остаются**: у проекта
`store_passwords: true`, и 2026-09-03 проверено, что control plane выдаёт рабочие
пароли даже для ролей, заведённых SQL в обход консоли. Поэтому разделение
привилегий здесь опирается на права ролей внутри БД, а не на то, что их пароли
кому-то неизвестны. Доступ к Neon Console или API эквивалентен компрометации БД —
см. A43 и A44 в `THREAT_MODEL.md`.

## Tenant-контекст

`src/lib/scoped-db.ts` предоставляет два входа:

- `withUserDb(userId, callback)` устанавливает `app.user_id` и очищает
  `app.space_id`;
- `withSpaceDb(userId, spaceId, callback)` внутри той же транзакции сначала
  подтверждает `Space(id, userId)`, затем устанавливает оба значения.

Оба идентификатора валидируются до SQL и передаются параметризованно. Callback
получает только `Prisma.TransactionClient`, чтобы запрос не вышел из
транзакционного контекста. Отсутствующий, пустой или чужой контекст должен
давать zero rows/denied write, а не глобальный доступ. Тесты обязаны проверять
rollback и повторное использование соединения пула.

## RLS-контур

RLS и update column guards включены в Preview и Production для восьми
tenant-таблиц:

| Таблица | Основная принадлежность |
|---|---|
| `Space` | `userId` |
| `List` | владелец либо доступ через `ListShare` внутри пространства |
| `Item` | доступ к родительскому `List` |
| `ListGroup` | `userId + spaceId` |
| `_ListGroupMembers` | группа пользователя и доступный список того же пространства |
| `ListShare` | владелец списка либо получатель share в допустимом потоке |
| `Attachment` | доступ к списку, uploader и допустимый status lifecycle |
| `UserDailyUsage` | `userId` |

Общая `app_list_access(text)` вычисляет доступ к списку. Policy, helper-routines
и guards имеют фиксированный `search_path`, закрыты от `PUBLIC` и выдаются
runtime точечно. `FORCE ROW LEVEL SECURITY` не используется: owner нужен для
миграций, audit и контролируемого отката; runtime не владеет таблицами и потому
RLS не обходит.

Auth/config таблицы (`User`, `Account`, `Session`, `AllowedEmail`,
`AppSetting`) живут в отдельном ACL-контуре. Auth.js Adapter обращается к ним до
появления tenant-контекста. `VerificationToken` не используется настроенными
provider. Audit trail имеет отдельные append-only и owner-only retention
ограничения, описанные в `THREAT_MODEL.md`.

## Специальные потоки

### Sharing

Получатель share не обязан заранее иметь `Space` с клиентским идентификатором.
Server Action разрешает только серверно найденное default-space получателя и
атомарно создаёт placement. Клиентские `userId`, роли и `spaceId` не являются
доказательством доступа. Owner/editor/stranger и cross-space сценарии должны
оставаться в интеграционных тестах.

### Вложения

Обычный upload сохраняет двухфазный поток `PENDING -> S3 -> HeadObject ->
UPLOADED`. Глобальная user quota и очистка stale `PENDING` пересекают
пространства, поэтому используют ограниченные maintenance helpers вместо
ослабления обычных policy. Helpers принимают минимальный набор параметров,
выдают одноразовые cleanup tokens и сохраняют идемпотентный повтор после сбоя
S3/finalize. Backup не получает `EXECUTE` этих routines.

### Realtime и внешние вызовы

Pusher, S3, AI и другие сетевые вызовы не удерживают scoped DB-транзакцию.
Realtime recipients и необходимые S3 keys собираются внутри транзакции, а
`after()` и fail-soft cleanup выполняются после commit. Сетевой сбой не должен
откатывать завершённую DB-мутацию.

### Квоты

`UserDailyUsage` всегда изменяется через `withUserDb`. Резервирование AI-квоты
заканчивается до token exchange/fetch. Компенсация превышения и cleanup не
объединяются с пользовательской мутацией, если их отказ по контракту не должен
отменять уже выполненное действие.

## Release и аудит

- Vercel выполняет только `npm run build`; миграционных credentials в build нет.
- Production migration запускается из `ci.yml` только для успешного push в
  `main`, после обязательных CI gates и при `ENABLE_PRODUCTION_MIGRATION=true`.
- Preview migration выполняется `sync-preview.yml` до push проверенного SHA в
  постоянную ветку `preview` и только при `ENABLE_PREVIEW_MIGRATION=true`.
- Перед каждой live-операцией `verify-release-database.mjs` сравнивает exact
  direct hostname и запрещает ошибочный target/pooler.
- `audit-database.yml` использует выбранный Environment, `BEGIN READ ONLY` и
  проверяет полный catalog/role contract без чтения строк приложения.
- `configure-*-rls.yml` принимает только именованные переходы между известными
  профилями, работает из `main` и делит concurrency lock с миграциями.
- Production backup выполняет проверяемый `pg_dump`, проверяет архив через
  `pg_restore --list` и загружает его в приватный S3 через OIDC.

Сбой exact-host, неожиданный объект/owner/ACL, частичный RLS-профиль или
несовпадение routine/policy predicate должен прекращать операцию до commit.

## Изменение модели данных

Любая новая или изменённая таблица, relation, type, sequence, view, routine,
policy либо raw SQL требует одновременной проверки:

1. Нужен ли объект runtime и какие минимальные DML/EXECUTE права ему требуются.
2. Является ли объект tenant-данными и какой user/space контекст его ограничивает.
3. Нужны ли RLS policy и immutable column guard.
4. Не расширяет ли relation/nested write существующую матрицу owner/editor.
5. Видит ли объект migrator, backup и catalog audit в ожидаемом объёме.
6. Совместима ли миграция со старой и новой версией приложения.
7. Покрыты ли прямой runtime-запрос, Alice/Bob, пустой контекст, rollback и pool
   reuse реальными PostgreSQL-тестами.
8. Обновлены ли `scripts/database-role-contract.mjs`, configurators, миграции,
   integration tests, `PROJECT_MEMORY.md` и `THREAT_MODEL.md`.

Новый объект намеренно должен ломать fail-closed configurator/audit до явного
решения, а не получать default privileges автоматически.

## Аварийный откат

1. Сначала блокируется затронутый пользовательский поток.
2. Проверенная migrator-роль применяет именованный rollback профиля либо
   `NO FORCE/DISABLE ROW LEVEL SECURITY` только для затронутой группы таблиц.
3. Policy, guards и helpers не удаляются до анализа инцидента.
4. Приложение продолжает опираться на `listInSpaceWhere`, ownership и Zod,
   поэтому отключение второго слоя не означает открытый UI-доступ.
5. Runtime credential, версия приложения и схема откатываются независимо.
6. Использование break-glass owner фиксируется, credential после инцидента
   ротируется, а catalog audit подтверждает фактическое состояние.

Полное отключение RLS допустимо только при широком production-отказе, а не как
обычный способ исправления одной policy.

## Источники истины

При расхождении документа с реализацией приоритет имеют:

1. `prisma/schema.prisma` и новые миграции;
2. `scripts/database-role-contract.mjs` и DB configurators;
3. `src/lib/scoped-db.ts` и актуальные Prisma-запросы;
4. `test/integration/rls-policies.int.test.ts`, privilege/scoped-context тесты;
5. live read-only catalog audit выбранной среды.

Сводный security status, допущения и принятые риски находятся только в
`THREAT_MODEL.md`.
