import { z } from "zod";
// Node 24 запускает контроллер напрямую с type stripping, без TS loader.
// @ts-expect-error Явный .ts нужен Node; проектный tsc работает с bundler resolution.
import { activeRunSchema } from "./active-policy.ts";
// @ts-expect-error Тот же прямой Node entrypoint, без изменения tsconfig приложения.
import { reportSchema } from "./report.ts";

export const scanWorkflow = "zap-manual.yml";
export const scanWorkflowName = "ZAP Manual (advisory)";
export const scanCron = "17 1 5 * *";
export const monitorCron = "43 2 * * *";
export const maxAgeMs = 40 * 86_400_000;
export const ledgerTitle = "[ZAP] Состояние периодического скана";
export const probeTitle = "[ZAP] Проверка эксплуатационных сигналов (тест)";
export const safeFiles = ["run.json", "summary.md", "report.html", "phase-a.json", "phase-a.html", "phase-b-active.json", "phase-b-active.html", "phase-b-passive.json", "phase-b-passive.html"].sort();
export function assertArchiveEntries(raw: string) {
  if (raw.length > 10_000 || JSON.stringify(raw.trim().split("\n").sort()) !== JSON.stringify(safeFiles)) throw new Error("report-invalid");
}
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const time = z.iso.datetime();
export const attemptSchema = z.object({
  runId: integer, attempt: integer, revision: z.string().regex(/^[a-f0-9]{40}$/), completedAt: time,
  result: z.enum(["completed", "failure"]),
  reason: z.enum(["completed", "run-failed", "job-invalid", "artifact-unavailable", "report-invalid", "probe-failure"]),
  passiveRequests: z.number().int().min(0).max(4_000_000).optional(),
  activeRequests: z.number().int().min(1).max(600).optional(),
}).strict().superRefine((record, context) => {
  if ((record.result === "completed") !== (record.reason === "completed") ||
    (record.result === "completed" && (record.passiveRequests === undefined || record.activeRequests === undefined))) {
    context.addIssue({ code: "custom", message: "invalid-completion" });
  }
});
export type Attempt = z.infer<typeof attemptSchema>;
export const ledgerSchema = z.object({
  version: z.literal(1), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), probe: z.boolean(),
  observedState: z.enum(["healthy", "failure", "stale", "no-success"]).default("no-success"),
  lastSuccess: attemptSchema.nullable(), lastAttempt: attemptSchema.nullable(),
}).strict().superRefine((ledger, context) => {
  if (ledger.lastSuccess && ledger.lastSuccess.result !== "completed") context.addIssue({ code: "custom", message: "invalid-success" });
  if (!ledger.probe && [ledger.lastSuccess, ledger.lastAttempt].some(record => record?.reason === "probe-failure")) context.addIssue({ code: "custom", message: "probe-in-real-ledger" });
});
export type Ledger = z.infer<typeof ledgerSchema>;

/** События workflow_run могут прийти не по порядку; rerun имеет прежний ID,
 * поэтому сравниваем время реального завершения и attempt, а не только ID. */
export function mergeAttempt(ledger: Ledger, input: Attempt): Ledger {
  const record = attemptSchema.parse(input);
  const newer = (previous: Attempt | null) => !previous || Date.parse(record.completedAt) > Date.parse(previous.completedAt) ||
    (record.completedAt === previous.completedAt && (record.runId > previous.runId || (record.runId === previous.runId && record.attempt >= previous.attempt)));
  return ledgerSchema.parse({ ...ledger,
    lastAttempt: newer(ledger.lastAttempt) ? record : ledger.lastAttempt,
    lastSuccess: record.result === "completed" && newer(ledger.lastSuccess) ? record : ledger.lastSuccess,
  });
}

export function health(ledger: Ledger, now: number) {
  if (!Number.isFinite(now)) throw new Error("operations-invalid-time");
  if (!ledger.lastSuccess) return "no-success" as const;
  const age = now - Date.parse(ledger.lastSuccess.completedAt);
  if (age < -60_000) throw new Error("operations-future-success");
  if (age > maxAgeMs) return "stale" as const;
  if (ledger.lastAttempt?.result === "failure" && Date.parse(ledger.lastAttempt.completedAt) >= Date.parse(ledger.lastSuccess.completedAt)) return "failure" as const;
  return "healthy" as const;
}

export const apiRunSchema = z.object({
  id: integer, run_attempt: integer, workflow_id: integer,
  head_sha: z.string().regex(/^[a-f0-9]{40}$/), head_branch: z.string().nullable(),
  status: z.string(), conclusion: z.string().nullable(), event: z.string(), updated_at: time,
  head_repository: z.object({ full_name: z.string() }).nullable(),
});
export type ApiRun = z.infer<typeof apiRunSchema>;
export function qualifies(run: ApiRun, repository: string, branch: string, workflowId: number) {
  return run.workflow_id === workflowId && run.head_repository?.full_name === repository && run.head_branch === branch &&
    ["workflow_dispatch", "schedule"].includes(run.event) && run.status === "completed";
}

const jobSchema = z.object({ name: z.string(), conclusion: z.string().nullable(), steps: z.array(z.object({
  name: z.string(), conclusion: z.string().nullable(), completed_at: time.nullable().optional(),
})) });
/** conclusion workflow недостаточно: advisory job может быть зелёной при
 * incomplete. Нужны успешные шаги, схема run.json и три отчёта этого SHA. */
export function validateCompletion(run: ApiRun, rawJobs: unknown, raw: unknown, rawReports: unknown[], now: number): Attempt {
  if (run.conclusion !== "success") throw new Error("run-failed");
  const jobs = z.array(jobSchema).parse(rawJobs);
  const matching = jobs.filter(job => job.name === "ZAP manual isolated (advisory)");
  if (matching.length !== 1 || matching[0].conclusion !== "success") throw new Error("job-invalid");
  const job = matching[0];
  const names = ["Isolated passive and active phases", "Publish safe phase reports", "Upload safe reports", "Mark technical outcome"];
  const steps = names.map(name => job.steps.filter(step => step.name === name));
  if (steps.some(list => list.length !== 1 || list[0].conclusion !== "success")) throw new Error("job-invalid");
  const completedAt = steps[0][0].completed_at;
  if (!completedAt || Date.parse(completedAt) > now + 60_000) throw new Error("job-invalid");
  const report = activeRunSchema.parse(raw);
  if (report.status !== "completed" || report.phaseA !== "completed" || report.phaseB !== "completed" || report.control ||
    report.dirty !== false || report.revision !== run.head_sha || report.passive?.status !== "completed" || report.passive.pending !== 0 ||
    report.passive.failedScenarios.length || report.passive.reasons.length || report.passive.requests === undefined ||
    report.targets.some(target => target.seedSuccess !== true || target.rules?.length !== 2 ||
      new Set(target.rules.map(rule => rule.id)).size !== 2 || target.rules.some(rule => rule.state !== "complete" || !rule.requests))) throw new Error("report-invalid");
  const phases = z.array(reportSchema).length(3).parse(rawReports);
  if (phases.some(phase => phase.run.status !== "completed" || phase.run.dirty || phase.run.revision !== run.head_sha) ||
    new Set(phases.map(phase => phase.run.scope)).size !== 3) throw new Error("report-invalid");
  return attemptSchema.parse({ runId: run.id, attempt: run.run_attempt, revision: run.head_sha, completedAt,
    result: "completed", reason: "completed", passiveRequests: report.passive.requests, activeRequests: report.requests });
}

const marker = "zap-operations:v1";
export function readLedger(body: string, repository: string, probe: boolean): Ledger {
  if (body.length > 15_000) throw new Error("operations-invalid-ledger");
  const matches = [...body.matchAll(/<!-- zap-operations:v1\n([^\n]+)\n-->/g)];
  if (matches.length !== 1) throw new Error("operations-invalid-ledger");
  const ledger = ledgerSchema.parse(JSON.parse(matches[0][1]));
  if (ledger.repository !== repository || ledger.probe !== probe) throw new Error("operations-invalid-ledger");
  return ledger;
}

export function renderLedger(input: Ledger, now: number) {
  const ledger = ledgerSchema.parse(input);
  const state = health(ledger, now);
  const link = (record: Attempt) => `[${record.runId}, попытка ${record.attempt}](https://github.com/${ledger.repository}/actions/runs/${record.runId})`;
  const success = ledger.lastSuccess;
  const latest = ledger.lastAttempt;
  const body = ["## Периодический ZAP", ledger.probe ? "**ТЕСТ СИГНАЛА. Не состояние настоящего скана. Время проверки может быть смоделировано.**" : "Журнал технического состояния; отсутствие находок не означает полноту проверки приложения.",
    `Состояние: **${state}**. Проверено: ${new Date(now).toISOString()}.`,
    "Расписание: 5-го числа, 10:17 Asia/Tokyo; просрочка — более 40 дней без полного анализа.",
    success ? `Последний полный анализ: ${link(success)}, ${success.completedAt}, SHA \`${success.revision}\`. A/B completed, passive ${success.passiveRequests}, active ${success.activeRequests}.` : "Подтверждённого полного анализа нет.",
    latest ? `Последняя попытка: ${link(latest)}, **${latest.result}**, причина \`${latest.reason}\`.` : "Попыток пока нет.",
    "При сбое: открыть run, устранить причину, затем Actions → ZAP Manual (advisory) → Run workflow → main. Автоматических повторных атак нет.",
    "Подробные отчёты: artifact выбранного run, 30 дней. Этот журнал/история комментариев сохраняются до ручного удаления Issue.",
    "Healthy означает свежий завершённый анализ, а не отсутствие High. Разбор находок ведётся отдельно.",
    `<!-- ${marker}\n${JSON.stringify({ ...ledger, observedState: state })}\n-->`].join("\n\n");
  return { state, body, issueState: state === "healthy" ? "closed" as const : "open" as const };
}

export function transition(previous: Ledger | null, next: Ledger, previousIssueState: string, now: number) {
  const current = renderLedger(next, now);
  // Предыдущее состояние берём из Issue отдельно: ежедневное увеличение now
  // иначе превратило бы вчерашнее healthy в stale ещё до сравнения.
  const attemptChanged = JSON.stringify(previous?.lastAttempt) !== JSON.stringify(next.lastAttempt);
  return { ...current, comment: !previous || attemptChanged || previous.observedState !== current.state || previousIssueState !== current.issueState };
}
