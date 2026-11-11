/**
 * @description Запрещает возврат рассмотренных уязвимых копий, включая вложенные.
 * Это минимальные версии по известным advisory, не поиск новых CVE.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
) as { packages: Record<string, { version?: string }> };

function copies(name: string) {
  return Object.entries(lock.packages).filter(([path]) =>
    path.endsWith("/node_modules/" + name) || path === "node_modules/" + name,
  );
}

function atLeast(version: string | undefined, minimum: number[]) {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const actual = version.split(".").map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}

describe("рассмотренные security-обновления зависимостей", () => {
  it("не возвращает уязвимый Zod через вложенные зависимости OIDC", () => {
    const entries = copies("zod");
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, entry] of entries) {
      expect(atLeast(entry.version, [4, 6, 6]), path).toBe(true);
    }
  });

  it("не возвращает fast-uri до исправления рассмотренных URI advisory", () => {
    const entries = copies("fast-uri");
    expect(entries.length).toBeGreaterThan(0);
    for (const [path, entry] of entries) {
      // Для другого мажора нужен отдельный review диапазона исправленных версий.
      expect(entry.version).toMatch(/^3\./);
      expect(atLeast(entry.version, [3, 1, 9]), path).toBe(true);
    }
  });

  it("сохраняет исправленную цепочку обеих OIDC-интеграций", () => {
    for (const [name, minimum] of [
      ["@vercel/oidc", [4, 0, 6]],
      ["@vercel/cli-config", [0, 3, 6]],
      ["@vercel/oidc-aws-credentials-provider", [3, 3, 18]],
    ] as const) {
      const entries = copies(name);
      expect(entries.length, name).toBeGreaterThan(0);
      for (const [path, entry] of entries) {
        expect(atLeast(entry.version, [...minimum]), path).toBe(true);
      }
    }
  });
});
