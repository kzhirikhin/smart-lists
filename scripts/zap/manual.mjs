import { spawn } from "node:child_process";
import { readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { activeRunSchema, summarizePassive } from "../../test/zap/active-policy.ts";

const output = "/tmp/zap-output";
const probe = process.env.ZAP_MANUAL_PROBE ?? "none";
const started = Date.now();
let result = { version: 1, status: "error", phaseA: "error", phaseB: "skipped", reasons: ["active-infrastructure"], control: probe === "control", controlFound: false, requests: 0, rejected: 0, durationMs: 0, targets: [] };
let startedB = false;
let passive;
const run = args => new Promise(resolve => {
  const child = spawn(process.execPath, args, { stdio: "ignore", timeout: args[0].includes("pilot") ? 660_000 : 35 * 60_000, env: { ...process.env, CI: "1" } });
  child.on("error", () => resolve(-1)); child.on("close", resolve);
});
try {
  if (!["none", "precondition", "session", "budget", "control"].includes(probe)) throw new Error();
  const phaseAExit = await run(["scripts/zap/pilot.mjs"]);
  const phaseA = JSON.parse(await readFile(`${output}/pilot.json`, "utf8"));
  result.revision = phaseA.revision; result.dirty = phaseA.dirty; result.startedAt = new Date(started).toISOString();
  passive = summarizePassive(phaseA);
  result.phaseA = phaseA.status;
  if (phaseA.reportReady) await copyFile(`${output}/report.json`, `${output}/phase-a.json`);
  if (phaseAExit !== 0 || phaseA.status !== "completed" || probe === "precondition") {
    result.status = phaseA.status === "error" ? "error" : "incomplete";
    result.reasons = ["phase-a-incomplete"];
  } else {
    startedB = true;
    const exit = await run(["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.zap-active.config.ts"]);
    if ((await stat(`${output}/manual.json`)).size > 100_000) throw new Error();
    result = activeRunSchema.parse(JSON.parse(await readFile(`${output}/manual.json`, "utf8")));
    if (exit !== 0 && result.status === "completed") { result.status = "error"; result.phaseB = "error"; result.reasons = ["active-process-failed"]; }
  }
} catch { result.status = "error"; if (startedB) result.phaseB = "error"; result.reasons = ["active-infrastructure"]; }
finally {
  result.durationMs = Date.now() - started;
  if (passive) result.passive = passive;
  result = activeRunSchema.parse(result);
  await writeFile(`${output}/manual.json`, JSON.stringify(result));
  await writeFile(`${output}/pilot.json`, JSON.stringify({ status: result.status, reasons: result.reasons, reportReady: false }));
  console.log(JSON.stringify({ status: result.status, phaseA: result.phaseA, phaseB: result.phaseB, reasons: result.reasons, durationMs: result.durationMs }));
}
process.exitCode = result.status === "completed" ? 0 : 2;
