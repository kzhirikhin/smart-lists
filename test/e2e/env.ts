/**
 * @file env.ts
 * @description Единое место с параметрами окружения E2E-прогона.
 *
 * Значения нужны в двух местах сразу: `playwright.config.ts` запускает ими
 * сборку и сервер приложения, а `global-setup.ts` — миграции и очистку базы.
 * Держим их здесь, чтобы конфиг и подготовка базы не разъезжались.
 *
 * Все секреты заведомо фиктивные: E2E не ходит в Google, Pusher, S3 и AI.
 * Сессия подставляется прямо в таблицу `Session`, поэтому OAuth не нужен.
 */

/** Порт приложения под тестом. Нестандартный, чтобы не занимать 3000 у `npm run dev`. */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);

export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

/** База E2E — контейнер `postgres-e2e` из docker-compose.test.yml (порт 5434). */
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5434/smartlists_e2e_test";

/**
 * Окружение приложения под тестом.
 *
 * Next читает корневой `.env` через `@next/env`, но уже заданные переменные
 * процесса не перезаписывает. Поэтому явные значения ниже гарантированно
 * перекрывают dev-подключение из `.env`: E2E не может случайно уехать в
 * dev- или боевую базу и в боевые S3/Pusher.
 */
export const appEnv: Record<string, string> = {
  DATABASE_URL: E2E_DATABASE_URL,
  DIRECT_URL: E2E_DATABASE_URL,

  // Auth.js. Провайдер Google сконфигурирован фиктивно: в E2E он не вызывается,
  // но без переменных модуль конфигурации ругается на этапе сборки.
  AUTH_SECRET: "e2e-auth-secret-not-a-real-one",
  AUTH_URL: E2E_BASE_URL,
  AUTH_TRUST_HOST: "true",
  AUTH_GOOGLE_ID: "e2e-google-client-id",
  AUTH_GOOGLE_SECRET: "e2e-google-client-secret",

  // Pusher. Ключ фиктивный: клиент не подключится, realtime в Тир 1 не
  // проверяется, а отсутствие переменной ломало бы сборку клиентского бандла.
  PUSHER_APP_ID: "e2e-pusher-app",
  PUSHER_SECRET: "e2e-pusher-secret",
  NEXT_PUBLIC_PUSHER_KEY: "e2e-pusher-key",
  NEXT_PUBLIC_PUSHER_CLUSTER: "eu",

  // S3. `@/lib/s3` конструирует клиента прямо на импорте, и без региона
  // AWS SDK бросает «Region is missing» ещё до всякого обращения к сети.
  S3_BUCKET_NAME: "e2e-bucket",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY_ID: "e2e-access-key",
  S3_SECRET_ACCESS_KEY: "e2e-secret-key",

  // AI-сервис намеренно не настроен: без INSIGHTS_SERVICE_URL Action не доходит
  // до сети, а инсайты в Тир 1 не проверяются. Статического секрета сервиса в
  // протоколе нет с 2026-08-09, поэтому подставлять его нечем и незачем.

  // Логи приложения попадают в вывод webServer. Оставляем только ошибки.
  LOG_LEVEL: "error",
};

/**
 * Имя cookie сессии Auth.js v5.
 *
 * Префикс `__Secure-` библиотека добавляет только для https; E2E работает по
 * http на localhost, поэтому имя без префикса. Значение должно совпадать с
 * `sessionToken` строки `Session` в базе.
 */
export const SESSION_COOKIE = "authjs.session-token";

/** Cookie последнего выбранного пространства (`src/lib/spaces.ts`). */
export const LAST_SPACE_COOKIE = "smart-lists-space";

/** Cookie гостевого режима (`src/lib/app-settings.ts`). */
export const GUEST_COOKIE = "guest-mode";
