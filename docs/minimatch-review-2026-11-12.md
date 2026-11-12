# Достижимость minimatch GHSA-g3hv-75wg-m249

Проверено 2026-11-12 по текущему package-lock, установленным пакетам и
эффективной конфигурации ESLint. Это анализ конкретной advisory, не полный
аудит minimatch и не разрешение подавлять новые CVE.

## Вывод

Путь эксплуатации CVE-2026-118764 из пользовательского HTTP-ввода не найден.
Уязвимая minimatch 10.2.6 присутствует только в dev-цепочке:
`eslint-config-next 16.4.5 → typescript-eslint 8.71.0 → typescript-estree 8.71.0`.
Корневая minimatch 3.1.4 — другой мажор, вне диапазона этой advisory.
Пакет 10.2.6 остаётся уязвимым: alert открыт, override на мажор 11 не введён.

## Условия и проверенный путь

[Upstream advisory](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)
описывает разрастание globParts в firstPhasePreProcess и последующую
квадратичную обработку secondPhasePreProcess при optimizationLevel >= 2.
В 10.2.6 значение по умолчанию — 1; обе фазы находятся под условием >= 2.

В установленном typescript-estree найден один импорт minimatch и вызов
в `dist/useProgramFromProjectService.js`, функция filePathMatchedBy:
`minimatch(filePath, pattern, { dot: true })`. Pattern приходит из
`serviceAndSettings.allowDefaultProject`, то есть parserOptions конфигурации
ESLint, а не из имён задач, заметок, AI-ответов или HTTP-параметров.
Участник PR может менять код/файлы, но для этой advisory ему ещё нужны
включённый project service, allowDefaultProject и опасный optimizationLevel.
Это не оценка общего риска исполнения недоверенного PR-кода на CI runner.

Проверены eslint.config.mjs, конфигурации eslint-config-next, создание project
service и получение matcher-паттернов в установленном TypeScript ESLint.
Текстовый поиск в src/scripts/test не нашёл прикладного minimatch или
optimizationLevel. Такой поиск не распознаёт произвольные dynamic imports,
алиасы и будущий код; полнота всех возможных JS-путей не заявляется.

## Воспроизводимые проверки

В `test/dependency-security.test.ts` (unit и static-security gate):

- Фактические lock-копии minimatch из диапазона advisory имеют dev=true.
- Для каждого текущего TS/TSX-файла src настоящий ESLint.calculateConfigForFile
  не включает parserOptions.projectService/project. Набор файлов берётся из src.
- Ограниченный upstream-паттерн `**/../a/b/**/../c/d` при `{ dot: true }`
  даёт одну ветвь и не вызывает обе опасные фазы. Положительный контроль
  с optimizationLevel=2 вызывает обе фазы и даёт четыре ветви. Нагрузочная
  атака и проверка против production не выполнялись.

Последняя проба использует опции просмотренного вызова, а не перехватывает
все будущие вызовы потребителя. Сохранение этих опций после upstream-обновления
требует review; тест не доказывает автоматическую полноту call graph.
Конфигурационный тест охватывает текущие src TS/TSX, не все файлы/config/env
другого окружения. Новые JS-входы и изменение parser options требуют пересмотра.

Дополнительно выполнен чистый Linux `npm ci --omit=dev --ignore-scripts`
в node:24. Контейнеру переданы только package.json и package-lock.json,
без исходников, .env и credentials. Установлено 435 пакетов; каталогов
minimatch и typescript-estree нет. Это проверка prod-only установки,
а не инвентаризация всех файлов Vercel-артефакта, который может собираться
с devDependencies.

Lint/typecheck, 843 unit и 589 static-security проверок прошли.
В runtime/UI поведение не меняется; проверять OAuth, S3, Pusher или AI
этими пробами нельзя. Advisory не подавляется и не помечается исправленной.

## Триггеры пересмотра

Новая версия ESLint/Next/TypeScript ESLint/minimatch; включение project service
или allowDefaultProject; появление minimatch в прикладном коде/prod-графе;
передача недоверенного glob; изменение optimizationLevel, build/lint pipeline
или deploy packaging; обновление advisory. Совместимое исправление upstream
по-прежнему предпочтительнее исключения.
