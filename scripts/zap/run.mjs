import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { renderReport, reportSchema } from "../../test/zap/report.ts";
import { activeRunSchema } from "../../test/zap/active-policy.ts";
import { renderManual } from "../../test/zap/manual-report.ts";

// Хост передаёт Docker только имя probe, не собственный .env/ключи/каталог home.
const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const probe = args.find((arg) => arg.startsWith("--probe="))?.slice(8) ?? "none";
const ci = args.includes("--ci");
const manual = args.includes("--manual");
if ((manual && ci) || !args.every((arg) => arg === "--ci" || arg === "--manual" || (manual ? /^--probe=(precondition|session|budget|control)$/ : /^--probe=(proxy|session|empty|queue|report)$/).test(arg))) throw new Error("Недопустимые аргументы пилота");
const project = `smart-lists-zap-${randomBytes(4).toString("hex")}`;
const deadline = Date.now() + (manual ? 3_600_000 : 1_200_000);
let interrupted = false;
let currentDocker;
if (manual) for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  interrupted = true;
  currentDocker?.kill("SIGTERM");
});
const base = ["compose", "--project-directory", root, "--env-file", path.join(root, "docker/zap/empty.env"), "-p", project, "-f", path.join(root, "docker-compose.zap.yml")];
const docker = (tail, quiet = false, cleanup = false) => new Promise((resolve, reject) => {
  if (interrupted && !cleanup) return resolve(1);
  const timeout = cleanup ? 60_000 : Math.max(1, deadline - Date.now());
  const child = spawn("docker", [...base, ...tail], { cwd: root, stdio: quiet ? "ignore" : "inherit", shell: false, timeout });
  currentDocker = child;
  child.on("error", reject);
  child.on("close", (code) => resolve(code ?? 1));
});
const output = ci ? path.join(root, "test-results", "zap-ci-run") : manual && process.env.ZAP_MANUAL_CI === "1" ? path.join(root, "test-results", "zap-manual-ci") : path.join(root, "test-results", manual ? "zap-manual" : "zap-pilot", `${Date.now()}-${probe}`);
await mkdir(output, { recursive: true });
// Повторный локальный ZAP_MANUAL_CI не должен публиковать фазы прошлого run
// после раннего отказа нового. Только точные имена, без рекурсивного удаления.
if (manual) for (const file of ["pilot.json", "run.json", "summary.md", "report.html", "phase-a.json", "phase-a.html", "phase-b-active.json", "phase-b-active.html", "phase-b-passive.json", "phase-b-passive.html"]) await rm(path.join(output, file), { force: true });
let exit = 2;
let safeReport;
let manualData;
const manualReports = {};
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim();
const dirty = Boolean(spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout?.trim());
const safeRevision = /^[a-f0-9]{40}$/.test(revision ?? "") ? revision : "unknown";
try {
  if (await docker(["build", "pilot"]) !== 0) throw new Error("Сборка пилота не завершена");
  if (await docker(["up", "-d", "--wait", "--wait-timeout", "240"]) !== 0) throw new Error("Окружение пилота не готово");
  const container = spawnSync("docker", [...base, "ps", "-q", "pilot"], { encoding: "utf8" }).stdout?.trim();
  if (!/^[a-f0-9]{64}$/.test(container ?? "")) throw new Error("Не найден контейнер пилота");
  const image = spawnSync("docker", ["inspect", "--format", "{{.Image}}", container], { encoding: "utf8" }).stdout?.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image ?? "")) throw new Error("Нет digest образа пилота");
  if (ci && await docker(["cp", path.join(root, "test-results", "zap-ci-input"), "pilot:/tmp/zap-ci-input"], true) !== 0) throw new Error("Нет доверенных входов CI");
  exit = await docker(["exec", "-T", "-e", `ZAP_PILOT_PROBE=${manual ? "none" : probe}`, "-e", `ZAP_MANUAL_PROBE=${probe}`, "-e", `ZAP_PILOT_CONFIG_DIR=${ci ? "/tmp/zap-ci-input" : "config/zap"}`, "-e", `ZAP_PILOT_REVISION=${safeRevision}`, "-e", `ZAP_PILOT_DIRTY=${dirty}`, "-e", `ZAP_PILOT_IMAGE=${image}`, "pilot", "node", manual ? "scripts/zap/manual.mjs" : "scripts/zap/pilot.mjs"]);
  if (await docker(["cp", "pilot:/tmp/zap-output/pilot.json", path.join(output, "pilot.json")], true) !== 0) throw new Error("Нет отчёта пилота");
  const result = JSON.parse(await readFile(path.join(output, "pilot.json"), "utf8"));
  if (manual) {
    // Только фиксированные имена и строгие схемы ДО записи на диск хоста.
    for (const file of ["manual", "phase-a", "phase-b-active", "phase-b-passive"]) {
      const exported = spawnSync("docker", [...base, "exec", "-T", "pilot", "node", "-e", `process.stdout.write(require('fs').readFileSync('/tmp/zap-output/${file}.json'))`], { encoding: "utf8", maxBuffer: 16_000_000, timeout: 10000 });
      if (exported.status !== 0) { if (file === "manual") throw new Error("Нет отчёта"); continue; }
      const raw = JSON.parse(exported.stdout);
      if (file === "manual") manualData = activeRunSchema.parse(raw);
      else manualReports[file] = reportSchema.parse(raw);
    }
    if (manualData.status === "completed" && (!manualReports["phase-a"] || !manualReports["phase-b-active"] || !manualReports["phase-b-passive"])) throw new Error("Нет отчётов фаз");
  }
  if (result.reportReady) {
    // До проверки JSON не записывается на диск хоста и не выводится в консоль.
    const exported = spawnSync("docker", [...base, "exec", "-T", "pilot", "node", "-e", "process.stdout.write(require('fs').readFileSync('/tmp/zap-output/report.json'))"], { encoding: "utf8", maxBuffer: 16_000_000, timeout: 10000 });
    if (exported.status !== 0) throw new Error("Не удалось получить очищенный отчёт");
    safeReport = reportSchema.parse(JSON.parse(exported.stdout));
  }
  console.log(`ZAP: ${result.status}; отчёт: ${path.relative(root, output)}/pilot.json`);
} catch {
  const status = Date.now() >= deadline || interrupted ? "incomplete" : "error";
  const reason = Date.now() >= deadline ? "host-time-budget" : "host-build-or-startup-or-export-failed";
  await writeFile(path.join(output, "pilot.json"), `${JSON.stringify({ schemaVersion: 1, status, probe, revision: safeRevision, dirty, reasons: [reason] }, null, 2)}\n`);
  console.error(`ZAP: ${status}; отчёт: ${path.relative(root, output)}/pilot.json`);
  exit = 2;
} finally {
  // Удаляются только ресурсы случайного project; чужие E2E/dev-контейнеры не затрагиваются.
  const cleaned = await docker(["down", "--volumes", "--remove-orphans"], true, true).catch(() => 1);
  if (cleaned !== 0) {
    const result = JSON.parse(await readFile(path.join(output, "pilot.json"), "utf8"));
    result.status = result.status === "error" ? "error" : "incomplete";
    result.reasons.push("cleanup-failed");
    await writeFile(path.join(output, "pilot.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.error("ZAP: cleanup-failed; проверьте ресурсы project " + project);
    exit = 2;
  }
  const diagnostic = JSON.parse(await readFile(path.join(output, "pilot.json"), "utf8"));
  if (manual) {
    manualData ??= { version: 1, status: "error", phaseA: "error", phaseB: "skipped", reasons: ["active-infrastructure"], control: probe === "control", controlFound: false, requests: 0, rejected: 0, durationMs: 0, targets: [] };
    if (diagnostic.status !== "completed") { manualData.status = diagnostic.status === "error" ? "error" : "incomplete"; if (diagnostic.reasons.includes("cleanup-failed")) manualData.reasons.push("cleanup-failed"); }
    if (interrupted) { manualData.status = "incomplete"; manualData.phaseB = "incomplete"; manualData.reasons = ["active-process-failed", ...(diagnostic.reasons.includes("cleanup-failed") ? ["cleanup-failed"] : [])]; }
    const rendered = renderManual(manualData);
    for (const [name, body] of Object.entries({ "run.json": rendered.json, "summary.md": rendered.summary, "report.html": rendered.html })) await writeFile(path.join(output, name), body);
    for (const [name, report] of Object.entries(manualReports)) {
      const rendered = renderReport(report);
      await writeFile(path.join(output, `${name}.json`), rendered.json);
      await writeFile(path.join(output, `${name}.html`), rendered.html);
    }
    console.log(`Ручной ZAP: ${manualData.status}; ${path.relative(root, output)}/report.html`);
  } else if (safeReport) {
    safeReport.run.status = diagnostic.status;
    if (diagnostic.status !== "completed") {
      safeReport.comparison = "unavailable";
      for (const finding of safeReport.findings) finding.lifecycle = "uncompared";
    }
    const artifacts = renderReport(safeReport);
    await Promise.all([
      writeFile(path.join(output, "report.json"), artifacts.json),
      writeFile(path.join(output, "run.json"), artifacts.run),
      writeFile(path.join(output, "summary.md"), artifacts.summary),
      writeFile(path.join(output, "report.html"), artifacts.html),
    ]);
    console.log(`Очищенный отчёт: ${path.relative(root, output)}/report.html`);
  } else {
    await writeFile(path.join(output, "run.json"), JSON.stringify({ status: diagnostic.status, reportsAvailable: false }));
    await writeFile(path.join(output, "summary.md"), `# ZAP: ${diagnostic.status}\n\nДетальный отчёт недоступен. Сравнение недоступно.\n`);
  }
}
process.exitCode = exit === 0 ? 0 : 2;
