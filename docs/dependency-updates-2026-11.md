# Обновления зависимостей — 2026-11-11

Цель: убрать известные advisory совместимыми исправлениями, затем проверить
доступные мажоры. Новые прямые версии закрепляются точно, чтобы повторная
сборка lock не обходила семидневную выдержку. Lock собирается в Linux;
установка без хуков, Prisma Client генерируется явно.

| Этап | Решение | Статус |
|---|---|---|
| 1 | OIDC 4.0.6 + AWS credentials provider 3.3.18: обе цепочки используют cli-config 0.3.6 и исправленный Zod | Обновлено; lint/typecheck/unit/security прошли |
| 2 | fast-uri 3.1.9 через существующий override @3 | Обновлено; advisory устранены |
| 2 | minimatch в typescript-eslint: искать исправление в совместимой цепочке; не подменять @10 на @11 через override | Отложено: upstream требует @10; остаток описан ниже |
| 3 | dotenv 18.0.9: проверить import dotenv/config, приоритет env и prisma generate | Обновлено; entrypoint/env/generate прошли |
| 4 | Framer Motion 14.9.0: проверить Reorder, AnimatePresence, темы и адаптивность существующими E2E | Обновлено; production build и 146 E2E прошли |
| Отложено | ESLint 10: import/react/jsx-a11y не объявляют совместимость; TypeScript 7: typescript-eslint требует <6.1 | Ждать upstream |
| Отложено | Prisma 8: release candidate; @types/node 26: рантайм проекта Node 24 | Не обновлять сейчас |

OIDC проверен отдельно перед следующими этапами; для остальных этапов проверены
фактический diff пакетов, даты и integrity npm-артефактов, затем выполнены
итоговые lint/typecheck/unit и затронутые security-контракты. Итоговая сборка и E2E
используют только локальные тестовые БД и фиктивные сервисные credentials.
Изменения прав, Server Actions и схемы БД не планируются.

## Модель угроз

OIDC затрагивает runtime identity, TB2/TB4 и supply chain: сохраняются WIF,
серверное хранение токенов, существующие IAM audience/role и отсутствие
долгоживущих ключей. OIDC 4 добавляет VERCEL_OIDC_TOKEN_FILE; приложение не
задаёт этот путь из пользовательского ввода. Новый внешний сервис не вводится.
Уязвимый вложенный Zod проверял конфигурацию CLI; путь от HTTP-входа приложения
к уязвимому массиву не найден. Основной Zod приложения уже исправлен (4.6.7).
Это review исходников, не доказательство всех SDK-путей или deployed-состояния.

fast-uri затрагивает транзитивную обработку URI; правила исходящих адресов и
прикладные allowlist сохраняются. minimatch относится к инструментам разработки:
достижимость из production HTTP нельзя выводить только из категории dev.
dotenv затрагивает загрузку credentials: существующие env не должны
перезаписываться .env; generate не должен требовать DIRECT_URL или мигрировать БД.
Motion затрагивает UI/порядок; серверные проверки доступа и noteVersion сохраняются.

Live S3 upload/download/delete проверяется только на Preview; AI WIF требует
отдельной проверки настоящего вызова. Локальные моки этого не подтверждают.


## Остаток minimatch

GHSA-g3hv-75wg-m249 требует optimizationLevel>=2 и исправлена в @11.0.1.
Установленный typescript-eslint 8.71.0 и свежий 8.72.2 требуют minimatch @10;
в просмотренном useProgramFromProjectService.js используется dot:true,
без optimizationLevel>=2. Это ограниченный review, не утверждение о
недостижимости во всех SDK-путях. Исправление — совместимый upstream-релиз,
либо отдельная проверенная замена; межмажорный override не введён.

## Проверки

- Чистый Linux npm ci --ignore-scripts: прошёл; контейнер видел только manifest/lock.
- Windows npm ci --ignore-scripts и явный prisma generate: прошли.
- Все девять изменённых lock-записей старше семи дней; integrity совпадает с registry.
- Lint/typecheck: прошли; unit 840/840, static security 586/586.
- Итоговый npm audit: Critical=0, High=0, Moderate=8; все записи ведут к одной advisory minimatch.
- Production build и 146/146 E2E: прошли, включая перетаскивание, перенос, заметки, темы и адаптивность.
- Снимки status-hierarchy 320px/light и 1280px/dark просмотрены; явных визуальных регрессий нет.
- Обычные интеграции: 320 passed, 15 skipped; отдельный runtime-role gate: 335/335, без skipped.
- Runtime-role gate подтвердил configurator/отказ неожиданных memberships и локальный backup/restore.
- Настоящий prisma generate с пустыми DIRECT_URL/SHADOW_DATABASE_URL: прошёл без подключения к БД.
- Первый role-прогон после обычных интеграций отказал на владельце _prisma_migrations;
  чистый одноразовый postgres-test (tmpfs) устранил конфликт владельцев, проверки не менялись.
- Первый параллельный прогон OIDC превысил 5-секундный timeout в двух тестах;
  последовательный прогон с двумя worker прошёл без изменения проверок и timeout.

## Следующий этап перед публикацией

Владелец 2026-11-11 подтвердил загрузку, открытие/скачивание и удаление
тестового вложения на Preview. Это ручное подтверждение UI-потока с настоящим
S3, не независимая проверка IAM/STS агентом и не свидетельство всех сценариев.
Остаётся подтвердить AI-инсайт через GCP WIF в окружении, где сервис настроен.
Локальные SDK-тесты не подтверждают IAM, STS или конфигурацию платформы.
Изменения отправлены в [черновой PR #266](https://github.com/kzhirikhin/smart-lists/pull/266),
ветка chore/dependency-security-nov-2026. Production не изменён.
Для code commit 2272d1104fdb54738ced9b12ae86432f96de3917 GitHub status Vercel
подтвердил success: deployment 2xiYho9xmufRAN2fXPpXivyWuuRa. Это статус сборки,
не проверка S3/AI.
[Preview](https://smart-lists-git-chore-dependen-c0aa50-kirills-projects-ed9814e1.vercel.app)
защищён Vercel SSO (анонимный запрос /en перенаправляется на SSO).
Браузерные инструменты этой сессии не запускаются: CreateProcessWithLogonW 267.
Это блокирует ручную проверку интерфейса агентом; S3 проверил владелец. Для AI дополнительно
нужно окружение с настроенным INSIGHTS_SERVICE_URL. Проверки CI и актуальный
статус Vercel отслеживаются в PR, успешный build не заменяет live S3/AI.

Источники: [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
[minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249),
[fast-uri 3.1.9](https://github.com/fastify/fast-uri/releases/tag/v3.1.9),
[OIDC changelog](https://github.com/vercel/vercel/blob/main/packages/oidc/CHANGELOG.md),
[dotenv changelog](https://github.com/motdotla/dotenv/blob/master/CHANGELOG.md),
[Motion React upgrade guide](https://motion.dev/docs/react-upgrade-guide).
