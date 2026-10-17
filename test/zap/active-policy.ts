import { z } from "zod";
// @ts-expect-error Node 24 исполняет этот модуль без bundler и требует .ts.
import { scenarios } from "./manifest.ts";

// Первый профиль намеренно узкий: никаких RCE, time-based SQL или persistent XSS.
export const activePolicy = Object.freeze({
  origin: "http://localhost:3102", upstream: "http://localhost:3100",
  rules: ["40012", "40018"], strength: "LOW", threshold: "MEDIUM",
  maxRequests: 600, maxBodyBytes: 64_000, maxActiveMs: 30 * 60_000,
});
export type ActiveTarget = {
  role: "anonymous" | "owner" | "recipient";
  operation: "none" | "createList" | "addItem";
  path: string; method: "GET" | "POST"; field: string;
  body: string; headers: Record<string, string>;
};

/** Только runtime manifest, построенный из настоящего браузерного запроса.
 * Строки тела/сессий не сериализуются в отчёты. */
export function assertActiveTarget(target: ActiveTarget) {
  if (target.path.includes("#") || target.path.includes("\\") || target.path.includes("%") || target.path.startsWith("//")) throw new Error("active-target-refused");
  if (target.method === "GET") {
    if (target.role !== "anonymous" || target.operation !== "none" || target.path !== "/en?zap=baseline" || target.field !== "zap") throw new Error("active-target-refused");
  } else {
    if (!/^\/en\/spaces\/[a-zA-Z0-9_-]+$/.test(target.path) ||
      !((target.role === "owner" && target.operation === "createList") || (target.role === "recipient" && target.operation === "addItem")) ||
      !/^[a-f0-9]{40,64}$/.test(target.headers["next-action"] ?? "") ||
      !/multipart\/form-data;\s*boundary=[\w-]+$/.test(target.headers["content-type"] ?? "") ||
      !target.headers.cookie?.includes("authjs.session-token=")) throw new Error("active-target-refused");
    const fields = multipart(target.body, target.headers["content-type"]);
    if (!fields.has(target.field) || !target.field.endsWith(target.operation === "createList" ? "_title" : "_itemName")) throw new Error("active-target-refused");
  }
  if (Buffer.byteLength(target.body) > activePolicy.maxBodyBytes) throw new Error("active-target-refused");
}

/** Не общий multipart parser: только текстовые FormData без файлов/дубликатов.
 * Неизвестный wire format закрывает вход, а не ослабляет проверку. */
export function multipart(body: string, contentType: string) {
  const boundary = /boundary=([\w-]+)$/.exec(contentType)?.[1];
  if (!boundary || boundary.length > 100) throw new Error("active-body-refused");
  const chunks = body.split(`--${boundary}`);
  if (chunks[0] !== "" || !/^--(?:\r\n)?$/.test(chunks.at(-1) ?? "")) throw new Error("active-body-refused");
  const fields = new Map<string, string>();
  for (const part of chunks.slice(1, -1)) {
    const match = /^\r\nContent-Disposition: form-data; name="([\w$-]{1,100})"\r\n\r\n([\s\S]*)\r\n$/i.exec(part);
    if (!match || fields.has(match[1]) || fields.size >= 30) throw new Error("active-body-refused");
    fields.set(match[1], match[2]);
  }
  return fields;
}

/** ZAP 2.17 нормализует boundary в нижний регистр при выборе multipart
 * variant. Меняем только транспортный разделитель, сохраняя все поля/значения. */
export function canonicalMultipart(body: string, contentType: string) {
  const fields = multipart(body, contentType);
  const boundary = /boundary=([\w-]+)$/.exec(contentType)![1];
  const canonical = "zapmanualboundary";
  if ([...fields.values()].some(value => value.includes(`--${canonical}`))) throw new Error("active-body-refused");
  const normalized = body.replaceAll(`--${boundary}`, `--${canonical}`);
  const normalizedType = `multipart/form-data; boundary=${canonical}`;
  const actual = multipart(normalized, normalizedType);
  if ([...fields].some(([key, value]) => actual.get(key) !== value)) throw new Error("active-body-refused");
  return { body: normalized, contentType: normalizedType };
}

export function admitMutation(target: ActiveTarget, method: string, path: string, body: string, contentType: string) {
  if (Buffer.byteLength(body) > activePolicy.maxBodyBytes || method !== target.method) return { allowed: false, mutated: false };
  try {
    if (method === "GET") {
      const url = new URL(path, activePolicy.origin);
      const keys = [...url.searchParams.keys()];
      const allowed = path.startsWith("/en?") && url.origin === activePolicy.origin && url.pathname === "/en" && keys.length === 1 && keys[0] === "zap";
      return { allowed, mutated: allowed && url.searchParams.get("zap") !== "baseline" };
    }
    if (path !== target.path || contentType !== target.headers["content-type"]) return { allowed: false, mutated: false };
    const seed = multipart(target.body, contentType);
    const attack = multipart(body, contentType);
    const allowed = seed.size === attack.size && [...seed].every(([key, value]) => attack.has(key) && (key === target.field || attack.get(key) === value));
    return { allowed, mutated: allowed && attack.get(target.field) !== seed.get(target.field) };
  } catch { return { allowed: false, mutated: false }; }
}

const count = z.number().int().min(0).max(4_000_000);
const scenarioIds = scenarios.map(scenario => scenario.id);
const passiveSummarySchema = z.object({
  status: z.enum(["completed", "incomplete", "error"]), pending: count.optional(), requests: count.optional(), durationMs: count.optional(),
  failedScenarios: z.array(z.enum(scenarioIds)).max(22),
  reasons: z.array(z.enum(["coverage", "scenario-process-failed", "passive-queue-not-drained", "other"])).max(30),
}).strict();

export function summarizePassive(raw: unknown) {
  const source = z.object({ status: z.enum(["completed", "incomplete", "error"]), pending: count.optional(), requests: count.optional(), durationMs: count.optional(),
    coverage: z.array(z.object({ id: z.string(), passed: z.boolean(), complete: z.boolean() })).default([]), reasons: z.array(z.string()).default([]) }).parse(raw);
  return passiveSummarySchema.parse({ status: source.status, pending: source.pending, requests: source.requests, durationMs: source.durationMs,
    failedScenarios: source.coverage.filter(entry => !entry.complete || !entry.passed).map(entry => entry.id).filter(id => scenarioIds.some(known => known === id)),
    reasons: source.reasons.map(reason => reason.startsWith("coverage:") ? "coverage" : ["scenario-process-failed", "passive-queue-not-drained"].includes(reason) ? reason : "other") });
}
export const activeRunSchema = z.object({
  version: z.literal(1), status: z.enum(["completed", "incomplete", "error"]),
  step: z.enum(["precondition", "seed", "policy", "scan", "report", "finished"]).optional(),
  lastApi: z.enum(["sendRequest", "scan", "scans", "scanProgress", "status", "stop", "addScanPolicy", "disableAllScanners", "enableScanners", "setScannerAttackStrength", "setScannerAlertThreshold", "scanners", "setOptionThreadPerHost", "setOptionHostPerScan", "setOptionDelayInMs", "setOptionMaxScanDurationInMins", "setOptionMaxRuleDurationInMins", "setOptionTargetParamsInjectable", "setOptionTargetParamsEnabledRPC", "setOptionAddQueryParam", "newContext", "includeInContext", "setContextInScope", "addExcludedParam", "recordsToScan", "numberOfMessages", "message", "messages", "alerts"]).optional(),
  apiCode: z.enum(["missing_parameter", "bad_parameter", "bad_action", "url_not_in_scope", "url_not_found", "bad_type", "bad_other", "does_not_exist", "already_exists", "illegal_parameter", "content_type_not_supported", "unknown"]).optional(),
  revision: z.string().regex(/^(?:[a-f0-9]{40}|unknown)$/).optional(), startedAt: z.iso.datetime().optional(),
  dirty: z.boolean().optional(),
  passive: passiveSummarySchema.optional(),
  phaseA: z.enum(["completed", "incomplete", "error"]), phaseB: z.enum(["completed", "incomplete", "error", "skipped"]),
  reasons: z.array(z.enum(["phase-a-incomplete", "active-process-failed", "active-precondition-failed", "active-budget", "active-session-lost", "active-coverage", "active-queue", "active-wire-format", "active-infrastructure", "cleanup-failed"])).max(20),
  control: z.boolean(), controlFound: z.boolean(), requests: count, rejected: count, durationMs: count,
  targets: z.array(z.object({ role: z.enum(["anonymous", "owner", "recipient"]), operation: z.enum(["none", "createList", "addItem"]),
    requests: count, mutations: count, successfulMutations: count, sessionBefore: z.boolean(), sessionAfter: z.boolean(),
    seedStatus: count.optional(), seedSuccess: z.boolean().optional(),
    rules: z.array(z.object({ id: z.enum(["40012", "40018"]), requests: count, state: z.enum(["complete", "skipped", "other"]) }).strict()).max(2).optional(),
  }).strict()).max(3),
}).strict().superRefine((run, context) => {
  if (run.requests > activePolicy.maxRequests) context.addIssue({ code: "custom", message: "request-budget" });
  if (run.status !== "completed") return;
  const expected = run.control ? ["anonymous:none"] : ["anonymous:none", "owner:createList", "recipient:addItem"];
  if (run.phaseA !== "completed" || run.phaseB !== "completed" || run.reasons.length || !run.requests ||
    run.targets.length !== expected.length || (run.control && !run.controlFound) ||
    !expected.every(key => run.targets.filter(target => `${target.role}:${target.operation}` === key).length === 1) ||
    run.targets.some(target => !target.requests || !target.mutations || !target.successfulMutations || !target.sessionBefore || !target.sessionAfter) ||
    run.targets.reduce((total, target) => total + target.requests, 0) > run.requests) {
    context.addIssue({ code: "custom", message: "active-incomplete-coverage" });
  }
});
export type ActiveRun = z.infer<typeof activeRunSchema>;
