import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const results = path.join(root, "test-results");
const output = path.join(results, "zap-ci");
const command = process.argv[2];
const names = ["report.json", "report.html", "summary.md", "run.json", "job-summary.md"];
const readJson = async (file) => {
  if ((await stat(file)).size > 16_000_000) throw new Error("input-size-limit");
  return JSON.parse(await readFile(file, "utf8"));
};
const readOptional = async (file) => { try { return await readJson(file); } catch { return undefined; } };
const clear = async (directory) => {
  await mkdir(directory, { recursive: true });
  for (const name of [...names, "pilot.json"]) await rm(path.join(directory, name), { force: true });
};

try {
  if (command === "scan") {
    await mkdir(results, { recursive: true });
    await rm(path.join(results, "zap-ci-state.json"), { force: true });
    await clear(output);
    await clear(path.join(results, "zap-ci-run"));
    const { ciPlan, readTrustedGit, selectTrustedInputs, stateSchema } = await import("../../test/zap/ci.ts");
    const probe = process.argv[3];
    if (process.argv.length > 4 || (probe && !/^--probe=(proxy|session|empty|queue|report)$/.test(probe))) throw new Error();
    const startedAt = new Date().toISOString();
    let snapshot;
    // Workflow задаёт соседний checkout default branch. Отсутствие/ошибка не
    // разрешают запасной путь через PR-конфигурацию.
    try { snapshot = readTrustedGit(path.resolve(root, "..", ".zap-trusted")); } catch { /* Явный unavailable. */ }
    const candidate = {};
    for (const file of ["config/zap/decisions.json", "config/zap/baseline.json"]) {
      try { if ((await stat(path.join(root, file))).size <= 16_000_000) candidate[file] = await readFile(path.join(root, file), "utf8"); } catch { /* Только признак изменения. */ }
    }
    const inputs = selectTrustedInputs(snapshot, candidate, startedAt.slice(0, 10));
    const state = stateSchema.parse({ version: 1, plan: ciPlan(process.env.ZAP_CI_MODE, process.env.ZAP_CLASSIFY_RESULT), scanExit: null,
      startedAt, revision: process.env.GITHUB_SHA ?? "unknown", runId: process.env.GITHUB_RUN_ID ?? "0", attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
      repository: process.env.GITHUB_REPOSITORY ?? "local/smart-lists", trust: inputs.trust });
    const statePath = path.join(results, "zap-ci-state.json");
    await writeFile(statePath, JSON.stringify(state));
    if (state.plan !== "scan") { process.exitCode = state.plan === "error" ? 2 : 0; }
    else {
      const inputDirectory = path.join(results, "zap-ci-input");
      await mkdir(inputDirectory, { recursive: true });
      await rm(path.join(inputDirectory, "baseline.json"), { force: true });
      await writeFile(path.join(inputDirectory, "decisions.json"), JSON.stringify(inputs.policy));
      if (inputs.baseline !== undefined) await writeFile(path.join(inputDirectory, "baseline.json"), JSON.stringify(inputs.baseline));
      const exit = await new Promise((resolve) => {
        const child = spawn(process.execPath, ["scripts/zap/run.mjs", "--ci", ...(probe ? [probe] : [])], { cwd: root, stdio: "inherit", timeout: 1_260_000 });
        child.on("error", () => resolve(-1));
        child.on("close", (code) => resolve(code ?? -1));
      });
      state.scanExit = exit;
      await writeFile(statePath, JSON.stringify(state));
      process.exitCode = exit === 0 ? 0 : 2;
    }
  } else if (command === "publish") {
    await clear(output);
    let artifacts;
    try {
      // Если установка зависимостей/схема сломаны, остаётся stdlib-only fallback.
      const { ciArtifacts } = await import("../../test/zap/ci.ts");
      artifacts = ciArtifacts(await readJson(path.join(results, "zap-ci-state.json")),
        await readOptional(path.join(results, "zap-ci-run/pilot.json")), await readOptional(path.join(results, "zap-ci-run/report.json")));
    } catch {
      artifacts = { status: "error", files: {
        "run.json": '{"status":"error","reportsAvailable":false}\n',
        "summary.md": "# ZAP passive (advisory)\n\nСтатус: **error**. Ошибка подготовки или очистки отчёта. Детальный отчёт недоступен. Сравнение недоступно.\n",
      } };
      artifacts.files["job-summary.md"] = artifacts.files["summary.md"];
    }
    for (const [name, content] of Object.entries(artifacts.files)) {
      if (!names.includes(name)) throw new Error();
      await writeFile(path.join(output, name), content);
    }
    console.log(`ZAP CI: ${artifacts.status}; test-results/zap-ci/summary.md`);
  } else if (command === "check") {
    const result = await readJson(path.join(output, "run.json"));
    process.exitCode = ["completed", "skipped"].includes(result.status) ? 0 : 2;
  } else throw new Error();
} catch {
  console.error("ZAP CI: ошибка подготовки/обработки; подробности недоверенного ввода не выводятся.");
  process.exitCode = 2;
}
