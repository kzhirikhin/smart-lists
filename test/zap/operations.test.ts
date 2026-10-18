import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { activePolicy, activeRunSchema } from "./active-policy";
import { buildReport, hash, readPolicy } from "./report";
import { activeProfile, apiRunSchema, assertArchiveEntries, safeFiles, attemptSchema, health, ledgerSchema, maxAgeMs, mergeAttempt, qualifies, readLedger,
  renderLedger, transition, validateCompletion } from "./operations";

const now = Date.parse("2026-10-18T03:00:00Z");
const revision = "a".repeat(40);
const repository = "owner/project";
const completed = attemptSchema.parse({ runId: 100, attempt: 1, revision, completedAt: new Date(now - 1000).toISOString(),
  profile: activeProfile, result: "completed", reason: "completed", passiveRequests: 546, activeRequests: 70 });
const empty = () => ledgerSchema.parse({ version: 1, repository, probe: false, lastSuccess: null, lastAttempt: null });
const good = () => mergeAttempt(empty(), completed);
const failure = (overrides = {}) => attemptSchema.parse({ ...completed, runId: 101, completedAt: new Date(now).toISOString(), result: "failure", reason: "run-failed", ...overrides });
const source = apiRunSchema.parse({ id: 100, run_attempt: 1, workflow_id: 10, head_sha: revision, head_branch: "main",
  status: "completed", conclusion: "success", event: "workflow_dispatch", updated_at: new Date(now).toISOString(), head_repository: { full_name: repository } });
const run = activeRunSchema.parse({ version: 1, profile: activePolicy.profile, status: "completed", phaseA: "completed", phaseB: "completed", revision, dirty: false,
  passive: { status: "completed", pending: 0, requests: 546, failedScenarios: [], reasons: [] },
  reasons: [], control: false, controlFound: false, requests: 70, rejected: 0, durationMs: 178000,
  targets: activePolicy.targets.map(({ role, operation }) => ({ role, operation, persisted: true, rendered: true,
    requests: 10, mutations: 6, successfulMutations: 6, sessionBefore: true, sessionAfter: true, seedStatus: 200, seedSuccess: true,
    rules: [{ id: "40012", requests: 2, state: "complete" }, { id: "40018", requests: 7, state: "complete" }] })) });
const names = ["Isolated passive and active phases", "Publish safe phase reports", "Upload safe reports", "Mark technical outcome"];
const jobs = [{ name: "ZAP manual isolated (advisory)", conclusion: "success", steps: names.map(name => ({ name, conclusion: "success", completed_at: completed.completedAt })) }];
const policy = readPolicy({ version: 1, decisions: [] }, "2026-10-18");
const reports = [hash("phase-a"), hash([activePolicy, "active", false]), hash([activePolicy, "passive", false])].map(scope => buildReport({ status: "completed", revision, dirty: false, startedAt: completed.completedAt,
  image: "unknown", scanner: hash("scanner"), scope, target: "local-http", formatVersion: 2, normalizationVersion: 1, policyDigest: policy.digest }, [], policy));

describe("свежесть и журнал", () => {
  it("старый журнал читается без потери даты, но не подтверждает новый профиль", () => {
    const legacy = { ...completed, profile: undefined };
    const ledger = mergeAttempt(empty(), attemptSchema.parse(legacy));
    expect(ledger.lastSuccess?.completedAt).toBe(completed.completedAt);
    expect(health(ledger, now)).toBe("profile-outdated");
    const stored = readLedger(renderLedger(ledger, now).body, repository, false);
    expect(stored.lastSuccess?.profile).toBe("manual-v1");
    expect(transition(stored, stored, "open", now + 1000).comment).toBe(false);
    const recovered = mergeAttempt(stored, { ...completed, runId: 102, completedAt: new Date(now).toISOString() });
    expect(health(recovered, now)).toBe("healthy");
    expect(mergeAttempt(recovered, { ...completed, profile: "manual-v1", runId: 103, completedAt: new Date(now + 1000).toISOString() }).lastSuccess?.runId).toBe(102);
  });
  it("40 дней включительно свежо; следующий момент — stale", () => {
    const ledger = good();
    expect(health(ledger, Date.parse(completed.completedAt) + maxAgeMs)).toBe("healthy");
    expect(health(ledger, Date.parse(completed.completedAt) + maxAgeMs + 1)).toBe("stale");
    expect(health(empty(), now)).toBe("no-success");
    expect(() => health(ledger, now - 100_000)).toThrow();
  });
  it("сбой не обновляет последний полный скан, повторный успех восстанавливает состояние", () => {
    const failed = mergeAttempt(good(), failure());
    expect(failed.lastSuccess).toEqual(completed);
    expect(health(failed, now)).toBe("failure");
    const recovered = mergeAttempt(failed, { ...completed, runId: 102, completedAt: new Date(now + 1000).toISOString() });
    expect(health(recovered, now + 1000)).toBe("healthy");
    expect(recovered.lastSuccess?.runId).toBe(102);
  });
  it("старое workflow_run не откатывает свежий результат; rerun учитывает attempt", () => {
    const ledger = mergeAttempt(good(), { ...completed, runId: 90, attempt: 2, completedAt: new Date(now + 1000).toISOString() });
    expect(mergeAttempt(ledger, completed).lastSuccess?.runId).toBe(90);
    expect(mergeAttempt(ledger, { ...completed, runId: 90, attempt: 3, completedAt: new Date(now + 1000).toISOString() }).lastSuccess?.attempt).toBe(3);
    expect(mergeAttempt(ledger, failure({ completedAt: new Date(now - 10_000).toISOString() })).lastAttempt?.result).toBe("completed");
  });
  it("подтверждение того же attempt снимает временный отказ, не сдвигая дату анализа", () => {
    const provisional = mergeAttempt(empty(), failure({ runId: completed.runId, reason: "artifact-unavailable" }));
    const verified = mergeAttempt(provisional, completed);
    expect(verified.lastAttempt).toEqual(completed);
    expect(verified.lastSuccess?.completedAt).toBe(completed.completedAt);
    expect(health(verified, now)).toBe("healthy");
    const unavailableAgain = mergeAttempt(verified, failure({ runId: completed.runId, reason: "artifact-unavailable", completedAt: new Date(now + 1000).toISOString() }));
    expect(unavailableAgain.lastAttempt).toEqual(completed);
    expect(health(unavailableAgain, now + 1000)).toBe("healthy");
    expect(health(mergeAttempt(verified, failure({ runId: completed.runId, attempt: 2 })), now)).toBe("failure");
  });
  it("журнал сохраняется независимо от срока artifact и не принимает чужой/тестовый/приватный JSON", () => {
    const rendered = renderLedger(good(), now);
    const read = readLedger(rendered.body, repository, false);
    expect(read.lastSuccess).toEqual(completed);
    expect(health(read, now + maxAgeMs + 1)).toBe("stale");
    expect(() => readLedger(rendered.body, "other/project", false)).toThrow();
    expect(() => readLedger(rendered.body, repository, true)).toThrow();
    expect(() => readLedger(rendered.body + rendered.body, repository, false)).toThrow();
    expect(() => ledgerSchema.parse({ ...good(), cookie: "private" })).toThrow();
    expect(() => mergeAttempt(good(), failure({ reason: "probe-failure" }))).toThrow();
  });
  it("ежедневная проверка не повторяет комментарий; stale/reopen/recovery создают сигнал", () => {
    const healthy = readLedger(renderLedger(good(), now).body, repository, false);
    expect(transition(healthy, healthy, "closed", now + 1000).comment).toBe(false);
    const stale = transition(healthy, healthy, "closed", now + maxAgeMs + 1);
    expect(stale.comment).toBe(true);
    expect(stale.issueState).toBe("open");
    const stored = readLedger(stale.body, repository, false);
    expect(transition(stored, stored, "open", now + maxAgeMs + 2000).comment).toBe(false);
    expect(transition(stored, stored, "closed", now + maxAgeMs + 2000).comment).toBe(true);
    const failed = readLedger(renderLedger(mergeAttempt(good(), failure()), now).body, repository, false);
    expect(transition(failed, failed, "open", now + maxAgeMs + 1).comment).toBe(true);
  });
  it("уточнение причины того же отказа не создаёт ещё один комментарий", () => {
    const failed = readLedger(renderLedger(mergeAttempt(good(), failure({ reason: "artifact-unavailable" })), now).body, repository, false);
    const refined = mergeAttempt(failed, failure({ reason: "job-invalid" }));
    expect(transition(failed, refined, "open", now).comment).toBe(false);
  });
});

describe("доверие к завершению скана", () => {
  it("архив допускает только девять точных имён, без дубликатов и обхода пути", () => {
    expect(() => assertArchiveEntries(safeFiles.join("\n") + "\n")).not.toThrow();
    for (const files of [[...safeFiles, "../run.json"], [...safeFiles, "run.json"], safeFiles.slice(1),
      safeFiles.map(name => name === "run.json" ? "/run.json" : name), [...safeFiles, "raw.har"]]) {
      expect(() => assertArchiveEntries(files.join("\n"))).toThrow();
    }
  });
  it("ветка, репозиторий, workflow, event и completed обязательны", () => {
    expect(qualifies(source, repository, "main", 10)).toBe(true);
    for (const changed of [{ head_branch: "preview" }, { head_repository: { full_name: "attacker/fork" } },
      { workflow_id: 11 }, { event: "pull_request" }, { status: "in_progress" }]) {
      expect(qualifies({ ...source, ...changed }, repository, "main", 10)).toBe(false);
    }
  });
  it("только подтверждённые A/B и шаг анализа дают дату последнего успеха", () => {
    expect(validateCompletion(source, jobs, run, reports, now)).toEqual(completed);
    expect(validateCompletion(source, jobs, run, reports, now).completedAt).not.toBe(source.updated_at);
  });
  it.each([
    { status: "incomplete", phaseB: "incomplete" }, { dirty: true }, { control: true }, { revision: "b".repeat(40) },
    { passive: { ...run.passive, pending: 1 } }, { passive: undefined },
    { profile: "manual-v1" }, { profile: undefined }, { targets: run.targets.slice(0, 3) },
    { targets: run.targets.map(target => ({ ...target, persisted: false })) },
    { targets: run.targets.map(target => ({ ...target, rendered: false })) },
    { targets: run.targets.map(target => ({ ...target, successfulMutations: 0 })) },
    { targets: run.targets.map(target => ({ ...target, rules: [{ id: "40012", requests: 2, state: "complete" }] })) },
  ])("зелёная advisory-обёртка не оправдывает неполный отчёт %j", patch => {
    expect(() => validateCompletion(source, jobs, { ...run, ...patch }, reports, now)).toThrow();
  });
  it("отказ/пропуск шага, чужой SHA и одинаковые scope не считаются завершением", () => {
    expect(() => validateCompletion({ ...source, conclusion: "cancelled" }, jobs, run, reports, now)).toThrow();
    expect(() => validateCompletion(source, [], run, reports, now)).toThrow();
    expect(() => validateCompletion(source, [{ ...jobs[0], steps: jobs[0].steps.map(step => ({ ...step, conclusion: "skipped" })) }], run, reports, now)).toThrow();
    expect(() => validateCompletion(source, jobs, run, [reports[0], reports[0], reports[0]], now)).toThrow();
    expect(() => validateCompletion(source, jobs, run, reports.map(report => ({ ...report, run: { ...report.run, scope: hash(report.run.scope) } })), now)).toThrow();
    expect(() => validateCompletion(source, jobs, run, reports.map(report => ({ ...report, run: { ...report.run, revision: "b".repeat(40) } })), now)).toThrow();
  });
});

it("известные YAML-формы отделяют read-only сканер от контроллера Issue", () => {
  const scan = readFileSync(new URL("../../.github/workflows/zap-manual.yml", import.meta.url), "utf8");
  const monitor = readFileSync(new URL("../../.github/workflows/zap-operations.yml", import.meta.url), "utf8");
  expect(scan).toContain("cron: '17 1 5 * *'");
  expect(scan).not.toContain("issues: write");
  expect(monitor).toContain("cron: '43 2 * * *'");
  expect(monitor).toContain('workflows: ["ZAP Manual (advisory)"]');
  expect(monitor).toContain("types: [completed]");
  expect(monitor).toContain("ref: ${{ github.event.repository.default_branch }}");
  expect(monitor).not.toMatch(/ref:.*(?:head_sha|workflow_run\.head_branch)|pull_request_target:|contents: write|id-token:|secrets\./);
  expect(monitor).toContain("issues: write");
  expect(monitor).toContain("actions: read");
  expect(monitor).toContain("cache-mode: none");
  expect(monitor).toContain("cancel-in-progress: false");
  expect(monitor).toContain("npm ci --ignore-scripts");
});
