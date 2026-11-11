/** Проверяет источники OIDC SDK на фиктивных токенах, без обмена с облаком. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getVercelOidcToken } from "@vercel/oidc";

let directory: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (directory) {
    expect(dirname(directory)).toBe(resolve(tmpdir()));
    expect(directory.startsWith(join(tmpdir(), "smart-lists-oidc-"))).toBe(true);
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

// SDK здесь декодирует exp, но подпись проверяет внешний STS. Это не тест WIF.
function token(subject: string) {
  return [
    { alg: "RS256" },
    { sub: subject, exp: Math.floor(Date.now() / 1000) + 3600 },
  ].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".fixture";
}

function fixture() {
  directory = mkdtempSync(join(tmpdir(), "smart-lists-oidc-"));
  const path = join(directory, "token");
  vi.stubEnv("VERCEL_OIDC_TOKEN_FILE", path);
  vi.stubEnv("VERCEL_OIDC_TOKEN", token("fallback"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected-network"); }));
  return path;
}

it("сохраняет источник env без файла токена", async () => {
  const value = token("env");
  vi.stubEnv("VERCEL_OIDC_TOKEN_FILE", "");
  vi.stubEnv("VERCEL_OIDC_TOKEN", value);
  await expect(getVercelOidcToken()).resolves.toBe(value);
});

it("перечитывает файл при ротации и предпочитает его env", async () => {
  const path = fixture();
  const first = token("first");
  writeFileSync(path, first + "\n");
  await expect(getVercelOidcToken()).resolves.toBe(first);
  const rotated = token("rotated");
  writeFileSync(path, rotated);
  await expect(getVercelOidcToken()).resolves.toBe(rotated);
  expect(fetch).not.toHaveBeenCalled();
});

it("пустой файл отклоняет без тихого возврата к env", async () => {
  const path = fixture();
  writeFileSync(path, " \n");
  await expect(getVercelOidcToken()).rejects.toThrow(/empty/i);
  expect(fetch).not.toHaveBeenCalled();
});
