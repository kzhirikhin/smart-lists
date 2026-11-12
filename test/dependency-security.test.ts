/**
 * @description Запрещает возврат рассмотренных уязвимых копий, включая вложенные.
 * Это минимальные версии по известным advisory, не поиск новых CVE.
 */
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ESLint } from "eslint";
import { describe, expect, it, vi } from "vitest";

const lock = JSON.parse(
  readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
) as { packages: Record<string, { version?: string; dev?: boolean }> };

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

// Разрешаем именно вложенную копию потребителя: корневой minimatch@3 другой.
const require = createRequire(import.meta.url);
const estreeRequire = createRequire(require.resolve("@typescript-eslint/typescript-estree"));
const { Minimatch } = estreeRequire("minimatch") as {
  Minimatch: {
    new (pattern: string, options?: { dot?: boolean; optimizationLevel?: number }): {
      set: unknown[][];
    };
    prototype: {
      firstPhasePreProcess(parts: string[][]): string[][];
      secondPhasePreProcess(parts: string[][]): string[][];
    };
  };
};

describe("границы достижимости GHSA-g3hv-75wg-m249", () => {
  it("сохраняет все уязвимые копии minimatch вне production-графа lock", () => {
    for (const [path, entry] of copies("minimatch")) {
      const major = Number(entry.version?.split(".")[0]);
      if ((major >= 7 && major <= 10) || entry.version === "11.0.0") {
        expect(entry.dev, path).toBe(true);
      }
    }
  });

  it("не включает project service ни для одного текущего TS/TSX файла src", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const files = globSync("src/**/*.{ts,tsx}");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const config = await eslint.calculateConfigForFile(file) as {
        languageOptions?: {
          parserOptions?: { projectService?: unknown; project?: unknown };
        };
      };
      expect(config, file).toBeDefined();
      const options = config.languageOptions?.parserOptions;
      expect(options?.projectService, file).toBeFalsy();
      expect(options?.project, file).toBeFalsy();
    }
  }, 15_000);

  it("опции просмотренного потребителя обходят опасные фазы; уровень 2 их включает", () => {
    const first = vi.spyOn(Minimatch.prototype, "firstPhasePreProcess");
    const second = vi.spyOn(Minimatch.prototype, "secondPhasePreProcess");
    try {
      // Ограниченная проба upstream-паттерна: при уровне 2 всего четыре ветви.
      const pattern = "**/../a/b/**/../c/d";
      const current = new Minimatch(pattern, { dot: true });
      expect(current.set).toHaveLength(1);
      expect(first).not.toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();
      const positiveControl = new Minimatch(pattern, { optimizationLevel: 2 });
      expect(positiveControl.set).toHaveLength(4);
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
    } finally {
      first.mockRestore();
      second.mockRestore();
    }
  });
});
