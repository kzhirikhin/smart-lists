/**
 * @file vercel-build-cutover.test.ts
 * @description Контракт отделения Vercel build от миграционного credential.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const readRepoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const packageJson = JSON.parse(readRepoFile("package.json")) as {
  scripts: Record<string, string>;
};
const vercel = JSON.parse(readRepoFile("vercel.json")) as {
  buildCommand: string;
  installCommand: string;
};
const prismaConfig = readRepoFile("prisma.config.ts");

describe("Vercel build cutover", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    vi.doUnmock("dotenv/config");
    vi.resetModules();
    process.env = { ...savedEnv };
  });

  it("собирает приложение без запуска миграций", () => {
    // `prisma generate` вызывается явно, потому что установка идёт с
    // `--ignore-scripts` и штатный `postinstall` не срабатывает (A51).
    // Генерация к БД не подключается — в отличие от `migrate deploy`,
    // который остаётся только в release-job с DIRECT_URL.
    expect(vercel.buildCommand).toBe("npx prisma generate && npm run build");
    expect(vercel.buildCommand).not.toContain("migrate");
    expect(packageJson.scripts["build:deploy"]).toBeUndefined();
    expect(packageJson.scripts["migrate:deploy"]).toBe(
      "prisma migrate deploy",
    );
  });

  it("позволяет prisma generate загрузить config без DIRECT_URL", async () => {
    // Форма проверяется только там, где она и есть отказ: `env("DIRECT_URL")`
    // заставил бы Prisma требовать переменную на уровне схемы.
    expect(prismaConfig).not.toContain('env("DIRECT_URL")');

    // Остальное проверяется загрузкой, а не поиском подстроки: важно, что
    // config импортируется без переменных и не бросает, а каким выражением это
    // достигнуто — деталь реализации. Прежняя проверка ломалась от
    // переименования и при этом ничего не доказывала о поведении.
    vi.resetModules();
    // `.env` рабочей машины не должен подменять условия: без мока dotenv
    // вернул бы удалённые переменные обратно, и тест проверял бы не тот случай.
    vi.doMock("dotenv/config", () => ({}));
    delete process.env.DIRECT_URL;
    delete process.env.SHADOW_DATABASE_URL;

    const config = (await import("../prisma.config")).default;

    expect(config.datasource?.url).toBe("");
    // Без адреса shadow-база остаётся поведением Prisma по умолчанию: сборке
    // она не нужна вовсе, а guard не должен превращать её отсутствие в отказ.
    expect(config.datasource?.shadowDatabaseUrl).toBeUndefined();
  });
});
