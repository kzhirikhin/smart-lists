/**
 * @file next-config.test.ts
 * @description Проверка настроек, уменьшающих раскрытие деталей платформы,
 * и состава заголовков безопасности.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { nextConfig } from "../next.config";

/** Возвращает значение заголовка, отдаваемого приложением на все маршруты. */
async function headerValue(key: string): Promise<string | undefined> {
  const rules = await nextConfig.headers!();
  const rule = rules.find((entry) => entry.source === "/:path*");
  return rule?.headers.find((header) => header.key === key)?.value;
}

/** Разбирает CSP на директивы: `{ "base-uri": "'self'" }`. */
async function cspDirectives(): Promise<Record<string, string>> {
  const value = await headerValue("Content-Security-Policy");
  if (!value) return {};
  return Object.fromEntries(
    value.split(";").map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name, values.join(" ")];
    }),
  );
}

describe("nextConfig", () => {
  it("не откатывает Next.js ниже security-релиза и синхронизирует ESLint-конфиг", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      dependencies: { next: string };
      devDependencies: { "eslint-config-next": string };
    };
    const lock = JSON.parse(
      readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
    ) as { packages: Record<string, { version?: string }> };
    const version = manifest.dependencies.next;

    // Точная stable-версия исключает незаметный переход на prerelease.
    // 16.3.8 включает исправление RCE в next/og и последующие security-патчи.
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor, patch] = version.split(".").map(Number);
    expect(
      major > 16 ||
        (major === 16 && (minor > 3 || (minor === 3 && patch >= 8))),
    ).toBe(true);
    expect(manifest.devDependencies["eslint-config-next"]).toBe(version);
    expect(lock.packages["node_modules/next"].version).toBe(version);
    expect(lock.packages["node_modules/eslint-config-next"].version).toBe(version);
  });

  it("не публикует X-Powered-By", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe("Content-Security-Policy", () => {
  it("отдаётся на все маршруты", async () => {
    await expect(headerValue("Content-Security-Policy")).resolves.toBeTruthy();
  });

  it("запрещает подмену <base> и плагины", async () => {
    const directives = await cspDirectives();
    expect(directives["base-uri"]).toBe("'self'");
    expect(directives["object-src"]).toBe("'none'");
  });

  it("запрещает встраивание во фрейм, дублируя X-Frame-Options", async () => {
    const directives = await cspDirectives();
    expect(directives["frame-ancestors"]).toBe("'none'");
    await expect(headerValue("X-Frame-Options")).resolves.toBe("DENY");
  });

  it("разрешает отправку форм только на себя и на Google OAuth", async () => {
    // accounts.google.com обязателен: без JS форма входа уходит POST-ом, и
    // Chrome проверяет form-action на редиректе Auth.js к провайдеру.
    const formAction = (await cspDirectives())["form-action"];
    expect(formAction).toBe("'self' https://accounts.google.com");
  });

  it("не ограничивает ресурсы, которым нужен nonce", async () => {
    // Страховка от преждевременного ужесточения: `default-src` или
    // `script-src` без per-request nonce из `proxy.ts` заблокируют инлайновый
    // bootstrap Next.js и уронят приложение целиком. Ужесточая политику,
    // сначала научите proxy выдавать nonce, потом снимайте эту проверку.
    const directives = await cspDirectives();
    expect(directives).not.toHaveProperty("default-src");
    expect(directives).not.toHaveProperty("script-src");
    expect(directives).not.toHaveProperty("style-src");
    expect(directives).not.toHaveProperty("connect-src");
    expect(directives).not.toHaveProperty("img-src");
  });
});

describe("Strict-Transport-Security", () => {
  // Заголовок стоял в конфиге с самого начала, но до 2026-08-31 не проверялся
  // ничем: его можно было удалить, и security gate остался бы зелёным. Сам
  // редирект HTTP → HTTPS выполняет платформа Vercel и в репозитории его нет,
  // поэтому HSTS — единственная часть этой защиты, которой мы управляем.

  it("отдаётся на все маршруты", async () => {
    await expect(
      headerValue("Strict-Transport-Security"),
    ).resolves.toBeTruthy();
  });

  it("держит окно не меньше года", async () => {
    const value = (await headerValue("Strict-Transport-Security")) ?? "";
    const maxAge = Number(/max-age=(\d+)/.exec(value)?.[1] ?? "0");

    // Год — минимум, с которого HSTS перестаёт быть декоративным: короткое
    // окно истекает между визитами, и первый запрос снова уходит по HTTP.
    expect(maxAge).toBeGreaterThanOrEqual(31536000);
  });

  it("распространяется на поддомены", async () => {
    const value = (await headerValue("Strict-Transport-Security")) ?? "";
    expect(value).toContain("includeSubDomains");
  });
});
