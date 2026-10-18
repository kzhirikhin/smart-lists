import { mkdtemp, writeFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { apiRunSchema, qualifies, scanWorkflow, ledgerTitle, probeTitle, assertArchiveEntries, ledgerSchema, attemptSchema,
  mergeAttempt, readLedger, transition, validateCompletion, maxAgeMs, activeProfile } from "../../test/zap/operations.ts";

// Только доверенный default-branch checkout контроллера. Трафик/код артефакта
// не исполняется; unzip -p читает фиксированные JSON, без извлечения путей.
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const probe = process.env.ZAP_OPERATIONS_PROBE ?? "none";
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token || !["none", "failure", "stale", "recovery"].includes(probe)) throw new Error("operations-invalid-environment");
const base = `https://api.github.com/repos/${repository}`;
const now = Date.now();
const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" };
async function bounded(response, limit) {
  if (!response.ok || !response.body) throw new Error("operations-api");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) { await response.body.cancel().catch(() => {}); throw new Error("operations-size"); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function api(route, method = "GET", body) {
  if (!/^\/(?:actions|issues)(?:\/|\?|$)/.test(route) && route !== "") throw new Error("operations-api-route");
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return JSON.parse((await bounded(response, 4_000_000)).toString("utf8"));
}
const issueSchema = z.object({ number: z.number().int().positive(), title: z.string(), body: z.string().nullable(), state: z.string(),
  user: z.object({ login: z.string(), type: z.string() }), pull_request: z.unknown().optional() });
async function findIssue(title) {
  const matches = [];
  for (let page = 1; page <= 10; page++) {
    const batch = z.array(issueSchema).parse(await api(`/issues?state=all&creator=github-actions%5Bbot%5D&per_page=100&page=${page}`));
    matches.push(...batch.filter(issue => !issue.pull_request && issue.title === title && issue.user.login === "github-actions[bot]" && issue.user.type === "Bot"));
    if (batch.length < 100) {
      if (matches.length > 1) throw new Error("operations-duplicate-ledger");
      return matches[0] ?? null;
    }
  }
  throw new Error("operations-issue-limit");
}
async function archive(run) {
  const data = z.object({ artifacts: z.array(z.object({ id: z.number().int().positive(), name: z.string(), expired: z.boolean(), size_in_bytes: z.number() })) }).parse(await api(`/actions/runs/${run.id}/artifacts?per_page=100`));
  const matches = data.artifacts.filter(item => item.name === `zap-manual-${run.id}-${run.run_attempt}` && !item.expired);
  if (matches.length !== 1 || matches[0].size_in_bytes > 8_000_000) throw new Error("artifact-unavailable");
  const redirect = await fetch(`${base}/actions/artifacts/${matches[0].id}/zip`, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  let response = redirect;
  if (redirect.status === 302) {
    const url = new URL(redirect.headers.get("location") ?? "");
    if (url.protocol !== "https:" || ![".blob.core.windows.net", ".actions.githubusercontent.com"].some(suffix => url.hostname.endsWith(suffix))) throw new Error("artifact-unavailable");
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  }
  const bytes = await bounded(response, 8_000_000);
  const directory = await mkdtemp(path.join(tmpdir(), "zap-operations-"));
  try {
    const zip = path.join(directory, "report.zip");
    await writeFile(zip, bytes);
    const unzip = args => {
      const result = spawnSync("unzip", args, { encoding: "utf8", maxBuffer: 16_000_000, timeout: 10_000 });
      if (result.status !== 0) throw new Error("report-invalid");
      return result.stdout;
    };
    assertArchiveEntries(unzip(["-Z1", zip]));
    const read = name => JSON.parse(unzip(["-p", zip, name]));
    return { run: read("run.json"), phases: ["phase-a", "phase-b-active", "phase-b-passive"].map(name => read(`${name}.json`)) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function inspect(run) {
  let reason = "artifact-unavailable";
  try {
    if (run.conclusion !== "success") throw new Error("run-failed");
    reason = "job-invalid";
    const jobs = z.object({ jobs: z.array(z.unknown()) }).parse(await api(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)).jobs;
    reason = "artifact-unavailable";
    const files = await archive(run);
    reason = "report-invalid";
    return validateCompletion(run, jobs, files.run, files.phases, now);
  } catch (error) {
    const known = ["run-failed", "job-invalid", "report-invalid", "artifact-unavailable"];
    if (error instanceof Error && known.includes(error.message)) reason = error.message;
    return attemptSchema.parse({ runId: run.id, attempt: run.run_attempt, revision: run.head_sha,
      profile: activeProfile,
      completedAt: run.updated_at, result: "failure", reason });
  }
}

try {
  const repo = z.object({ default_branch: z.string(), owner: z.object({ login: z.string().regex(/^[\w-]+$/), type: z.literal("User") }) }).parse(await api(""));
  const workflow = z.object({ id: z.number().int().positive(), path: z.literal(".github/workflows/zap-manual.yml") }).parse(await api(`/actions/workflows/${scanWorkflow}`));
  const realIssue = await findIssue(ledgerTitle);
  let ledger = realIssue ? readLedger(realIssue.body ?? "", repository, false) : ledgerSchema.parse({ version: 1, repository, probe: false, lastSuccess: null, lastAttempt: null });
  const runs = z.object({ workflow_runs: z.array(apiRunSchema) }).parse(await api(`/actions/workflows/${workflow.id}/runs?branch=${encodeURIComponent(repo.default_branch)}&status=completed&per_page=100`));
  const candidates = runs.workflow_runs.filter(run => qualifies(run, repository, repo.default_branch, workflow.id)).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  // workflow_run payload — только указатель. Перечитываем run через REST;
  // событие другого workflow/ветки не может обновить журнал.
  if (process.env.ZAP_SOURCE_RUN_ID) {
    if (!/^\d{1,16}$/.test(process.env.ZAP_SOURCE_RUN_ID)) throw new Error("operations-source-id");
    const source = apiRunSchema.parse(await api(`/actions/runs/${process.env.ZAP_SOURCE_RUN_ID}`));
    if (qualifies(source, repository, repo.default_branch, workflow.id) && !candidates.some(run => run.id === source.id)) candidates.push(source);
  }
  // Bootstrap ищет подтверждённый success среди последних 100 runs. Истёкший
  // artifact сам по себе не доказывает completed; после bootstrap работает журнал.
  let inspections = 0;
  for (const run of candidates) {
    const same = record => record?.runId === run.id && record.attempt === run.run_attempt;
    if (same(ledger.lastSuccess)) continue;
    if (same(ledger.lastAttempt) && !["artifact-unavailable", "job-invalid"].includes(ledger.lastAttempt.reason)) continue;
    if (ledger.lastSuccess && Date.parse(run.updated_at) < Date.parse(ledger.lastSuccess.completedAt)) continue;
    if (inspections++ >= 20) break;
    ledger = mergeAttempt(ledger, await inspect(run));
    if (ledger.lastSuccess && candidates.every(candidate => Date.parse(candidate.updated_at) <= Date.parse(ledger.lastSuccess.completedAt) || candidate.id === run.id)) break;
  }
  let issue = realIssue;
  let previous = realIssue ? readLedger(realIssue.body ?? "", repository, false) : null;
  let effectiveNow = now;
  if (probe !== "none") {
    if (ledger.lastSuccess?.profile !== activeProfile) throw new Error("operations-probe-needs-success");
    issue = await findIssue(probeTitle);
    previous = issue ? readLedger(issue.body ?? "", repository, true) : null;
    ledger = ledgerSchema.parse({ ...ledger, probe: true, lastAttempt: ledger.lastSuccess });
    if (probe === "failure") ledger = mergeAttempt(ledger, { runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      revision: ledger.lastSuccess.revision, profile: activeProfile, completedAt: new Date(now).toISOString(), result: "failure", reason: "probe-failure" });
    if (probe === "stale") effectiveNow = Date.parse(ledger.lastSuccess.completedAt) + maxAgeMs + 1;
  }
  const projected = transition(previous, ledger, issue?.state ?? "", effectiveNow);
  if (!issue) issue = issueSchema.parse(await api("/issues", "POST", { title: probe === "none" ? ledgerTitle : probeTitle,
    body: projected.body, assignees: [repo.owner.login] }));
  else await api(`/issues/${issue.number}`, "PATCH", { body: projected.body });
  if (projected.comment) {
    const mention = projected.state !== "healthy" || previous?.observedState !== "healthy" ? `@${repo.owner.login}\n\n` : "";
    await api(`/issues/${issue.number}/comments`, "POST", { body: `${mention}${probe === "none" ? "Результат проверки ZAP." : "ТЕСТ эксплуатационного сигнала ZAP."}\n\n${projected.body}` });
  }
  if (issue.state !== projected.issueState) await api(`/issues/${issue.number}`, "PATCH", { state: projected.issueState });
  const summary = `${probe === "none" ? "ZAP operations" : "ZAP operations PROBE"}: **${projected.state}**. [Журнал](https://github.com/${repository}/issues/${issue.number}).\n`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(JSON.stringify({ status: projected.state, probe, issue: issue.number, lastSuccessRun: ledger.lastSuccess?.runId ?? null }));
  process.exitCode = projected.state === "healthy" ? 0 : 2;
} catch {
  // Ошибки REST/архива/схемы не выводят произвольный ответ или приватное тело.
  const summary = "ZAP operations: **error**. Журнал не подтверждён/не обновлён. Требуется разбор контроллера.\n";
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  console.error("operations-error"); process.exitCode = 2;
}
