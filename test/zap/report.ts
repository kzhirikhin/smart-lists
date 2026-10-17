import { createHash } from "node:crypto";
import { z } from "zod";

/** Формат намеренно не повторяет raw JSON ZAP: произвольные строки не публикуются. */
const risk = z.enum(["Informational", "Low", "Medium", "High"]);
const confidence = z.enum(["Low", "Medium", "High", "Confirmed", "False Positive"]);
const persona = z.enum(["anonymous", "guest", "owner", "recipient", "resource", "unknown"]);
const method = z.enum(["GET", "POST", "HEAD", "OPTIONS", "OTHER"]);
const representation = z.enum(["html", "rsc", "script", "style", "font", "image", "json", "redirect", "unknown"]);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const rule = z.string().regex(/^\d{1,6}(?:-\d{1,3})?$/);
const routes = ["/", "/en", "/ru", "/vi", "/ja", "/favicon-dark.ico", "/site.webmanifest", "/icon.png", "/apple-icon.png",
  ...["en", "ru", "vi", "ja"].flatMap((locale) => [`/${locale}/spaces/:spaceId`, `/${locale}/robots.txt`, `/${locale}/sitemap.xml`]),
  "/_next/static/immutable/chunks/:chunk.js", "/_next/static/immutable/chunks/:chunk.css", "/_next/static/immutable/media/:font.woff2", "[redacted]"];
const routeSchema = z.string().refine((value) => routes.includes(value));
const parameter = z.enum(["none", "[redacted]", "Content-Security-Policy", "Access-Control-Allow-Origin", "Cache-Control", "NEXT_LOCALE", "authjs.session-token", "__Secure-authjs.session-token", "guest-mode", "smart-lists-space"]);
const location = z.enum(["header", "cookie", "document", "unknown"]);
const operation = z.string().regex(/^(?:none|unknown|inline-form|[a-z][a-zA-Z0-9]{0,63})$/);
const evidenceKind = z.enum(["csp", "cors", "cookie-flags", "cache", "missing-header", "flag-preload", "csrf-unverified", "session-marker", "spa", "redacted"]);
// Только канонические значения, полученные ниже из ограниченных словарей.
const evidenceValue = z.string().max(1000).regex(/^[a-zA-Z0-9_ .;=:'/*,\-\[\]]*$/);
const subjectSchema = z.object({
  route: routeSchema, method, persona, representation, operation,
  query: z.enum(["none", "rsc", "unknown"]), comparable: z.boolean(),
}).strict();
export type Subject = z.infer<typeof subjectSchema> & { headers: Record<string, string[]> };

const findingSchema = z.object({
  identity: digest, fingerprint: digest, rule, risk, confidence, subject: subjectSchema,
  parameter, location, evidence: z.object({ kind: evidenceKind, value: evidenceValue }).strict(),
  comparable: z.boolean(), instances: z.number().int().min(1).max(20000),
  lifecycle: z.enum(["new", "known", "changed", "uncompared"]),
  decision: z.enum(["new", "confirmed", "false-positive", "expected", "accepted-risk"]),
  decisionId: z.string().regex(/^ZAP-\d{3}$/).optional(),
}).strict();
type Finding = z.infer<typeof findingSchema>;

const runSchema = z.object({
  status: z.enum(["completed", "incomplete", "error", "skipped"]),
  startedAt: z.iso.datetime(), revision: z.string().regex(/^(?:[a-f0-9]{40}|unknown)$/), dirty: z.boolean(),
  image: z.string().regex(/^(?:sha256:[a-f0-9]{64}|unknown)$/),
  scanner: digest, scope: digest, target: z.literal("local-http"),
  formatVersion: z.literal(2), normalizationVersion: z.literal(1), policyDigest: digest,
}).strict();
const decisionNoteSchema = z.object({ id: z.string().regex(/^ZAP-\d{3}$/), reason: z.enum(["public-static-cors", "locale-cookie", "public-flag-image", "confirmed-issue", "accepted-csp-risk"]), owner: z.literal("project-owner"), reviewBy: z.iso.date(), reference: z.enum(["docs/zap-triage.md#static-cors", "docs/zap-triage.md#locale-cookie", "docs/zap-triage.md#flag-image", "docs/threat-model/risks.md#внедрение-zap"]) }).strict();
export const reportSchema = z.object({
  run: runSchema, findings: z.array(findingSchema).max(20000),
  decisions: z.array(decisionNoteSchema).max(500).default([]),
  comparison: z.enum(["available", "unavailable"]),
  warnings: z.array(z.string().regex(/^(?:invalid|expired|conflicting)-decision:[0-9]{1,5}$|^baseline-(?:absent|incompatible|invalid)$/)).max(20501),
}).strict();
export type Report = z.infer<typeof reportSchema>;
export type Run = z.infer<typeof runSchema>;

const reasons = z.enum(["public-static-cors", "locale-cookie", "public-flag-image", "confirmed-issue", "accepted-csp-risk"]);
const decisionSchema = z.object({
  id: z.string().regex(/^ZAP-\d{3}$/), owner: z.literal("project-owner"),
  createdAt: z.iso.date(), reviewBy: z.iso.date(), reason: reasons,
  reference: z.enum(["docs/zap-triage.md#static-cors", "docs/zap-triage.md#locale-cookie", "docs/zap-triage.md#flag-image", "docs/threat-model/risks.md#внедрение-zap"]),
  decision: z.enum(["confirmed", "false-positive", "expected", "accepted-risk"]),
  match: z.object({ rule: z.union([rule, z.array(rule).min(1).max(10)]), route: z.union([routeSchema, z.array(routeSchema).min(1).max(20)]), method, persona: z.union([persona, z.array(persona).min(1).max(6)]), representation, operation, parameter, location, risk, confidence,
    evidence: z.object({ kind: evidenceKind, value: evidenceValue }).strict(),
  }).strict(),
}).strict();
export type Decision = z.infer<typeof decisionSchema>;

const rawAlertSchema = z.object({
  alertRef: rule, risk, confidence,
  messageId: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  param: z.string().max(4096).optional(), evidence: z.string().max(100000).optional(),
});
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function boundedJson(response: Response, maxBytes = 16_000_000): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("invalid-api-response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("api-size-limit");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}

const header = (headers: Record<string, string[]>, name: string) => headers[name]?.join(",") ?? "";
/** Вход санитайзера: headers ещё содержат cookie; результат нельзя сериализовать. */
export function safeSubject(raw: unknown, actionNames: Record<string, string>, scenarios: readonly { id: string; auth: boolean }[]): Subject {
  const parsed = z.object({ requestHeader: z.string().max(200000), responseHeader: z.string().max(200000) }).safeParse(raw);
  if (!parsed.success) throw new Error("invalid-message");
  const { requestHeader, responseHeader } = parsed.data;
  const headers: Record<string, string[]> = Object.create(null);
  for (const line of responseHeader.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(":");
    if (index > 0) {
      const name = line.slice(0, index).toLowerCase();
      // Raw values живут только в памяти до извлечения разрешённых признаков.
      if (["content-security-policy", "access-control-allow-origin", "access-control-allow-credentials", "set-cookie", "cache-control", "content-type", "x-frame-options", "x-content-type-options", "strict-transport-security", "cross-origin-embedder-policy", "cross-origin-opener-policy", "cross-origin-resource-policy"].includes(name)) (headers[name] ??= []).push(line.slice(index + 1).trim());
    }
  }
  const request = /^(\S+) (\S+) HTTP\//.exec(requestHeader);
  const url = new URL(request?.[2] ?? "/", "http://localhost:3100");
  const host = /^host:\s*localhost:3100\s*$/im.test(requestHeader);
  let route = routes.includes(url.pathname) && url.pathname !== "[redacted]" ? url.pathname : "[redacted]";
  if (/^\/(en|ru|vi|ja)\/spaces\/[a-zA-Z0-9_-]+$/.test(url.pathname)) route = url.pathname.replace(/\/[^/]+$/, "/:spaceId");
  if (/^\/_next\/static\/immutable\/chunks\/[a-zA-Z0-9_-]+\.(js|css)$/.test(url.pathname)) route = url.pathname.replace(/\/[^/]+$/, url.pathname.endsWith(".js") ? "/:chunk.js" : "/:chunk.css");
  if (/^\/_next\/static\/immutable\/media\/[a-zA-Z0-9_.-]+\.woff2$/.test(url.pathname)) route = "/_next/static/immutable/media/:font.woff2";
  if (!host || url.origin !== "http://localhost:3100") route = "[redacted]";
  const type = header(headers, "content-type").split(";")[0];
  const repr = ({ "text/html": "html", "text/x-component": "rsc", "application/javascript": "script", "text/javascript": "script", "text/css": "style", "font/woff2": "font", "application/json": "json", "application/manifest+json": "json", "image/png": "image", "image/x-icon": "image", "image/svg+xml": "image" } as const)[type as "text/html"] ?? (/^HTTP\/\S+ 30[1378]\b/.test(responseHeader) ? "redirect" : "unknown");
  const scenario = scenarios.find((item) => item.id === /^x-zap-pilot-test:\s*([a-z-]+)\s*$/im.exec(requestHeader)?.[1]);
  const hasSession = /^cookie:.*(?:^|[;\s])authjs\.session-token=[^;\s]+/im.test(requestHeader);
  const context = /^x-zap-pilot-context:\s*(\d+)\s*$/im.exec(requestHeader)?.[1];
  const isStatic = route.startsWith("/_next/static/") && /(?:^|,)\s*public(?:,|$)/i.test(header(headers, "cache-control")) && !headers["set-cookie"];
  const who = isStatic ? "resource" : !scenario ? "unknown" : hasSession && scenario.auth ? context === "1" ? "owner" : ["share", "revoke"].includes(scenario.id) && context === "2" ? "recipient" : "unknown" : /^cookie:.*\bguest-mode=/im.test(requestHeader) ? "guest" : "anonymous";
  const actionId = /^next-action:\s*(\S+)/im.exec(requestHeader)?.[1];
  const name = actionId ? actionNames[actionId] : undefined;
  const action = request?.[1] !== "POST" ? "none" : name && /^[a-z][a-zA-Z0-9]{0,63}$/.test(name) ? name : name?.startsWith("$$RSC_") ? "inline-form" : "unknown";
  const queryKeys = [...url.searchParams.keys()];
  const query = !queryKeys.length ? "none" : queryKeys.every((key) => key === "_rsc") ? "rsc" : "unknown";
  return { route, method: method.safeParse(request?.[1]).success ? request![1] as z.infer<typeof method> : "OTHER", persona: who, representation: repr,
    operation: action, query, comparable: route !== "[redacted]" && who !== "unknown" && query !== "unknown" && !["unknown", "inline-form"].includes(action), headers };
}

function evidenceFor(alert: z.infer<typeof rawAlertSchema>, subject: Subject) {
  const base = alert.alertRef.split("-")[0];
  let comparable = true;
  let param: z.infer<typeof parameter> = "none";
  let where: z.infer<typeof location> = "header";
  let kind: z.infer<typeof evidenceKind> = "redacted";
  let value = "evidence-redacted";
  if (base === "10055") {
    param = "Content-Security-Policy"; kind = "csp";
    const raw = header(subject.headers, "content-security-policy");
    const allowed = new Set(["base-uri", "object-src", "frame-ancestors", "form-action", "script-src", "style-src", "default-src", "connect-src", "img-src", "font-src", "'self'", "'none'", "'unsafe-inline'", "'unsafe-eval'", "https://accounts.google.com", "*"]);
    const tokens = raw.split(/[;\s]+/).filter(Boolean);
    comparable = tokens.length > 0 && tokens.every((token) => allowed.has(token));
    // Только известные публичные CSP-источники; это признаки конфигурации,
    // а не OAuth credentials или пароли для хеширования/проверки входа.
    value = comparable ? raw.split(";").map((directive) => directive.trim().split(/\s+/).map((source) => source === "https://accounts.google.com" ? "google-accounts" : source).join(" ")).filter(Boolean).join("; ") : "csp-values-redacted";
  } else if (base === "10098") {
    param = "Access-Control-Allow-Origin"; kind = "cors";
    const origin = header(subject.headers, "access-control-allow-origin");
    const credentials = header(subject.headers, "access-control-allow-credentials");
    comparable = origin === "*" && ["", "true", "false"].includes(credentials);
    value = comparable ? `allow-origin=*;credentials=${credentials || "absent"}` : "cors-values-redacted";
  } else if (["10010", "10011", "10054"].includes(base)) {
    where = "cookie"; kind = "cookie-flags";
    const candidate = parameter.safeParse(alert.param);
    param = candidate.success && !["none", "[redacted]", "Content-Security-Policy", "Access-Control-Allow-Origin", "Cache-Control"].includes(candidate.data) ? candidate.data : "[redacted]";
    const cookies = (subject.headers["set-cookie"] ?? []).filter((cookie) => cookie.slice(0, cookie.indexOf("=")) === param);
    comparable = param !== "[redacted]" && cookies.length === 1;
    const cookie = cookies[0] ?? "";
    const sameSite = /;\s*samesite=(lax|strict|none)(?:;|$)/i.exec(cookie)?.[1].toLowerCase() ?? "absent";
    value = `HttpOnly=${/;\s*httponly(?:;|$)/i.test(cookie)};Secure=${/;\s*secure(?:;|$)/i.test(cookie)};SameSite=${sameSite}`;
  } else if (["10015", "10049", "10050"].includes(base)) {
    param = "Cache-Control"; kind = "cache";
    const parts = header(subject.headers, "cache-control").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean).sort();
    comparable = parts.every((part) => /^(?:public|private|no-cache|no-store|must-revalidate|immutable|(?:s-maxage|max-age|stale-while-revalidate)=\d{1,9})$/.test(part));
    value = comparable ? parts.join(";") || "absent" : "cache-values-redacted";
  } else if (["10019", "10020", "10021", "10035", "10038", "90004"].includes(base)) {
    kind = "missing-header";
    const relevant = ({ "10019": ["content-type"], "10020": ["x-frame-options"], "10021": ["x-content-type-options"], "10035": ["strict-transport-security"], "10038": ["content-security-policy"] } as Record<string, string[]>)[base] ?? ["cross-origin-embedder-policy", "cross-origin-opener-policy", "cross-origin-resource-policy"];
    value = relevant.filter((name) => !subject.headers[name]).join(";") || "header-value-requires-review";
    comparable = value !== "header-value-requires-review";
  } else if (base === "90003" && /^<link rel="preload" as="image" href="https:\/\/flagcdn\.com\/(?:gb|ru|vn|jp)\.svg"\s*\/?>$/.test(alert.evidence ?? "")) {
    kind = "flag-preload"; value = "public-flag-image-preload"; where = "document";
  } else if (base === "10202") {
    kind = "csrf-unverified"; value = "form-without-recognized-token;server-protection-unverified"; where = "document"; comparable = false;
  } else if (base === "10112") {
    kind = "session-marker";
    const cookieNames = (subject.headers["set-cookie"] ?? []).map((cookie) => cookie.slice(0, cookie.indexOf("="))).sort();
    const allowed = ["NEXT_LOCALE", "authjs.session-token", "__Secure-authjs.session-token", "guest-mode", "smart-lists-space", "authjs.csrf-token", "authjs.callback-url"];
    comparable = cookieNames.length > 0 && cookieNames.every((name) => allowed.includes(name));
    value = comparable ? `session-response;cookies=${cookieNames.join(",")}` : "session-marker-details-redacted";
  } else if (base === "10109") {
    kind = "spa"; value = "modern-web-application-marker"; where = "document";
  } else { comparable = false; where = "unknown"; }
  return { comparable, parameter: param, location: where, evidence: { kind, value } };
}

export function sanitizeAlerts(raw: unknown, subjects: Map<string, Subject>): Finding[] {
  const array = z.array(z.unknown()).max(20000).safeParse(raw);
  if (!array.success) throw new Error("invalid-alerts");
  const result = new Map<string, Finding>();
  for (const [index, item] of array.data.entries()) {
    const parsed = rawAlertSchema.safeParse(item);
    if (!parsed.success) throw new Error("invalid-alert");
    const alert = parsed.data;
    const subject = subjects.get(String(alert.messageId));
    if (!subject) throw new Error("missing-alert-message");
    const evidence = evidenceFor(alert, subject);
    const { headers: _headers, ...safe } = subject;
    void _headers;
    const comparable = safe.comparable && evidence.comparable;
    const identity = hash([alert.alertRef, "local-http", safe.route, safe.method, safe.persona, safe.representation, safe.operation, safe.query, evidence.parameter, evidence.location, ...(comparable ? [] : [index])]);
    const fingerprint = hash([alert.risk, alert.confidence, evidence.evidence]);
    const group = `${identity}:${fingerprint}`;
    const previous = result.get(group);
    if (previous) previous.instances++;
    else result.set(group, findingSchema.parse({ identity, fingerprint, rule: alert.alertRef, risk: alert.risk, confidence: alert.confidence, subject: safe,
      parameter: evidence.parameter, location: evidence.location, evidence: evidence.evidence, comparable, instances: 1, lifecycle: "uncompared", decision: "new" }));
  }
  return [...result.values()].sort((a, b) => a.identity.localeCompare(b.identity));
}

export function readPolicy(raw: unknown, now: string) {
  const top = z.object({ version: z.literal(1), decisions: z.array(z.unknown()).max(500) }).strict().safeParse(raw);
  if (!top.success) throw new Error("invalid-policy");
  const active: Decision[] = [];
  const warnings: string[] = [];
  const parsedEntries = top.data.decisions.map((item) => decisionSchema.safeParse(item));
  for (const [index, item] of top.data.decisions.entries()) {
    const parsed = decisionSchema.safeParse(item);
    if (!parsed.success) { warnings.push(`invalid-decision:${index}`); continue; }
    const decision = parsed.data;
    const age = (Date.parse(decision.reviewBy) - Date.parse(decision.createdAt)) / 86400000;
    if (decision.createdAt > now || age < 0 || age > 90 || (decision.decision === "accepted-risk" && decision.reference !== "docs/threat-model/risks.md#внедрение-zap") || parsedEntries.filter((entry) => entry.success && entry.data.id === decision.id).length !== 1) { warnings.push(`invalid-decision:${index}`); continue; }
    if (decision.reviewBy < now) { warnings.push(`expired-decision:${index}`); continue; }
    active.push(decision);
  }
  return { active, warnings, digest: hash(top.data) };
}

export function buildReport(run: Run, findings: Finding[], policy: ReturnType<typeof readPolicy>, previous?: unknown): Report {
  const warnings = [...policy.warnings];
  const baseline = reportSchema.safeParse(previous);
  const compatible = run.status === "completed" && baseline.success && baseline.data.run.status === "completed" && run.scanner === baseline.data.run.scanner && run.scope === baseline.data.run.scope && run.target === baseline.data.run.target && run.normalizationVersion === baseline.data.run.normalizationVersion;
  if (!compatible) warnings.push(previous === undefined ? "baseline-absent" : baseline.success ? "baseline-incompatible" : "baseline-invalid");
  const output = findings.map((finding, index) => {
    const old = compatible ? baseline.data.findings.filter((entry) => entry.identity === finding.identity && entry.comparable) : [];
    const lifecycle = !compatible || !finding.comparable ? "uncompared" : !old.length ? "new" : old.some((entry) => entry.fingerprint === finding.fingerprint) ? "known" : "changed";
    const matches = finding.comparable && (previous === undefined || compatible) ? policy.active.filter((entry) => Object.entries(entry.match).every(([key, value]) => {
      const actual = key in finding.subject ? finding.subject[key as keyof typeof finding.subject] : finding[key as keyof Finding];
      return Array.isArray(value) ? value.some((candidate) => candidate === actual) : JSON.stringify(actual) === JSON.stringify(value);
    })) : [];
    if (matches.length > 1) warnings.push(`conflicting-decision:${index}`);
    // Изменившаяся находка требует нового разбора, даже если старый фильтр совпал.
    const applied = matches.length === 1 && lifecycle !== "changed" ? matches[0] : undefined;
    return { ...finding, lifecycle, decision: applied?.decision ?? "new", ...(applied ? { decisionId: applied.id } : {}) };
  });
  const appliedIds = new Set(output.map((finding) => finding.decisionId));
  const notes = policy.active.filter((entry) => appliedIds.has(entry.id)).map(({ id, reason, owner, reviewBy, reference }) => ({ id, reason, owner, reviewBy, reference }));
  return reportSchema.parse({ run: { ...run, policyDigest: policy.digest }, findings: output, decisions: notes, comparison: compatible ? "available" : "unavailable", warnings });
}

const names: Record<string, string> = {
  "10010": "Cookie без HttpOnly", "10011": "Cookie без Secure", "10015": "Пересмотр кэширования", "10049": "Кэшируемый ответ", "10050": "Ответ из кэша",
  "10055": "Неполная или слабая CSP", "10098": "Широкий CORS", "10109": "Современное веб-приложение", "10112": "Признак управления сессией", "10202": "CSRF-токен не распознан", "90003": "Нет SRI", "90004": "Нет cross-origin isolation header",
};
const explanations: Record<z.infer<typeof reasons>, string> = {
  "public-static-cors": "CORS разрешает чтение публичного статического ресурса; credentials отсутствуют.",
  "locale-cookie": "NEXT_LOCALE содержит выбор языка; это не cookie авторизации. Решение ограничено локальным HTTP-профилем.",
  "public-flag-image": "Предзагрузка публичной картинки флага; проверяемый элемент не исполняемый скрипт.",
  "confirmed-issue": "Проблема подтверждена; сохраняется в работе и не снимается известностью.",
  "accepted-csp-risk": "Риск частичной CSP принят явно; усиление и условия пересмотра описаны в модели угроз.",
};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const escapeMd = (value: string) => value.replace(/[\\`*_[\]<>|]/g, (char) => `\\${char}`).replaceAll("\n", " ");
export function renderReport(input: unknown) {
  const report = reportSchema.parse(input);
  const counts = { new: 0, known: 0, changed: 0, uncompared: 0 };
  for (const finding of report.findings) counts[finding.lifecycle]++;
  const comparison = report.comparison === "available" ? "Сравнение доступно" : "Сравнение недоступно";
  const priority = { High: 0, Medium: 1, Low: 2, Informational: 3 };
  const rows = [...report.findings].sort((a, b) => Number(a.decision !== "new" && a.decision !== "confirmed") - Number(b.decision !== "new" && b.decision !== "confirmed") || priority[a.risk] - priority[b.risk] || a.rule.localeCompare(b.rule) || a.identity.localeCompare(b.identity)).map((finding) => [finding.rule, names[finding.rule.split("-")[0]] ?? "Правило ZAP", finding.risk, finding.confidence, finding.subject.method, finding.subject.route, finding.subject.persona, finding.subject.operation, finding.parameter, finding.evidence.value, finding.lifecycle, finding.decisionId ? `${finding.decision} (${finding.decisionId})` : finding.decision, String(finding.instances)]);
  const notes = report.decisions.map((entry) => `${entry.id}: ${explanations[entry.reason]} Владелец: ${entry.owner}; пересмотр до ${entry.reviewBy}; ${entry.reference}`);
  const columns = ["Правило", "Название", "Риск", "Достоверность", "Метод", "Маршрут", "Персона", "Action", "Параметр", "Очищенное доказательство", "Изменение", "Решение", "Примеры"];
  const summary = [`# ZAP: ${report.run.status}`, "", comparison, "", `Групп находок: ${rows.length}; new=${counts.new}, known=${counts.known}, changed=${counts.changed}, uncompared=${counts.uncompared}.`, "", "Число примеров не равно числу уязвимостей. Оценка риска ZAP сохранена без понижения.", "", `High: ${report.findings.filter((finding) => finding.risk === "High").length}.`, "", ...report.warnings.map((warning) => `- ${warning}`), "", ...notes.map((note) => `- ${escapeMd(note)}`), "", `| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(escapeMd).join(" | ")} |`), ""].join("\n");
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Отчёт ZAP</title><style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse}th,td{border:1px solid #aaa;padding:6px;vertical-align:top;overflow-wrap:anywhere}th{background:#eee}</style><h1>ZAP: ${escapeHtml(report.run.status)}</h1><p>${escapeHtml(comparison)}</p><p>Групп находок: ${rows.length}. Число примеров не равно числу уязвимостей. Исходный риск сохранён.</p><p>High: ${report.findings.filter((finding) => finding.risk === "High").length}</p><ul>${report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul><table><thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></html>`;
  const annotatedHtml = html.replace("<table>", `<ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul><table>`);
  return { json: `${JSON.stringify(report, null, 2)}\n`, run: `${JSON.stringify(report.run, null, 2)}\n`, summary, html: annotatedHtml };
}
