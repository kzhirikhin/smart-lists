export type Scenario = { id: string; auth: boolean; posts: number; secondContext?: boolean; actions?: readonly string[] };
export type TestResult = { id: string; status: string; durationMs?: number };
export type Traffic = { scenario: string; context: number; authenticated: boolean; space: boolean; spaceKey?: string; action: boolean; actionName?: string; html: boolean };

/** Обрабатывает только безопасные счётчики: сырой трафик сюда не передаётся. */
export function evaluatePilot(expected: readonly Scenario[], tests: TestResult[], traffic: Traffic[], pending: number, processOk: boolean) {
  const reasons: string[] = [];
  if (!expected.length || !tests.length) reasons.push("empty-selection");
  if (!processOk) reasons.push("scenario-process-failed");
  if (!Number.isInteger(pending) || pending !== 0) reasons.push("passive-queue-not-drained");
  const coverage = expected.map((scenario) => {
    const results = tests.filter((test) => test.id === scenario.id);
    const messages = traffic.filter((message) => message.scenario === scenario.id);
    const primary = messages.filter((message) => message.context === 1);
    const secondary = messages.filter((message) => message.context === 2);
    const passed = results.length === 1 && results[0].status === "passed";
    const authenticated = primary.some((message) => message.authenticated && message.space && message.html);
    const actions = primary.filter((message) => message.action && (!scenario.auth || message.authenticated)).length;
    const actionNames = [...new Set(primary.filter((message) => message.action && message.authenticated).map((message) => message.actionName).filter((name): name is string => Boolean(name)))].sort();
    const expectedActions = (scenario.actions ?? []).every((name) => actionNames.includes(name));
    const spaces = new Set(primary.filter((message) => message.authenticated && message.space).map((message) => message.spaceKey).filter(Boolean)).size;
    const distinctSpaces = !["spaces-switch", "spaces-create", "groups-isolation"].includes(scenario.id) || spaces >= 2;
    const second = !scenario.secondContext || secondary.some((message) => message.authenticated && message.space && message.html);
    const secondAction = scenario.id !== "share" || secondary.some((message) => message.authenticated && message.action && message.actionName === "addItem");
    const complete = passed && primary.some((message) => message.html) && (!scenario.auth || authenticated) && actions >= scenario.posts && expectedActions && second && secondAction && distinctSpaces;
    if (!complete) reasons.push(`coverage:${scenario.id}`);
    return {
      id: scenario.id, passed, requests: messages.length,
      contexts: new Set(messages.map((message) => message.context)).size,
      actions, actionNames, authenticated, spaces,
      secondContext: scenario.secondContext ? second : null,
      secondAction: scenario.id === "share" ? secondAction : null,
      complete,
    };
  });
  if (tests.some((test) => !expected.some((scenario) => scenario.id === test.id))) reasons.push("unmapped-tests");
  return { status: reasons.length ? "incomplete" : "completed", reasons, coverage };
}

/** Только локальные запросы пилота с техническими метками; значения cookie не сохраняются. */
export function summarizeMessage(requestHeader: string, responseHeader: string, actionNames: Record<string, string> = {}): Traffic | undefined {
  const scenario = /^x-zap-pilot-test:\s*([a-z-]+)\s*$/im.exec(requestHeader)?.[1];
  const context = Number(/^x-zap-pilot-context:\s*(\d+)\s*$/im.exec(requestHeader)?.[1]);
  const target = /^(GET|POST) (\S+) HTTP\//.exec(requestHeader);
  const host = /^host:\s*localhost:3100\s*$/im.test(requestHeader);
  if (!scenario || !context || !target || !host) return;
  const success = /^HTTP\/\S+ (?:200|303|307)\b/.test(responseHeader);
  const path = new URL(target[2], "http://localhost:3100").pathname;
  return {
    scenario, context,
    authenticated: /^cookie:.*(?:^|[;\s])authjs\.session-token=[^;\s]+/im.test(requestHeader),
    space: /^\/(en|ru|vi|ja)\/spaces\/[^/]+$/.test(path) && success,
    // Сырые ID используются только в памяти для числа разных пространств.
    spaceKey: /^\/(en|ru|vi|ja)\/spaces\/[^/]+$/.test(path) ? path : undefined,
    action: target[1] === "POST" && success && (/^next-action:/im.test(requestHeader) || /^content-type:\s*multipart\/form-data/im.test(requestHeader)),
    actionName: actionNames[/^next-action:\s*(\S+)/im.exec(requestHeader)?.[1] ?? ""],
    html: /^HTTP\/\S+ 200\b/.test(responseHeader) && /^content-type:\s*text\/html/im.test(responseHeader),
  };
}
