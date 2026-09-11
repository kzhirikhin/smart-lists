/**
 * @file secret-registry.test.ts
 * @description Контракт полноты и безопасности реестра секретов.
 *
 * Зачем: список, который ведут руками, разъезжается молча — в этом реестре
 * урок записан дважды (A29, A51). Поэтому набор имён берётся не из массива в
 * тесте, а из источников факта: обращений к `process.env` в коде приложения и
 * ссылок на хранилища секретов в workflow. Новая переменная, не попавшая в
 * `SECRETS.md`, красит прогон.
 *
 * Второй контракт — обратный. Реестр лежит в публичном репозитории и по
 * построению перечисляет всё, что в проекте есть; попадание в него значения
 * или точного идентификатора превращает полезный документ в готовую карту.
 * Ловится это только до слияния: сам по себе такой файл не ломается.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const registry = readFileSync(`${repoRoot}SECRETS.md`, "utf8");

/** Рекурсивный обход: набор файлов не перечисляется руками. */
function collectFiles(dir: string, matches: RegExp): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      // Сгенерированный клиент Prisma — не наш код и читает свои переменные.
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      found.push(...collectFiles(full, matches));
    } else if (matches.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const read = (path: string) => readFileSync(path, "utf8");

/** Имена, которые предоставляет платформа, а не конфигурация проекта. */
const PLATFORM = new Set(["NODE_ENV"]);

const appNames = new Set(
  [
    ...collectFiles(`${repoRoot}src`, /\.tsx?$/).flatMap((file) => [
      ...read(file).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g),
    ]),
    ...[
      ...read(`${repoRoot}prisma.config.ts`).matchAll(
        /process\.env\.([A-Z][A-Z0-9_]*)/g,
      ),
    ],
  ]
    .map((match) => match[1])
    .filter((name) => !PLATFORM.has(name)),
);

const workflowNames = new Set(
  collectFiles(`${repoRoot}.github/workflows`, /\.ya?ml$/)
    .flatMap((file) => [
      ...read(file).matchAll(/(?:secrets|vars)\.([A-Z][A-Z0-9_]*)/g),
    ])
    .map((match) => match[1]),
);

describe("реестр секретов", () => {
  it("видит источники: иначе проверки ниже пройдут впустую", () => {
    expect(appNames.size).toBeGreaterThan(10);
    expect(workflowNames.size).toBeGreaterThan(5);
    // Заведомо известные имена — сторож против вырождения регулярок.
    expect(appNames).toContain("DATABASE_URL");
    expect(workflowNames).toContain("DIRECT_URL");
  });

  it.each([...appNames].sort())(
    "%s из кода приложения описан в SECRETS.md",
    (name) => {
      expect(registry).toContain(name);
    },
  );

  it.each([...workflowNames].sort())(
    "%s из workflow описан в SECRETS.md",
    (name) => {
      expect(registry).toContain(name);
    },
  );

  it.each([
    ["ключ доступа AWS", /\bAKIA[0-9A-Z]{16}\b/],
    ["пароль роли Neon", /\bnpg_[A-Za-z0-9]{8,}\b/],
    ["секрет клиента Google", /\bGOCSPX-[\w-]+/],
    ["номер аккаунта AWS", /\b\d{12}\b/],
    ["хост эндпоинта Neon", /\bep-[a-z]+-[a-z]+-[a-z0-9]+\./],
    ["строка подключения с паролем", /postgresql:\/\/[^\s:]+:[^\s@]+@/],
  ])("не содержит %s", (_label, pattern) => {
    expect(registry).not.toMatch(pattern);
  });

  it("объясняет, чего в нём нет и почему", () => {
    // Без этого абзаца следующий редактор добавит идентификаторы «для удобства».
    expect(registry).toContain("Чего в этом файле нет");
  });
});
