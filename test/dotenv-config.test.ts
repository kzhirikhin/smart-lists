/** Проверяет настоящий side-effect entrypoint без чтения рабочего .env. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("dotenv/config загружает .env, сохраняя приоритет окружения процесса", () => {
  const directory = mkdtempSync(join(tmpdir(), "smart-lists-dotenv-"));
  try {
    writeFileSync(join(directory, ".env"),
      'FIXTURE_LOADED="значение с пробелом"\nFIXTURE_PRIORITY=file\n', "utf8");
    const require = createRequire(import.meta.url);
    const entry = pathToFileURL(require.resolve("dotenv/config")).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval",
      "await import(" + JSON.stringify(entry) + "); console.log(JSON.stringify([process.env.FIXTURE_LOADED, process.env.FIXTURE_PRIORITY]));",
    ], {
      cwd: directory,
      encoding: "utf8",
      // Только необходимые переменные ОС и фиктивные значения, без credentials.
      env: { NODE_ENV: "test", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        FIXTURE_PRIORITY: "process", DOTENV_QUIET: "true" },
    });
    expect(JSON.parse(output.trim())).toEqual(["значение с пробелом", "process"]);
  } finally {
    expect(dirname(directory)).toBe(resolve(tmpdir()));
    expect(directory.startsWith(join(tmpdir(), "smart-lists-dotenv-"))).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
