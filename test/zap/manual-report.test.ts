import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { renderManual } from "./manual-report";

const run = { version: 1, status: "completed", phaseA: "completed", phaseB: "completed", reasons: [], control: false, controlFound: false, requests: 60, rejected: 0, durationMs: 175_000,
  targets: [["anonymous", "none"], ["owner", "createList"], ["recipient", "addItem"]].map(([role, operation]) => ({ role, operation, requests: 20, mutations: 10, successfulMutations: 3, sessionBefore: true, sessionAfter: true })) };

it("ручной отчёт принимает только закрытые метаданные и разделяет фазы", () => {
  const report = renderManual(run);
  expect(report.summary).toContain("phase-b-active.html");
  expect(report.summary).toContain("phase-b-passive.html");
  expect(report.summary).toContain("не проверяет CORS");
  expect(() => renderManual({ ...run, error: "ZAP_PRIVATE_NOTE" })).toThrow();
  expect(() => renderManual({ ...run, targets: [{ ...run.targets[0], cookie: "private" }] })).toThrow();
  expect(() => renderManual({ ...run, reasons: ["<script>private</script>"] })).toThrow();
  expect(() => renderManual({ ...run, targets: [] })).toThrow();
  expect(() => renderManual({ ...run, requests: 601 })).toThrow();
  expect(() => renderManual({ ...run, phaseA: "incomplete" })).toThrow();
  expect(() => renderManual({ ...run, targets: run.targets.map(target => ({ ...target, mutations: 0 })) })).toThrow();
});

it.each([["--manual", "--target=https://smart-lists-iota.vercel.app"], ["--manual", "--ci"], ["--manual", "--probe=unknown"]])("CLI отказывает запрещённым аргументам до запуска Docker: %s", (...args) => {
  const child = spawnSync(process.execPath, ["scripts/zap/run.mjs", ...args], { encoding: "utf8", timeout: 10_000 });
  expect(child.status).toBe(1);
  expect(child.stderr).toContain("Недопустимые аргументы пилота");
  expect(child.stdout).not.toContain("Building");
});

it("двухфазный workflow запускается ежемесячно/вручную и не получает release-полномочий", () => {
  const yaml = readFileSync(new URL("../../.github/workflows/zap-manual.yml", import.meta.url), "utf8");
  expect(yaml).toContain("workflow_dispatch:");
  expect(yaml).toContain("cron: '17 1 5 * *'");
  expect(yaml).not.toMatch(/^\s*(pull_request|pull_request_target|push):/m);
  expect(yaml).toContain("contents: read");
  expect(yaml).toContain("persist-credentials: false");
  expect(yaml).toContain("ref: ${{ github.sha }}");
  expect(yaml).not.toMatch(/inputs:|inputs\.|REQUESTED_REVISION|steps\.revision/);
  expect(yaml).toContain("package-manager-cache: false");
  expect(yaml).toMatch(/^cache-mode: none$/m);
  expect(yaml).not.toMatch(/^\s*cache(?:-dependency-path)?:/m);
  expect(yaml).not.toMatch(/secrets\.|id-token:|environment:|write/);
  expect(yaml).toContain("continue-on-error: true");
  expect(yaml).toContain("retention-days: 30");
  expect(yaml).not.toMatch(/path:\s*\|\s*test-results\s*$/m);
  const uploads = yaml.slice(yaml.indexOf("          path: |"), yaml.indexOf("      - name: Mark technical outcome"));
  expect(uploads.match(/test-results\/zap-manual-ci\//g)).toHaveLength(9);
  expect(uploads).not.toMatch(/trace|session|HAR|pilot\.json|zap-ci-input|\*/i);
});
