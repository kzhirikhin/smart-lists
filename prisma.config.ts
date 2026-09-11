import "dotenv/config";

import { defineConfig } from "prisma/config";

/**
 * Prisma CLI выполняет миграции через прямое подключение из DIRECT_URL.
 * Обычный `prisma generate` не подключается к БД и должен работать без этого
 * секрета: production build больше не получает владельческий URL. Команды,
 * которым нужна БД, сами завершатся ошибкой при пустом URL; release workflow
 * дополнительно проверяет DIRECT_URL и точный host до запуска Prisma.
 * Runtime приложения использует пулер из DATABASE_URL через PrismaPg.
 */

/** Хосты, которые считаются заведомо одноразовыми. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Проверяет адрес shadow-базы перед тем, как отдать его Prisma.
 *
 * Зачем именно guard, а не комментарий: `migrate dev` **стирает** указанную
 * базу перед каждым использованием. Опечатка в хосте здесь — это не сломанная
 * команда, а очищенная чужая база, причём тихо и с первого раза. Поэтому
 * принимается только петлевой адрес: shadow-база по смыслу одноразовая и живёт
 * в локальном контейнере из `docker-compose.test.yml`.
 *
 * Совпадение с рабочим адресом запрещено отдельно — это тот же сценарий в
 * самом коротком виде.
 *
 * @param raw    значение `SHADOW_DATABASE_URL`; пустое означает поведение по
 *               умолчанию, когда Prisma создаёт временную базу сама.
 * @param target рабочий адрес, с которым сравнивается shadow.
 */
export function resolveShadowDatabaseUrl(
  raw: string | undefined,
  target: string,
): string | undefined {
  if (!raw) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("SHADOW_DATABASE_URL не является корректным URL");
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `SHADOW_DATABASE_URL должен указывать на локальную базу, получен хост ${parsed.hostname}. ` +
        "Prisma стирает эту базу перед каждым `migrate dev`.",
    );
  }

  if (raw === target) {
    throw new Error(
      "SHADOW_DATABASE_URL совпадает с рабочим адресом: `migrate dev` стёр бы рабочую базу",
    );
  }

  return raw;
}

const directUrl = process.env.DIRECT_URL ?? "";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: directUrl,
    // Задан явно, потому что локальная роль намеренно лишена `CREATEDB`:
    // создать временную базу самостоятельно Prisma не может.
    shadowDatabaseUrl: resolveShadowDatabaseUrl(
      process.env.SHADOW_DATABASE_URL,
      directUrl,
    ),
  },
});
