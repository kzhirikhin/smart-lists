import { describe, expect, it } from "vitest";
import { boundedJson, buildReport, hash, readPolicy, renderReport, safeSubject, sanitizeAlerts, type Run, type Subject } from "./report";

const now = "2026-10-16";
const emptyPolicy = () => readPolicy({ version: 1, decisions: [] }, now);
const run: Run = { status: "completed", startedAt: "2026-10-16T00:00:00.000Z", revision: "unknown", dirty: true, image: "unknown", scanner: hash("scanner"), scope: hash("scope"), target: "local-http", formatVersion: 2, normalizationVersion: 1, policyDigest: hash("policy") };
const scenarios = [{ id: "notes", auth: true }, { id: "public-en", auth: false }, { id: "share", auth: true }];
const csp = "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com";
const message = (path = "/en", extra = `Content-Security-Policy: ${csp}\r\n`, requestExtra = "") => ({
  requestHeader: `GET ${path} HTTP/1.1\r\nHost: localhost:3100\r\nX-Zap-Pilot-Test: public-en\r\nX-Zap-Pilot-Context: 1\r\n${requestExtra}`,
  responseHeader: `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n${extra}`,
});
const alert = (overrides = {}) => ({ alertRef: "10055-5", risk: "Medium", confidence: "High", messageId: "1", ...overrides });
const findings = (overrides = {}, subject = safeSubject(message(), {}, scenarios)) => sanitizeAlerts([alert(overrides)], new Map([["1", subject]]));
const decision = (subject = findings()[0]) => ({
  id: "ZAP-001", owner: "project-owner", createdAt: now, reviewBy: "2027-01-14", reason: "accepted-csp-risk",
  reference: "docs/threat-model/risks.md#внедрение-zap", decision: "accepted-risk",
  match: { rule: subject.rule, route: subject.subject.route, method: subject.subject.method, persona: subject.subject.persona,
    representation: subject.subject.representation, operation: subject.subject.operation, parameter: subject.parameter,
    location: subject.location, risk: subject.risk, confidence: subject.confidence, evidence: subject.evidence },
});

describe("очистка и нормализация ZAP", () => {
  it("не публикует произвольные поля, query, cookie, body и ошибки сканера", () => {
    const secret = "PRIVATE_MARKER_DO_NOT_EXPORT";
    const subject = safeSubject(message(`/en?email=${secret}`, `Set-Cookie: NEXT_LOCALE=${secret}; SameSite=Lax\r\n`, `Cookie: authjs.session-token=${secret}\r\nAuthorization: Bearer ${secret}\r\n`), {}, scenarios);
    const result = sanitizeAlerts([alert({ alertRef: "10010", param: "NEXT_LOCALE", evidence: secret, attack: secret, description: secret, solution: secret, other: secret, url: `https://${secret}.test` })], new Map([["1", subject]]));
    const report = buildReport(run, result, emptyPolicy());
    const artifacts = renderReport(report);
    expect(JSON.stringify(artifacts)).not.toContain(secret);
    expect(result[0].comparable).toBe(false);
    expect(result[0].evidence.value).toBe("HttpOnly=false;Secure=false;SameSite=lax");
  });
  it("не маскирует неизвестное содержимое стабильным fingerprint", () => {
    for (const secret of ["GOCSPX-not-a-real-secret", "<script>alert(1)</script>", "Bearer private", "秘密", "private@example.test"]) {
      const values = findings({ alertRef: "12345", param: secret, evidence: secret });
      expect(values[0].comparable).toBe(false);
      expect(JSON.stringify(values)).not.toContain(secret);
    }
  });
  it("нормализует только известные space ID, статику и _rsc", () => {
    const subject = (path: string) => safeSubject(message(path), {}, scenarios);
    expect(subject("/en/spaces/id-one?_rsc=private").route).toBe("/en/spaces/:spaceId");
    expect(subject("/_next/static/immutable/chunks/hash_1.js").route).toContain(":chunk.js");
    expect(subject("/en/unknown/private-id").route).toBe("[redacted]");
    expect(subject("/en?new-business-input=private").comparable).toBe(false);
    expect(subject("/en?_rsc=secret").query).toBe("rsc");
    expect(subject("/en?query=secret").query).toBe("unknown");
  });
  it("не объединяет GET/Action, разные Actions, представления и персоны", () => {
    const make = (method: string, context: string, action: string) => safeSubject({
      requestHeader: `${method} /en/spaces/one HTTP/1.1\r\nHost: localhost:3100\r\nCookie: authjs.session-token=private\r\nX-Zap-Pilot-Test: share\r\nX-Zap-Pilot-Context: ${context}\r\nNext-Action: ${action}\r\n`,
      responseHeader: `HTTP/1.1 200 OK\r\nContent-Type: ${method === "GET" ? "text/html" : "text/x-component"}\r\nContent-Security-Policy: ${csp}\r\n`,
    }, { one: "renameList", two: "deleteList" }, scenarios);
    const keys = [["GET", "1", "one"], ["POST", "1", "one"], ["POST", "1", "two"], ["POST", "2", "one"]].map(([method, context, action]) => findings({}, make(method, context, action))[0].identity);
    expect(new Set(keys).size).toBe(4);
  });
  it("сохраняет границы директив CSP при сравнении evidence", () => {
    const first = findings({}, safeSubject(message("/en", "Content-Security-Policy: script-src 'self'; style-src 'none'\r\n"), {}, scenarios));
    const second = findings({}, safeSubject(message("/en", "Content-Security-Policy: script-src 'self' style-src 'none'\r\n"), {}, scenarios));
    expect(first[0].identity).toBe(second[0].identity);
    expect(first[0].fingerprint).not.toBe(second[0].fingerprint);
  });
  it("CORS exception не расширяется на private ресурс с cookie", () => {
    const path = "/_next/static/immutable/media/hash.woff2";
    const headers = "Access-Control-Allow-Origin: *\r\nCache-Control: public,max-age=31536000,immutable\r\n";
    expect(safeSubject(message(path, headers), {}, scenarios).persona).toBe("resource");
    expect(safeSubject(message(path, headers + "Set-Cookie: authjs.session-token=private\r\n"), {}, scenarios).persona).not.toBe("resource");
    expect(safeSubject(message(path, "Cache-Control: private\r\n"), {}, scenarios).persona).not.toBe("resource");
  });
  it("ошибочная схема прекращает создание отчёта", () => {
    expect(() => sanitizeAlerts([alert({ risk: "PRIVATE" })], new Map())).toThrow();
    expect(() => sanitizeAlerts([alert()], new Map())).toThrow();
    expect(() => safeSubject({ requestHeader: 42 }, {}, scenarios)).toThrow();
  });
  it("не переносит произвольные CSP/CORS значения", () => {
    for (const headers of ["Content-Security-Policy: script-src https://private.example.test\r\n", "Access-Control-Allow-Origin: https://private.example.test\r\n"]) {
      const subject = safeSubject(message("/en", headers), {}, scenarios);
      const result = findings({ alertRef: headers.startsWith("Access") ? "10098" : "10055-5" }, subject);
      expect(JSON.stringify(result)).not.toContain("private.example.test");
      expect(result[0].comparable).toBe(false);
    }
  });
  it("сохраняет только имена известных session-cookie без значений", () => {
    const known = findings({ alertRef: "10112" }, safeSubject(message("/en", "Set-Cookie: NEXT_LOCALE=PRIVATE_SESSION; SameSite=Lax\r\n"), {}, scenarios));
    expect(known[0].evidence.value).toBe("session-response;cookies=NEXT_LOCALE");
    expect(JSON.stringify(known)).not.toContain("PRIVATE_SESSION");
    const unknown = findings({ alertRef: "10112" }, safeSubject(message("/en", "Set-Cookie: PRIVATE_NAME=PRIVATE_VALUE\r\n"), {}, scenarios));
    expect(unknown[0].comparable).toBe(false);
    expect(JSON.stringify(unknown)).not.toContain("PRIVATE");
  });
});

describe("история и решения", () => {
  it("первый/неполный/несовместимый прогон не объявляет отсутствие новых проблем", () => {
    const first = buildReport(run, findings(), emptyPolicy());
    expect(first.comparison).toBe("unavailable");
    for (const current of [{ ...run, status: "incomplete" as const }, { ...run, scanner: hash("new-addon") }, { ...run, scope: hash("new-scenario") }]) {
      const result = buildReport(current, findings(), emptyPolicy(), first);
      expect(result.findings[0].lifecycle).toBe("uncompared");
      expect(renderReport(result).summary).toContain("Сравнение недоступно");
    }
    expect(buildReport(run, findings(), emptyPolicy(), { findings: [] }).warnings).toContain("baseline-invalid");
    const policy = readPolicy({ version: 1, decisions: [decision()] }, now);
    expect(buildReport({ ...run, scanner: hash("new-addon") }, findings(), policy, first).findings[0].decision).toBe("new");
  });
  it("отличает известное, новое и изменение severity/confidence/evidence", () => {
    const previous = buildReport(run, findings(), emptyPolicy());
    expect(buildReport(run, findings(), emptyPolicy(), previous).findings[0].lifecycle).toBe("known");
    expect(buildReport(run, findings({ alertRef: "10055-6" }), emptyPolicy(), previous).findings[0].lifecycle).toBe("new");
    for (const values of [findings({ risk: "High" }), findings({ confidence: "Low" }), findings({}, safeSubject(message("/en", "Content-Security-Policy: default-src *\r\n"), {}, scenarios))]) {
      expect(buildReport(run, values, emptyPolicy(), previous).findings[0].lifecycle).toBe("changed");
    }
  });
  it("применяет узкое решение без изменения исходного риска", () => {
    const policy = readPolicy({ version: 1, decisions: [decision()] }, now);
    const accepted = buildReport(run, findings(), policy);
    expect(accepted.findings[0]).toMatchObject({ risk: "Medium", decision: "accepted-risk", decisionId: "ZAP-001" });
    expect(buildReport(run, findings({ risk: "High" }), policy).findings[0].decision).toBe("new");
    expect(buildReport(run, findings({}, safeSubject(message("/ru"), {}, scenarios)), policy).findings[0].decision).toBe("new");
  });
  it("отклоняет просроченное, слишком долгое, дублирующееся и невалидное решение", () => {
    const entry = decision();
    expect(readPolicy({ version: 1, decisions: [{ ...entry, reviewBy: "2026-10-15" }] }, "2026-10-17").active).toHaveLength(0);
    expect(readPolicy({ version: 1, decisions: [{ ...entry, reviewBy: "2027-01-15" }] }, now).active).toHaveLength(0);
    expect(readPolicy({ version: 1, decisions: [entry, entry] }, now).active).toHaveLength(0);
    expect(readPolicy({ version: 1, decisions: [{ ...entry, match: { ...entry.match, route: ".*" } }] }, now).warnings).toContain("invalid-decision:0");
  });
  it("не подавляет изменившуюся находку или конфликт двух решений", () => {
    const previous = buildReport(run, findings({ confidence: "Low" }), emptyPolicy());
    const entry = decision();
    expect(buildReport(run, findings(), readPolicy({ version: 1, decisions: [entry] }, now), previous).findings[0].decision).toBe("new");
    const conflict = buildReport(run, findings(), readPolicy({ version: 1, decisions: [entry, { ...entry, id: "ZAP-002" }] }, now));
    expect(conflict.findings[0].decision).toBe("new");
    expect(conflict.warnings).toContain("conflicting-decision:0");
  });
  it("повтор unresolved остаётся new по решению даже при lifecycle known", () => {
    const previous = buildReport(run, findings(), emptyPolicy());
    expect(buildReport(run, findings(), emptyPolicy(), previous).findings[0]).toMatchObject({ lifecycle: "known", decision: "new" });
  });
  it("явный конечный список не расширяет решение на другие маршруты и роли", () => {
    const entry = decision();
    const policy = readPolicy({ version: 1, decisions: [{ ...entry, match: { ...entry.match, route: ["/en", "/ru"], persona: ["anonymous"], rule: ["10055-5"] } }] }, now);
    expect(buildReport(run, findings({}, safeSubject(message("/ru"), {}, scenarios)), policy).findings[0].decision).toBe("accepted-risk");
    expect(buildReport(run, findings({}, safeSubject(message("/ja"), {}, scenarios)), policy).findings[0].decision).toBe("new");
    const authenticated = { ...message(), requestHeader: message().requestHeader.replace("public-en", "notes") + "Cookie: authjs.session-token=private\r\n" };
    expect(buildReport(run, findings({}, safeSubject(authenticated, {}, scenarios)), policy).findings[0].decision).toBe("new");
  });
  it("просроченное корректное решение видно в предупреждениях и не применяется", () => {
    const policy = readPolicy({ version: 1, decisions: [decision()] }, "2027-01-15");
    expect(policy.warnings).toEqual(["expired-decision:0"]);
    expect(buildReport(run, findings(), policy).findings[0].decision).toBe("new");
  });
});

describe("артефакты", () => {
  it("строго проверяет выходную схему и не допускает HTML из сканера", () => {
    const report = buildReport(run, findings(), emptyPolicy());
    expect(renderReport(report).html).not.toContain("<script");
    expect(() => renderReport({ ...report, description: "<script>private</script>" })).toThrow();
    expect(() => renderReport({ ...report, run: { ...report.run, formatVersion: 1 } })).toThrow();
    expect(() => renderReport({ ...report, findings: [{ ...report.findings[0], evidence: { kind: "redacted", value: "<img src=x>" } }] })).toThrow();
  });
  it("ограничивает размер потока до полного чтения", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(50))); }, cancel() { cancelled = true; } }));
    await expect(boundedJson(response, 10)).rejects.toThrow("api-size-limit");
    expect(cancelled).toBe(true);
    await expect(boundedJson(new Response('{"ok":true}'))).resolves.toEqual({ ok: true });
  });
  it("разные неклассифицированные примеры не объединяются", () => {
    const subject: Subject = safeSubject(message(), {}, scenarios);
    const output = sanitizeAlerts([alert({ alertRef: "99999" }), alert({ alertRef: "99999" })], new Map([["1", subject]]));
    expect(output).toHaveLength(2);
    expect(new Set(output.map((finding) => finding.identity)).size).toBe(2);
  });
});
