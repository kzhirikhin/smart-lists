import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ciArtifacts, ciPlan, readTrustedGit, selectTrustedInputs } from "./ci";
import { buildReport, hash, readPolicy, type Run } from "./report";
import { scenarios } from "./manifest";

const now = "2026-10-17";
const policy = { version: 1, decisions: [] };
const run: Run = { status: "completed", startedAt: `${now}T00:00:00.000Z`, revision: "unknown", dirty: true, image: "unknown", scanner: hash("scanner"), scope: hash(scenarios), target: "local-http", formatVersion: 2, normalizationVersion: 1, policyDigest: hash(policy) };
const report = () => buildReport(run, [], readPolicy(policy, now));
const state = () => ({ version: 1, plan: "scan", scanExit: 0, startedAt: run.startedAt, revision: "unknown", runId: "123", attempt: "1", repository: "test/repository", trust: { revision: "unknown", policySource: "unavailable", baselineSource: "unavailable", policyChanged: false, baselineChanged: false } });
const diagnostic = () => ({ status: "completed", pending: 0, requests: 546, coverage: scenarios.map(({ id }) => ({ id, passed: true, complete: true, requests: 1, contexts: 1, actions: 1, actionNames: [], authenticated: true, spaces: 1, secondContext: null, secondAction: null })) });
const snapshot = () => ({ revision: "a".repeat(40), files: { "config/zap/decisions.json": JSON.stringify(policy), "config/zap/baseline.json": JSON.stringify(report()) } });

describe("trusted-конфигурация CI ZAP", () => {
  it("читает Git blob, а не изменённый worktree; отказывает для symlink mode", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "smart-lists-zap-trust-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=.", "-c", "commit.gpgsign=false", "-c", "user.name=ZAPTest", "-c", "user.email=zap@example.test", ...args], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try {
      git("init");
      mkdirSync(path.join(directory, "config/zap"), { recursive: true });
      const policyPath = path.join(directory, "config/zap/decisions.json");
      writeFileSync(policyPath, JSON.stringify(policy));
      git("add", ".");
      git("commit", "-m", "fixture");
      writeFileSync(policyPath, "PRIVATE_WORKTREE_CHANGE");
      expect(readTrustedGit(directory).files["config/zap/decisions.json"]).toBe(JSON.stringify(policy));
      const blob = git("rev-parse", "HEAD:config/zap/decisions.json").trim();
      git("update-index", "--cacheinfo", `120000,${blob},config/zap/decisions.json`);
      git("commit", "-m", "symlink fixture");
      expect(() => readTrustedGit(directory)).toThrow("invalid-trusted-file-mode");
    } finally {
      // Удаляется только созданный этим тестом абсолютный временный каталог.
      expect(path.dirname(directory)).toBe(path.resolve(tmpdir()));
      expect(path.basename(directory)).toMatch(/^smart-lists-zap-trust-/);
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("docs пропускает скан; сломанный/неизвестный классификатор даёт error", () => {
    expect(ciPlan("full", "success")).toBe("scan");
    expect(ciPlan("docs", "success")).toBe("skipped");
    expect(ciPlan("full", "failure")).toBe("error");
    expect(ciPlan("docs", "cancelled")).toBe("error");
    expect(ciPlan(undefined, "success")).toBe("error");
  });
  it("PR policy и baseline не становятся входами даже при пустом default branch", () => {
    const candidate = { "config/zap/decisions.json": JSON.stringify({ version: 1, decisions: ["PRIVATE_PR_POLICY"] }), "config/zap/baseline.json": JSON.stringify(report()) };
    const missing = selectTrustedInputs(undefined, candidate, now);
    expect(missing.policy).toEqual(policy);
    expect(missing.baseline).toBeUndefined();
    expect(missing.trust).toMatchObject({ policySource: "unavailable", baselineSource: "unavailable", policyChanged: true, baselineChanged: true });
    const trusted = selectTrustedInputs(snapshot(), candidate, now);
    expect(trusted.policy).toEqual(policy);
    expect(trusted.baseline).toEqual(report());
    expect(trusted.trust.policyChanged).toBe(true);
    expect(JSON.stringify(trusted)).not.toContain("PRIVATE_PR_POLICY");
  });
  it("не принимает повреждённую политику и incomplete baseline как доверенные", () => {
    const base = snapshot();
    expect(selectTrustedInputs({ ...base, files: { ...base.files, "config/zap/decisions.json": "not-json" } }, {}, now)).toMatchObject({ policy, baseline: undefined, trust: { policySource: "unavailable", baselineSource: "unavailable" } });
    const invalid = selectTrustedInputs({ ...base, files: { ...base.files, "config/zap/baseline.json": JSON.stringify({ ...report(), run: { ...run, status: "incomplete" } }) } }, {}, now);
    expect(invalid.baseline).toEqual({});
    expect(invalid.trust.baselineSource).toBe("invalid");
  });
});

describe("публикация только пересозданных CI-артефактов", () => {
  it("completed требует отчёт, реальную очередь и все ожидаемые сценарии", () => {
    const result = ciArtifacts(state(), diagnostic(), report());
    expect(result.status).toBe("completed");
    expect(result.files["report.html"]).toBeDefined();
    for (const changed of [{ ...diagnostic(), pending: 1 }, { ...diagnostic(), coverage: [] }, { ...diagnostic(), coverage: diagnostic().coverage.map((entry) => ({ ...entry, id: "public-en" })) }]) {
      expect(ciArtifacts(state(), changed, report()).status).toBe("error");
    }
    expect(ciArtifacts({ ...state(), scanExit: 2 }, diagnostic(), report()).status).toBe("error");
  });
  it("не выдаёт High за технический сбой или блокирующий gate", () => {
    const high = { identity: hash("key"), fingerprint: hash("evidence"), rule: "12345", risk: "High", confidence: "High", subject: { route: "/en", method: "GET", persona: "anonymous", representation: "html", operation: "none", query: "none", comparable: false }, parameter: "none", location: "unknown", evidence: { kind: "redacted", value: "evidence-redacted" }, comparable: false, instances: 1, lifecycle: "uncompared", decision: "new" };
    const result = ciArtifacts(state(), diagnostic(), { ...report(), findings: [high] });
    expect(result.status).toBe("completed");
    expect(result.files["job-summary.md"]).toContain("High: 1");
  });
  it("incomplete виден отдельно, сравнение недоступно; skipped игнорирует старые файлы", () => {
    const partial = { ...report(), run: { ...run, status: "incomplete" }, comparison: "available" };
    const result = ciArtifacts({ ...state(), scanExit: 2 }, { ...diagnostic(), status: "incomplete", pending: 1 }, partial);
    expect(result.status).toBe("incomplete");
    expect(result.files["summary.md"]).toContain("Сравнение недоступно");
    const skipped = ciArtifacts({ ...state(), plan: "skipped" }, diagnostic(), report());
    expect(skipped.status).toBe("skipped");
    expect(skipped.files["report.json"]).toBeUndefined();
    expect(skipped.files["summary.md"]).toContain("docs-only");
  });
  it("не экспортирует произвольные diagnostic/error/HTML и повреждённый отчёт", () => {
    const secret = "PRIVATE_CI_MARKER";
    const result = ciArtifacts(state(), { ...diagnostic(), stderr: secret, responseBody: secret }, { ...report(), description: `<img src=${secret}>` });
    expect(result.status).toBe("error");
    expect(result.files["report.json"]).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
    const safe = ciArtifacts(state(), { ...diagnostic(), stderr: secret, responseBody: secret }, report());
    expect(JSON.stringify(safe)).not.toContain(secret);
    const reason = "private-content-from-error";
    const invalidReason = ciArtifacts(state(), { ...diagnostic(), reasons: [reason] }, report());
    expect(invalidReason.status).toBe("error");
    expect(JSON.stringify(invalidReason)).not.toContain(reason);
    expect(() => ciArtifacts({ ...state(), repository: `test/${secret}<script>` }, diagnostic(), report())).toThrow();
  });
});

// Узкий текстовый detector известных YAML-форм, не общий YAML/shell AST.
const workflow = readFileSync(new URL("../../.github/workflows/zap-passive.yml", import.meta.url), "utf8");
const requiredWorkflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const previewWorkflow = readFileSync(new URL("../../.github/workflows/sync-preview.yml", import.meta.url), "utf8");
const jobs = Object.fromEntries([...workflow.matchAll(/^  ([a-z][a-z0-9-]+):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]+:|$(?![\s\S]))/gm)].map((match) => [match[1], match[2]]));
describe("отдельная advisory ZAP job", () => {
  it("gate/release/E2E не зависят от ZAP и не используют его прокси", () => {
    expect(jobs["zap-passive"]).toContain("continue-on-error: true");
    expect(jobs["zap-passive"]).toContain("needs: classify");
    for (const name of ["gate", "production-migration", "e2e"]) {
      expect(requiredWorkflow).toContain(`  ${name}:`);
    }
    expect(requiredWorkflow).not.toContain("zap-passive");
    expect(requiredWorkflow).not.toContain("ZAP_PILOT");
    expect(previewWorkflow).toContain("workflows: ['CI']");
    expect(previewWorkflow).not.toContain("ZAP Passive");
  });
  it("обычный PR без production-секретов/OIDC/write и checkout без сохранения token", () => {
    const job = jobs["zap-passive"];
    expect(job).toContain("contents: read");
    expect(job).not.toMatch(/secrets\.|id-token:|: write|environment:|pull_request_target/);
    expect([...job.matchAll(/persist-credentials: false/g)]).toHaveLength(2);
    expect(job).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(job).toContain("run: npm ci --ignore-scripts");
  });
  it("всегда публикует только точные safe-файлы с retention 30 и ограничивает время", () => {
    const job = jobs["zap-passive"];
    expect(job).toContain("timeout-minutes: 25");
    expect(job).toContain("timeout-minutes: 22");
    expect(job).toContain("retention-days: 30");
    expect(job).toContain("if: ${{ always() }}");
    expect(job).toContain('cat app/test-results/zap-ci/job-summary.md >> "$GITHUB_STEP_SUMMARY"');
    const upload = job.slice(job.indexOf("- name: Upload safe ZAP artifacts"), job.indexOf("- name: Mark technical scan outcome"));
    for (const name of ["run.json", "summary.md", "report.json", "report.html"]) expect(upload).toContain(`app/test-results/zap-ci/${name}`);
    expect(upload).not.toMatch(/zap-ci-run|zap-pilot|trace|\*\*|path: test-results\//);
  });
});
