import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { renderReport, reportSchema } from "../../test/zap/report.ts";

// Хост передаёт Docker только имя probe, не собственный .env/ключи/каталог home.
const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const probe = args.find((arg) => arg.startsWith("--probe="))?.slice(8) ?? "none";
const ci = args.includes("--ci");
if (!args.every((arg) => arg === "--ci" || /^--probe=(proxy|session|empty|queue|report)$/.test(arg))) throw new Error("Недопустимые аргументы пилота");
const project = `smart-lists-zap-${randomBytes(4).toString("hex")}`;
const deadline = Date.now() + 1_200_000;
const base = ["compose", "--project-directory", root, "--env-file", path.join(root, "docker/zap/empty.env"), "-p", project, "-f", path.join(root, "docker-compose.zap.yml")];
const docker = (tail, quiet = false, cleanup = false) => new Promise((resolve, reject) => {
  const timeout = cleanup ? 60_000 : Math.max(1, deadline - Date.now());
  const child = spawn("docker", [...base, ...tail], { cwd: root, stdio: quiet ? "ignore" : "inherit", shell: false, timeout });
  child.on("error", reject);
  child.on("close", (code) => resolve(code ?? 1));
});
const output = ci ? path.join(root, "test-results", "zap-ci-run") : path.join(root, "test-results", "zap-pilot", `${Date.now()}-${probe}`);
await mkdir(output, { recursive: true });
let exit = 2;
let safeReport;
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
  exit = await docker(["exec", "-T", "-e", `ZAP_PILOT_PROBE=${probe}`, "-e", `ZAP_PILOT_CONFIG_DIR=${ci ? "/tmp/zap-ci-input" : "config/zap"}`, "-e", `ZAP_PILOT_REVISION=${safeRevision}`, "-e", `ZAP_PILOT_DIRTY=${dirty}`, "-e", `ZAP_PILOT_IMAGE=${image}`, "pilot", "node", "scripts/zap/pilot.mjs"]);
  if (await docker(["cp", "pilot:/tmp/zap-output/pilot.json", path.join(output, "pilot.json")], true) !== 0) throw new Error("Нет отчёта пилота");
  const result = JSON.parse(await readFile(path.join(output, "pilot.json"), "utf8"));
  if (result.reportReady) {
    // До проверки JSON не записывается на диск хоста и не выводится в консоль.
    const exported = spawnSync("docker", [...base, "exec", "-T", "pilot", "node", "-e", "process.stdout.write(require('fs').readFileSync('/tmp/zap-output/report.json'))"], { encoding: "utf8", maxBuffer: 16_000_000, timeout: 10000 });
    if (exported.status !== 0) throw new Error("Не удалось получить очищенный отчёт");
    safeReport = reportSchema.parse(JSON.parse(exported.stdout));
  }
  console.log(`ZAP: ${result.status}; отчёт: ${path.relative(root, output)}/pilot.json`);
} catch {
  const status = Date.now() >= deadline ? "incomplete" : "error";
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
  if (safeReport) {
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
