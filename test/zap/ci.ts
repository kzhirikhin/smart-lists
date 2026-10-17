import { execFileSync } from "node:child_process";
import { z } from "zod";
// @ts-expect-error Node 24 исполняет этот модуль без bundler и требует расширение .ts.
import { hash, readPolicy, renderReport, reportSchema } from "./report.ts";
// @ts-expect-error То же ограничение Node 24; общие настройки сборки приложения не меняем.
import { scenarios } from "./manifest.ts";

const sha = z.string().regex(/^(?:[a-f0-9]{40}|unknown)$/);
const status = z.enum(["completed", "incomplete", "error", "skipped"]);
const count = z.number().int().min(0).max(1_000_000);
const paths = ["config/zap/decisions.json", "config/zap/baseline.json"] as const;
const emptyPolicy = { version: 1, decisions: [] };
const reasons = new Set(["empty-selection", "scenario-process-failed", "passive-queue-not-drained", "unmapped-tests", "pilot-time-budget", "host-time-budget", "host-build-or-startup-or-export-failed", "cleanup-failed", "pilot-infrastructure-or-report-error", "invalid-api-response", "api-size-limit", "invalid-message", "invalid-alerts", "invalid-alert", "missing-alert-message", "invalid-policy"]);

export function ciPlan(mode: string | undefined, result: string | undefined) {
  return result !== "success" ? "error" : mode === "docs" ? "skipped" : mode === "full" ? "scan" : "error";
}

/** Только blobs обычных файлов из зафиксированного HEAD отдельного checkout.
 * Symlink/worktree и PR-артефакты не источники доверенной политики. */
export function readTrustedGit(directory: string) {
  const git = (args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", maxBuffer: 16_000_000, stdio: ["ignore", "pipe", "pipe"] });
  const revision = git(["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("invalid-trusted-revision");
  const files: Record<string, string | undefined> = {};
  for (const path of paths) {
    const tree = git(["ls-tree", revision, "--", path]);
    if (!tree) continue;
    if (!/^100644 blob [a-f0-9]{40}\t/.test(tree)) throw new Error("invalid-trusted-file-mode");
    files[path] = git(["show", `${revision}:${path}`]);
  }
  return { revision, files };
}

export function selectTrustedInputs(snapshot: ReturnType<typeof readTrustedGit> | undefined, candidate: Record<string, string | undefined>, now: string) {
  let policy: unknown = emptyPolicy;
  let baseline: unknown;
  let policySource: "default-branch" | "unavailable" = "unavailable";
  let baselineSource: "default-branch" | "unavailable" | "invalid" = "unavailable";
  const policyText = snapshot?.files[paths[0]];
  const baselineText = snapshot?.files[paths[1]];
  try {
    if (policyText !== undefined) {
      policy = JSON.parse(policyText);
      readPolicy(policy, now);
      policySource = "default-branch";
    }
  } catch { policy = emptyPolicy; }
  try {
    if (baselineText !== undefined) {
      baseline = reportSchema.parse(JSON.parse(baselineText));
      if ((baseline as z.infer<typeof reportSchema>).run.status !== "completed") throw new Error();
      baselineSource = "default-branch";
    }
  } catch { baseline = {}; baselineSource = "invalid"; }
  // Без валидной доверенной политики не используем и baseline: иначе первый
  // прогон мог бы выглядеть как trusted known при повреждённом источнике.
  if (policySource !== "default-branch") { policy = emptyPolicy; baseline = undefined; baselineSource = "unavailable"; }
  return {
    policy, baseline,
    trust: {
      revision: snapshot?.revision ?? "unknown", policySource, baselineSource,
      policyChanged: hash(candidate[paths[0]] ?? null) !== hash(policyText ?? null),
      baselineChanged: hash(candidate[paths[1]] ?? null) !== hash(baselineText ?? null),
    },
  };
}

export const stateSchema = z.object({
  version: z.literal(1), plan: z.enum(["scan", "skipped", "error"]),
  scanExit: z.number().int().min(-1).max(255).nullable(),
  startedAt: z.iso.datetime(), revision: sha,
  runId: z.string().regex(/^\d{1,20}$/), attempt: z.string().regex(/^\d{1,5}$/),
  repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  trust: z.object({ revision: sha, policySource: z.enum(["default-branch", "unavailable"]), baselineSource: z.enum(["default-branch", "unavailable", "invalid"]), policyChanged: z.boolean(), baselineChanged: z.boolean() }).strict(),
}).strict();

const diagnosticSchema = z.object({
  status, pending: count.optional(), requests: count.optional(), durationMs: count.optional(),
  passiveWaitMs: count.optional(), passiveDiagnosticsUnavailable: z.boolean().optional(),
  passiveTasks: z.array(z.object({ ruleId: z.string().regex(/^(?:\d{1,6}|unknown)$/), durationMs: count }).strict()).max(100).optional(),
  zapVersion: z.string().regex(/^\d+(?:\.\d+){1,3}$/).optional(),
  zapImage: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  addons: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), version: z.string().regex(/^[a-zA-Z0-9_.-]{1,40}$/) })).max(200).optional(),
  reasons: z.array(z.string().refine((value) => reasons.has(value) || scenarios.some((scenario) => value === `coverage:${scenario.id}`))).max(100).default([]),
  coverage: z.array(z.object({
    id: z.string().refine((id) => scenarios.some((scenario) => scenario.id === id)),
    passed: z.boolean(), complete: z.boolean(), requests: count, contexts: count, actions: count,
    actionNames: z.array(z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/)).max(200),
    authenticated: z.boolean(), spaces: count, secondContext: z.boolean().nullable(), secondAction: z.boolean().nullable(),
  })).max(100).default([]),
});

/** Пересоздаёт публикуемые файлы из проверенных структур. Никакого copy glob
 * из test-results, stdout, trace или HTML, созданного внутри scan job. */
export function ciArtifacts(rawState: unknown, rawDiagnostic?: unknown, rawReport?: unknown) {
  const state = stateSchema.parse(rawState);
  const diagnostic = diagnosticSchema.safeParse(rawDiagnostic);
  const report = reportSchema.safeParse(rawReport);
  let execution: z.infer<typeof status> = state.plan === "skipped" ? "skipped" : "error";
  if (state.plan === "scan" && state.scanExit !== null && diagnostic.success) {
    execution = diagnostic.data.status === "completed" && state.scanExit !== 0 ? "error" : diagnostic.data.status;
    if (execution === "completed" && (!report.success || report.data.run.status !== "completed" || diagnostic.data.pending !== 0 ||
      (state.revision !== "unknown" && report.data.run.revision !== state.revision) ||
      diagnostic.data.coverage.length !== scenarios.length || !scenarios.every((scenario) => diagnostic.data.coverage.filter((entry) => entry.id === scenario.id && entry.complete && entry.passed).length === 1))) execution = "error";
  }
  const details = state.plan === "scan" && diagnostic.success && report.success && report.data.run.status === execution;
  const url = `https://github.com/${state.repository}/actions/runs/${state.runId}/attempts/${state.attempt}`;
  const header = ["# ZAP passive (advisory)", "", `Статус: **${execution}**. Находки и сбои не блокируют gate/deploy.`, "",
    `[Запуск ${state.runId}, попытка ${state.attempt}](${url})`, "", `Проверенный SHA: ${state.revision}; начало UTC: ${state.startedAt}.`, "",
    `Источник политики: ${state.trust.policySource}; baseline: ${state.trust.baselineSource}; trusted SHA: ${state.trust.revision}.`, "",
    `Изменения в проверяемой ветке: policy=${state.trust.policyChanged}, baseline=${state.trust.baselineChanged}. Они не подменяют trusted-входы этого запуска.`, "",
    ...(state.plan === "skipped" ? ["Пропуск: docs-only классификация; E2E и ZAP scan не запускались.", ""] : []),
    ...(state.plan === "error" ? ["Ошибка классификации/подготовки: скан не запускался.", ""] : []),
  ].join("\n");
  const metadata = { ...state, status: execution, url, reportsAvailable: details,
    ...(details ? { scan: report.data.run } : {}),
    ...(diagnostic.success && state.plan === "scan" ? { diagnostic: diagnostic.data } : {}) };
  const files: Record<string, string> = { "run.json": `${JSON.stringify(metadata, null, 2)}\n` };
  if (details) {
    if (execution !== "completed") {
      report.data.comparison = "unavailable";
      for (const finding of report.data.findings) finding.lifecycle = "uncompared";
    }
    const artifacts = renderReport(report.data);
    files["report.json"] = artifacts.json;
    files["report.html"] = artifacts.html;
    files["summary.md"] = header + "\n" + artifacts.summary;
  } else files["summary.md"] = header + "\nДетальный отчёт недоступен. Сравнение недоступно.\n";
  // Job summary ограничен GitHub; полный безопасный Markdown остаётся артефактом.
  files["job-summary.md"] = files["summary.md"].length < 200_000 ? files["summary.md"] : `${header}\nПолная таблица находится в очищенном summary.md артефакта.\nHigh: ${details ? report.data.findings.filter((finding) => finding.risk === "High").length : "unknown"}.\n`;
  return { files, status: execution };
}
