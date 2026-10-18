import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { test, expect, type BrowserContext, type Request, type Locator, type Page } from "@playwright/test";
import { createPrismaClient } from "@/lib/prisma-client";
import { makeUser, makeList, makeItems, shareListWith } from "../e2e/factories";
import { signInAs } from "../e2e/fixtures";
import { addItem, createList, itemRow, listCard, openSpace } from "../e2e/helpers";
import { E2E_DATABASE_URL } from "../e2e/env";
import { activePolicy, activeRunSchema, assertActiveTarget, canonicalMultipart, multipart, withTargetValue, type ActiveRun, type ActiveTarget } from "./active-policy";
import { createActiveGate } from "./active-gate";
import { buildReport, hash, readPolicy, safeSubject, sanitizeAlerts } from "./report";
import { zapApi, ZapApiError, startSeededScan, nativeScanFinished, resetExcludedParams, confirmBrowserMutation } from "./active-api";
import { scenarios } from "./manifest";

const output = "/tmp/zap-output";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type Message = { id: string; requestHeader: string; requestBody: string; responseHeader: string };
type RawAlert = { sourceid: string; messageId: string; pluginId: string };

test("ограниченный active scan после успешной пассивной фазы", async ({ browser }) => {
  const started = Date.now();
  const probe = process.env.ZAP_MANUAL_PROBE ?? "none";
  const control = probe === "control";
  const result: ActiveRun = { version: 1, profile: activePolicy.profile, status: "error", phaseA: "completed", phaseB: "error", reasons: [], control,
    controlFound: false, requests: 0, rejected: 0, durationMs: 0, targets: [] };
  const gate = createActiveGate(probe === "budget" ? 1 : activePolicy.maxRequests, control);
  const contexts: BrowserContext[] = [];
  let training: Server | undefined;
  let db: ReturnType<typeof createPrismaClient> | undefined;
  let scanId: string | undefined;
  const deadline = started + activePolicy.maxActiveMs;
  const api: typeof zapApi = (...args) => {
    const parsed = activeRunSchema.shape.lastApi.safeParse(args[2]);
    if (parsed.success) result.lastApi = parsed.data;
    return zapApi(...args);
  };
  try {
    const phaseA = JSON.parse(await readFile(`${output}/pilot.json`, "utf8"));
    result.revision = phaseA.revision; result.dirty = phaseA.dirty; result.startedAt = new Date(started).toISOString();
    if (process.env.ZAP_PILOT !== "1" || E2E_DATABASE_URL !== "postgresql://postgres:postgres@localhost:5432/smartlists_zap_test" ||
      phaseA.status !== "completed" || phaseA.pending !== 0 || phaseA.coverage.length !== 22 || phaseA.egressProbe !== "external-ip-blocked") throw new Error("active-precondition-failed");
    db = createPrismaClient(E2E_DATABASE_URL);
    result.step = "seed";
    result.seedPhase = "fixtures";
    const refs = JSON.parse(await readFile(".next/server/server-reference-manifest.json", "utf8")).node as Record<string, { exportedName: string }>;
    const actionNames = Object.fromEntries(Object.entries(refs).map(([id, value]) => [id, value.exportedName]));
    const targets: { seed: ActiveTarget; session: () => Promise<boolean>; verify?: (accepted: string | undefined) => Promise<boolean>; render?: () => Promise<boolean> }[] = [];
    const renderChecks: (() => Promise<void>)[] = [];
    if (control) {
      // Отдельная учебная мишень, не маршрут/изменение Smart Lists.
      // Намеренный reflected XSS: CodeQL alert #7 разобран как used in tests.
      // Только probe=control, после isolated DB/egress precondition, loopback:3101.
      training = createServer((req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(`<html><body>${new URL(req.url ?? "/", "http://localhost:3101").searchParams.get("zap") ?? ""}</body></html>`); });
      await new Promise<void>(resolve => training!.listen(3101, "127.0.0.1", resolve));
    }
    targets.push({ seed: { role: "anonymous", operation: "none", method: "GET", path: "/en?zap=baseline", field: "zap", body: "", headers: { "x-zap-pilot-test": "public-en", "x-zap-pilot-context": "1" } }, session: async () => true });
    const newContext = async (scenario: string, index: string) => {
      const context = await browser.newContext({ extraHTTPHeaders: { "X-Zap-Pilot-Test": scenario, "X-Zap-Pilot-Context": index } });
      contexts.push(context);
      await context.route("**/*", route => new URL(route.request().url()).origin === activePolicy.upstream ? route.continue() : route.abort("blockedbyclient"));
      await context.routeWebSocket("**/*", socket => socket.close());
      await context.addInitScript(() => { Object.defineProperty(globalThis, "__zapXss", { value: 0, writable: true }); });
      return context;
    };
    const capture = async (context: BrowserContext, operation: Exclude<ActiveTarget["operation"], "none">, action: () => Promise<void>, role: "owner" | "recipient", expectedId: string, confirmed: () => Promise<boolean>) => {
      result.seedOperation = operation; result.seedPhase = "request";
      const page = context.pages()[0];
      const wire = page.waitForRequest(req => req.method() === "POST" && actionNames[req.headers()["next-action"]] === operation, { timeout: 10_000 });
      await action();
      const req: Request = await wire;
      // UI helpers могут завершиться на оптимистичном состоянии. Следующая
      // операция начинается только после настоящего ответа и revalidation.
      result.seedPhase = "response";
      const response = await req.response();
      await confirmBrowserMutation(response, confirmed);
      result.seedPhase = "format";
      const headers = await req.allHeaders();
      const normalized = canonicalMultipart(req.postData() ?? "", headers["content-type"]);
      const body = normalized.body;
      headers["content-type"] = normalized.contentType;
      const suffix = `_${activePolicy.targets.find(target => target.operation === operation)!.field}`;
      const field = [...multipart(body, headers["content-type"]).keys()].find(key => key.endsWith(suffix));
      if (!field || new URL(req.url()).origin !== activePolicy.upstream) throw new Error("active-coverage");
      const seed: ActiveTarget = { role, operation, method: "POST", path: new URL(req.url()).pathname, field, body, headers };
      assertActiveTarget(seed);
      const target: typeof targets[number] = { seed, session: async () => {
        const response = await context.request.get(`${activePolicy.upstream}/api/auth/session`, { maxRedirects: 0 });
        if (response.status() !== 200) return false;
        const data = await response.json();
        return data?.user?.id === expectedId;
      } };
      targets.push(target);
      return target;
    };
    const rename = async (page: Page, scope: Locator, kind: "list" | "item", value: string, read: () => Promise<string>) => {
      const operation = kind === "list" ? "renameList" : "renameItem";
      const done = page.waitForResponse(response => response.request().method() === "POST" && actionNames[response.request().headers()["next-action"]] === operation, { timeout: 10_000 });
      await scope.getByTestId(kind === "list" ? "list-title" : "item-name").click();
      const input = scope.getByTestId(kind === "list" ? "list-title-input" : "item-name-input");
      await input.fill(value); await input.press("Enter");
      const response = await done;
      await confirmBrowserMutation(response, async () => await read() === value);
    };
    const renderText = async (page: Page, scope: () => Locator, kind: "list" | "item", seed: ActiveTarget, read: () => Promise<string>) => {
      // Вредоносная разметка — синтетический текст только эфемерной БД.
      const value = "<svg onload=globalThis.__zapXss=1>";
      // После fuzzing название может быть невидимым/нулевой ширины. Повторное
      // открытие редактора не требуется для проверки безопасного отображения.
      const headers: Record<string, string> = { ...seed.headers, origin: activePolicy.upstream, "accept-encoding": "identity" };
      for (const name of ["content-length", "transfer-encoding", "host"]) delete headers[name];
      const response = await page.context().request.post(activePolicy.upstream + seed.path, {
        headers, data: withTargetValue(seed, value), maxRedirects: 0, timeout: 10_000,
      });
      if (!/"success":true/.test(await response.text())) throw new Error("active-coverage");
      await confirmBrowserMutation(response, async () => await read() === value);
      await page.reload();
      const label = scope().getByTestId(kind === "list" ? "list-title" : "item-name");
      await expect(label).toHaveText(value);
      await expect(label.locator("svg,img,script")).toHaveCount(0);
      return await page.evaluate(() => (globalThis as typeof globalThis & { __zapXss?: number }).__zapXss === 0);
    };
    if (!control) {
      const owner = await makeUser(db);
      const recipient = await makeUser(db);
      const list = await makeList(db, owner.id, owner.defaultSpaceId);
      const [renameFixture] = await makeItems(db, list.id, ["ZAP rename fixture"]);
      await shareListWith(db, list.id, recipient);
      const ownerContext = await newContext("list-create", "1");
      const recipientContext = await newContext("share", "2");
      await signInAs(ownerContext, db, owner); await signInAs(recipientContext, db, recipient);
      result.seedPhase = "navigation";
      const ownerPage = await ownerContext.newPage(); const recipientPage = await recipientContext.newPage();
      await openSpace(ownerPage, owner); await openSpace(recipientPage, recipient);
      await capture(ownerContext, "createList", () => createList(ownerPage, "ZAP synthetic seed"), "owner", owner.id,
        async () => Boolean(await db!.list.findFirst({ where: { ownerId: owner.id, spaceId: owner.defaultSpaceId, title: "ZAP synthetic seed" } })));
      await capture(recipientContext, "addItem", () => addItem(listCard(recipientPage, list.id), "ZAP synthetic item"), "recipient", recipient.id,
        async () => Boolean(await db!.item.findFirst({ where: { listId: list.id, name: "ZAP synthetic item", addedById: recipient.id } })));
      await ownerPage.reload();
      const readTitle = async () => (await db!.list.findUniqueOrThrow({ where: { id: list.id } })).title;
      const renameList = await capture(ownerContext, "renameList", () => rename(ownerPage, listCard(ownerPage, list.id), "list", "ZAP rename list", readTitle), "owner", owner.id, async () => await readTitle() === "ZAP rename list");
      renameList.verify = async accepted => accepted !== undefined && await readTitle() === accepted;
      renameList.render = () => renderText(ownerPage, () => listCard(ownerPage, list.id), "list", renameList.seed, readTitle);
      const row = () => itemRow(listCard(recipientPage, list.id), renameFixture.id);
      await recipientPage.reload();
      const readName = async () => (await db!.item.findUniqueOrThrow({ where: { id: renameFixture.id } })).name;
      const renameItem = await capture(recipientContext, "renameItem", () => rename(recipientPage, row(), "item", "ZAP rename item", readName), "recipient", recipient.id, async () => await readName() === "ZAP rename item");
      renameItem.verify = async accepted => accepted !== undefined && await readName() === accepted;
      renameItem.render = () => renderText(recipientPage, row, "item", renameItem.seed, readName);
      if (probe === "session") await db.session.deleteMany({ where: { userId: recipient.id } });
    }
    // Ни один active запрос не начинается до проверки ВСЕХ сессий.
    for (const { session } of targets) if (!(await session())) throw new Error("active-session-lost");
    await gate.listen();
    result.step = "policy";
    const policy = "manual-local";
    await api("ascan", "action", "addScanPolicy", { scanPolicyName: policy });
    await api("ascan", "action", "disableAllScanners", { scanPolicyName: policy });
    await api("ascan", "action", "enableScanners", { ids: activePolicy.rules.join(","), scanPolicyName: policy });
    for (const id of activePolicy.rules) {
      await api("ascan", "action", "setScannerAttackStrength", { id, attackStrength: "LOW", scanPolicyName: policy });
      await api("ascan", "action", "setScannerAlertThreshold", { id, alertThreshold: "MEDIUM", scanPolicyName: policy });
    }
    const rules = (await api("ascan", "view", "scanners", { scanPolicyName: policy })).scanners as { id: string; enabled: string; attackStrength: string }[];
    expect(rules.filter(rule => String(rule.enabled) === "true").map(rule => rule.id).sort()).toEqual([...activePolicy.rules].sort());
    for (const [option, value] of Object.entries({ ThreadPerHost: 1, HostPerScan: 1, DelayInMs: 50, MaxScanDurationInMins: 30, MaxRuleDurationInMins: 0, TargetParamsInjectable: 3, TargetParamsEnabledRPC: 1 })) {
      await api("ascan", "action", `setOption${option}`, { Integer: String(value) });
    }
    await api("ascan", "action", "setOptionAddQueryParam", { Boolean: "false" });
    const contextId = String((await api("context", "action", "newContext", { contextName: "manual-local" })).contextId);
    for (const { seed } of targets) await api("context", "action", "includeInContext", { contextName: "manual-local", regex: `${escape(activePolicy.origin + seed.path.split("?")[0])}(?:\\?zap=[^#]*)?` });
    await api("context", "action", "setContextInScope", { contextName: "manual-local", booleanInScope: "true" });
    for (const { seed, session, verify, render } of targets) {
      result.step = "scan";
      if (Date.now() >= deadline) throw new Error("active-budget");
      const before = await session();
      if (!before) throw new Error("active-session-lost");
      gate.select(seed);
      const start = { ...gate.stats };
      await resetExcludedParams(api);
      if (seed.method === "POST") for (const name of multipart(seed.body, seed.headers["content-type"]).keys()) {
        if (name !== seed.field) await api("ascan", "action", "addExcludedParam", { name: escape(name), url: `${activePolicy.origin}${seed.path}` });
      }
      const seedHeaders: Record<string, string> = { ...seed.headers, host: "localhost:3102", "content-length": String(Buffer.byteLength(seed.body)), connection: "close" };
      const raw = `${seed.method} ${activePolicy.origin}${seed.path} HTTP/1.1\r\n${Object.entries(seedHeaders).filter(([name]) => !["transfer-encoding", "accept-encoding"].includes(name)).map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n${seed.body}`;
      await api("core", "action", "sendRequest", { request: raw, followRedirects: "false" });
      if (!gate.stats.seedSuccess) throw new Error("active-coverage");
      if (probe === "budget") {
        // Реальная вторая попытка через ZAP проверяет отказ ДО upstream.
        // Не ждём polling native scan, чтобы hard-limit не зависел от него.
        await api("core", "action", "sendRequest", { request: raw.replace("?zap=baseline", "?zap=budget-probe"), followRedirects: "false" });
        if (gate.stats.requests !== 1 || !gate.stats.exhausted || !gate.stats.rejected) throw new Error("active-infrastructure");
        throw new Error("active-budget");
      }
      scanId = String((await startSeededScan({ url: activePolicy.origin + seed.path, recurse: "false", inScopeOnly: "true", contextId, scanPolicyName: policy, method: seed.method, ...(seed.method === "POST" ? { postData: seed.body } : {}) }, api)).scan);
      if (!/^\d+$/.test(scanId)) throw new Error("active-infrastructure");
      while (!nativeScanFinished((await api("ascan", "view", "scans")).scans, scanId)) {
        if (gate.stats.exhausted || Date.now() >= deadline) throw new Error("active-budget");
        if (gate.stats.redirect || !(await session())) throw new Error("active-session-lost");
        await sleep(1000);
      }
      const progress = await api("ascan", "view", "scanProgress", { scanId });
      const rules: NonNullable<ActiveRun["targets"][number]["rules"]> = [];
      const visit = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value) && (value[1] === "40012" || value[1] === "40018") && typeof value[3] === "string") {
          rules.push({ id: value[1], requests: Number(value[5]), state: value[3] === "Complete" ? "complete" : value[3].startsWith("Skipped") ? "skipped" : "other" });
        }
        const record = value as Record<string, unknown>;
        if ((record.id === "40012" || record.id === "40018") && typeof record.status === "string") rules.push({ id: record.id, requests: Number(record.reqCount), state: record.status === "Complete" ? "complete" : record.status.startsWith("Skipped") ? "skipped" : "other" });
        for (const child of Object.values(record)) visit(child);
      };
      visit(progress);
      scanId = undefined;
      if (Date.now() >= deadline) throw new Error("active-budget");
      const after = await session();
      const item: ActiveRun["targets"][number] = { role: seed.role, operation: seed.operation, requests: gate.stats.requests - start.requests, mutations: gate.stats.mutations - start.mutations,
        successfulMutations: gate.stats.successfulMutations - start.successfulMutations, sessionBefore: before, sessionAfter: after,
        seedStatus: gate.stats.seedStatus, seedSuccess: gate.stats.seedSuccess, rules };
      result.targets.push(item);
      if (!after || gate.stats.redirect) throw new Error("active-session-lost");
      if (gate.stats.exhausted) throw new Error("active-budget");
      if (!item.mutations || !item.successfulMutations) throw new Error("active-coverage");
      if (!activePolicy.rules.every(id => item.rules?.filter(rule => rule.id === id && rule.state === "complete" && rule.requests > 0).length === 1)) throw new Error("active-coverage");
      if (verify && render) {
        item.persisted = await verify(gate.acceptedValue());
        if (!item.persisted) throw new Error("active-coverage");
        renderChecks.push(async () => { item.rendered = await render(); if (!item.rendered) throw new Error("active-coverage"); });
      }
    }
    gate.closeGate();
    result.seedPhase = "render";
    for (const check of renderChecks) await check();
    for (const { session } of targets) if (!(await session())) throw new Error("active-session-lost");
    result.step = "report";
    let pending = -1;
    const drain = Math.min(Date.now() + 180_000, deadline);
    do { pending = Number((await api("pscan", "view", "recordsToScan")).recordsToScan); if (!pending) break; await sleep(500); } while (Date.now() < drain);
    if (pending !== 0) throw new Error("active-queue");
    const count = Number((await api("core", "view", "numberOfMessages")).numberOfMessages);
    if (!Number.isInteger(count) || count > 20_000) throw new Error("active-infrastructure");
    const subjects = new Map();
    for (let start = 0; start < count; start += 50) {
      const messages = (await api("core", "view", "messages", { start: String(start), count: "50" })).messages as Message[];
      for (const message of messages) if (/^host:\s*localhost:3102\s*$/im.test(message.requestHeader)) {
        // Gate-origin — технический транспорт. Роли/Action берутся из seed,
        // а не угадываются по атакующему body; query остаётся несопоставимым.
        subjects.set(String(message.id), safeSubject({ ...message, requestHeader: message.requestHeader.replaceAll("localhost:3102", "localhost:3100") }, actionNames, scenarios));
      }
    }
    const rawAlerts: RawAlert[] = [];
    for (let start = 0; start < 20_000; start += 100) {
      const page = (await api("core", "view", "alerts", { baseurl: activePolicy.origin, start: String(start), count: "100" })).alerts as RawAlert[];
      if (!Array.isArray(page)) throw new Error("active-infrastructure");
      rawAlerts.push(...page);
      if (page.length < 100) break;
      if (start === 19_900) throw new Error("active-infrastructure");
    }
    for (const alert of rawAlerts) {
      const id = String(alert.messageId);
      if (!/^\d+$/.test(id)) throw new Error("active-infrastructure");
      if (!subjects.has(id)) {
        // Временные active messages могут отсутствовать в обычной History.
        // Alert нельзя молча потерять из-за отсутствия subject в первой выборке.
        const message = (await api("core", "view", "message", { id })).message as Message;
        if (!message || !/^host:\s*localhost:3102\s*$/im.test(message.requestHeader)) throw new Error("active-infrastructure");
        subjects.set(id, safeSubject({ ...message, requestHeader: message.requestHeader.replaceAll("localhost:3102", "localhost:3100") }, actionNames, scenarios));
      }
    }
    result.controlFound = control && rawAlerts.some(alert => String(alert.sourceid) === "1" && String(alert.pluginId) === "40012");
    if (control && !result.controlFound) throw new Error("active-coverage");
    const passive = JSON.parse(await readFile(`${output}/phase-a.json`, "utf8"));
    // Отдельный scope и отсутствие passive baseline/исключений: две фазы и
    // active/passive source никогда не сливаются в историю CI-пилота.
    for (const source of ["active", "passive"] as const) {
      const findings = sanitizeAlerts(rawAlerts.filter(alert => String(alert.sourceid) === (source === "active" ? "1" : "0")), subjects);
      const policy = readPolicy({ version: 1, decisions: [] }, new Date(started).toISOString().slice(0, 10));
      const report = buildReport({ ...passive.run, status: "completed", startedAt: new Date(started).toISOString(), scope: hash([activePolicy, source, control]), policyDigest: policy.digest }, findings, policy);
      await writeFile(`${output}/phase-b-${source}.json`, JSON.stringify(report));
    }
    result.phaseB = "completed"; result.status = "completed"; result.step = "finished";
  } catch (error) {
    result.failureClass = error instanceof Error && error.name === "TimeoutError" ? "timeout" : error instanceof Error && "matcherResult" in error ? "assertion" : "other";
    const message = error instanceof Error ? error.message : "";
    const site = error instanceof Error ? /\/(active\.e2e|active-api|report)\.ts:(\d{1,4}):/.exec(error.stack ?? "") : null;
    if (site) result.failureSite = `${site[1]}.ts:${site[2]}`;
    result.failureHint = message === "invalid-api-response" || message === "api-size-limit" || message === "active-infrastructure" ? message : "unclassified";
    if (error instanceof ZapApiError) result.apiCode = error.code;
    const known = ["active-precondition-failed", "active-budget", "active-session-lost", "active-coverage", "active-queue"] as const;
    const reason = message === "active-body-refused" || message === "active-target-refused" ? "active-wire-format" : known.find(reason => reason === message) ?? "active-infrastructure";
    result.reasons = [reason]; result.status = reason === "active-infrastructure" ? "error" : "incomplete"; result.phaseB = result.status;
  } finally {
    gate.closeGate();
    if (scanId) await api("ascan", "action", "stop", { scanId }).catch(() => {});
    await gate.close();
    if (training) { training.closeAllConnections(); await new Promise<void>(resolve => training!.close(() => resolve())); }
    for (const context of contexts) await context.close();
    await db?.$disconnect();
    result.requests = gate.stats.requests; result.rejected = gate.stats.rejected; result.durationMs = Date.now() - started;
    await writeFile(`${output}/manual.json`, JSON.stringify(activeRunSchema.parse(result), null, 2));
  }
  expect(result.status).toBe("completed");
});
