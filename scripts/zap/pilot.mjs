import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { connect } from "node:net";
import { scenarios } from "../../test/zap/manifest.ts";
import { evaluatePilot, summarizeMessage } from "../../test/zap/evaluate.ts";
import { boundedJson, safeSubject, safePassiveTasks, sanitizeAlerts, readPolicy, buildReport, hash } from "../../test/zap/report.ts";

const started = Date.now();
const scanDeadline = started + 600_000;
const probe = process.env.ZAP_PILOT_PROBE ?? "none";
const output = "/tmp/zap-output";
const configDirectory = process.env.ZAP_PILOT_CONFIG_DIR ?? "config/zap";
const report = {
  schemaVersion: 1, manifestVersion: 1, kind: "local-passive-pilot", probe,
  startedAt: new Date(started).toISOString(),
  revision: process.env.ZAP_PILOT_REVISION ?? "unknown",
  dirty: process.env.ZAP_PILOT_DIRTY === "true",
  image: process.env.ZAP_PILOT_IMAGE ?? "unknown",
  zapImage: "sha256:7aaa659b0d43078febd82e29bad112285c370727e86ab8340444220e17d9f0d2",
  status: "error", reasons: [], coverage: [],
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readConfig = async (file) => {
  if ((await stat(file)).size > 16_000_000) throw new Error("config-size-limit");
  return JSON.parse(await readFile(file, "utf8"));
};
const api = async (component, operation, params = {}) => {
  const url = new URL(`http://127.0.0.1:8090/JSON/${component}/view/${operation}/`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  if (Date.now() >= scanDeadline) throw new Error("pilot-time-budget");
  const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, scanDeadline - Date.now()))) });
  if (!response.ok) throw new Error("zap-api-failed");
  return boundedJson(response);
};
const externalBlocked = () => new Promise((resolve) => {
  // IP устраняет ложное доказательство из-за одного лишь отказа DNS.
  const socket = connect({ host: "1.1.1.1", port: 443 });
  socket.setTimeout(1500);
  socket.once("connect", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => { socket.destroy(); resolve(true); });
  socket.once("timeout", () => { socket.destroy(); resolve(true); });
});

try {
  if (!["config/zap", "/tmp/zap-ci-input"].includes(configDirectory)) throw new Error("pilot-environment-refused");
  await mkdir(output, { recursive: true });
  if (process.env.E2E_DATABASE_URL !== "postgresql://postgres:postgres@localhost:5432/smartlists_zap_test" || process.env.ZAP_PILOT !== "1") throw new Error("pilot-environment-refused");
  if (!(await externalBlocked())) throw new Error("egress-probe-failed");
  report.egressProbe = "external-ip-blocked";
  report.phase = "zap-metadata";
  report.zapVersion = (await api("core", "version")).version;
  report.addons = (await api("autoupdate", "installedAddons")).installedAddons.map(({ id, version }) => ({ id, version }));
  // Readiness приложения читает AppSetting. На новой БД схема нужна ещё до
  // старта webServer; штатный globalSetup затем повторно проверяет миграции.
  report.phase = "migrations";
  const migrated = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { stdio: "ignore", timeout: 60_000 });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  if (!migrated) throw new Error("test-migrations-failed");
  const expected = ["proxy", "queue", "report"].includes(probe) ? scenarios.filter((item) => item.id === "public-en") : probe === "session" ? scenarios.filter((item) => item.id === "session") : scenarios;
  const extra = probe === "empty" ? ["--grep", "(?!)"] : probe !== "none" ? ["--grep", expected[0].title] : [];
  report.phase = "scenarios";
  const exit = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.zap.config.ts", ...extra], {
      stdio: ["ignore", "ignore", "ignore"], timeout: 600_000,
      env: { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1" },
    });
    child.on("error", () => resolve(-1));
    child.on("close", resolve);
  });
  const tests = JSON.parse(await readFile("/tmp/zap-tests.json", "utf8"));
  report.phase = "passive-queue";
  let pending = -1;
  const queueStarted = Date.now();
  // На GitHub runner анализ может отстать от браузера. Ожидаем в рамках
  // общего бюджета, оставляя время на безопасный экспорт; очередь не чистим.
  const deadline = Math.min(queueStarted + 180_000, scanDeadline - 30_000);
  // Только после завершения браузеров: новая очередь уже не добавляется.
  do {
    pending = Number((await api("pscan", "recordsToScan")).recordsToScan);
    if (pending === 0) break;
    await sleep(500);
  } while (Date.now() < deadline);
  report.passiveWaitMs = Date.now() - queueStarted;
  if (pending !== 0) {
    try { report.passiveTasks = safePassiveTasks((await api("pscan", "currentTasks")).currentTasks, (await api("pscan", "scanners")).scanners); }
    catch { report.passiveDiagnosticsUnavailable = true; }
  }
  if (probe === "queue") pending = 1; // Явная fault injection, не реальная очередь.
  const count = Number((await api("core", "numberOfMessages")).numberOfMessages);
  if (!Number.isInteger(count) || count > 20_000) throw new Error("traffic-size-limit");
  const traffic = [];
  const subjects = new Map();
  // Читаем лишь node-таблицу export names, ключ шифрования остаётся в контейнере.
  const references = JSON.parse(await readFile(".next/server/server-reference-manifest.json", "utf8")).node;
  const actionNames = Object.fromEntries(Object.entries(references).map(([id, value]) => [id, value.exportedName]));
  report.phase = "traffic";
  for (let start = 0; start < count; start += 50) {
    const messages = (await api("core", "messages", { start, count: 50 })).messages;
    for (const message of messages) {
      const safe = summarizeMessage(message.requestHeader, message.responseHeader, actionNames);
      if (safe) traffic.push(safe);
      subjects.set(String(message.id), safeSubject(message, actionNames, scenarios));
    }
  }
  Object.assign(report, evaluatePilot(expected, tests, traffic, pending, exit === 0), {
    tests, pending, requests: count,
    alerts: (await api("core", "alertsSummary", { baseurl: "http://localhost:3100" })).alertsSummary,
  });
  report.phase = "safe-report";
  const rawAlerts = [];
  for (let start = 0; start < 20000; start += 100) {
    const page = (await api("core", "alerts", { baseurl: "http://localhost:3100", start, count: 100 })).alerts;
    if (!Array.isArray(page)) throw new Error("invalid-alert-page");
    rawAlerts.push(...page);
    if (page.length < 100) break;
    if (start === 19900) throw new Error("alert-count-limit");
  }
  if (probe === "report") rawAlerts.push({ alertRef: "invalid", evidence: "ZAP_PRIVATE_REPORT_PROBE" });
  const findings = sanitizeAlerts(rawAlerts, subjects);
  const policy = readPolicy(await readConfig(`${configDirectory}/decisions.json`), report.startedAt.slice(0, 10));
  let previous;
  try { previous = await readConfig(`${configDirectory}/baseline.json`); } catch (error) { if (error.code !== "ENOENT") previous = {}; }
  const safeReport = buildReport({
    status: report.status, startedAt: report.startedAt, revision: report.revision,
    dirty: report.dirty, image: report.image, target: "local-http",
    scanner: hash([report.zapImage, report.zapVersion, [...report.addons].sort((a, b) => a.id.localeCompare(b.id))]),
    scope: hash(scenarios), formatVersion: 2, normalizationVersion: 1, policyDigest: policy.digest,
  }, findings, policy, previous);
  await writeFile(`${output}/report.json`, JSON.stringify(safeReport));
  report.reportReady = true;
  report.phase = "finished";
} catch (error) {
  // Исключение SDK/API может содержать заголовки/тело; не сериализуем его.
  report.status = Date.now() >= scanDeadline ? "incomplete" : "error";
  const safeReason = ["invalid-api-response", "api-size-limit", "invalid-message", "invalid-alerts", "invalid-alert", "missing-alert-message", "invalid-policy"].includes(error.message) ? error.message : "pilot-infrastructure-or-report-error";
  report.reasons = [Date.now() >= scanDeadline ? "pilot-time-budget" : safeReason];
} finally {
  report.durationMs = Date.now() - started;
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/pilot.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, probe, reasons: report.reasons, durationMs: report.durationMs }));
}
process.exitCode = report.status === "completed" ? 0 : 2;
