import { describe, expect, it } from "vitest";
import { evaluatePilot, summarizeMessage, type Traffic } from "./evaluate";

const expected = [{ id: "share", auth: true, posts: 1, secondContext: true }];
const tests = [{ id: "share", status: "passed" }];
const primary: Traffic = { scenario: "share", context: 1, authenticated: true, space: true, action: true, actionName: "addItem", html: true };
const traffic = [primary, { ...primary, context: 2 }];

describe("приёмка пассивного пилота", () => {
  it("требует успешный сценарий и трафик обоих участников", () => {
    expect(evaluatePilot(expected, tests, traffic, 0, true).status).toBe("completed");
    expect(evaluatePilot(expected, tests, [primary], 0, true).status).toBe("incomplete");
  });
  it("не принимает пустой выбор, отказ прокси, потерю сессии и очередь", () => {
    expect(evaluatePilot([], [], [], 0, true).reasons).toContain("empty-selection");
    expect(evaluatePilot(expected, tests, [], 0, false).reasons).toContain("scenario-process-failed");
    expect(evaluatePilot(expected, tests, traffic.map((item) => ({ ...item, authenticated: false })), 0, true).status).toBe("incomplete");
    for (const pending of [1, -1, NaN]) expect(evaluatePilot(expected, tests, traffic, pending, true).status).toBe("incomplete");
  });
  it("HTTP 200 не заменяет результат теста и неизвестный тест не теряется", () => {
    expect(evaluatePilot(expected, [{ id: "share", status: "failed" }], traffic, 0, true).status).toBe("incomplete");
    expect(evaluatePilot(expected, [...tests, { id: "unknown", status: "passed" }], traffic, 0, true).reasons).toContain("unmapped-tests");
  });
  it("переключение пространств требует трафика двух разных пространств", () => {
    const scenario = [{ id: "spaces-switch", auth: true, posts: 0 }];
    const results = [{ id: "spaces-switch", status: "passed" }];
    const messages = [{ ...primary, scenario: "spaces-switch", spaceKey: "/en/spaces/one" }];
    expect(evaluatePilot(scenario, results, messages, 0, true).status).toBe("incomplete");
    expect(evaluatePilot(scenario, results, [...messages, { ...messages[0], spaceKey: "/en/spaces/two" }], 0, true).status).toBe("completed");
  });
  it("посторонний Action не заменяет ожидаемую мутацию", () => {
    const scenario = [{ id: "share", auth: true, posts: 1, actions: ["shareList"] }];
    expect(evaluatePilot(scenario, tests, traffic, 0, true).status).toBe("incomplete");
    expect(evaluatePilot(scenario, tests, [{ ...primary, actionName: "shareList" }, traffic[1]], 0, true).status).toBe("completed");
  });
  it("отличает серверный Action от GET и не сохраняет cookie", () => {
    const message = summarizeMessage("POST /en/spaces/test HTTP/1.1\r\nHost: localhost:3100\r\nX-Zap-Pilot-Test: share\r\nX-Zap-Pilot-Context: 2\r\nCookie: authjs.session-token=DO-NOT-PUBLISH\r\nNext-Action: opaque\r\n", "HTTP/1.1 200 OK\r\nContent-Type: text/x-component\r\n");
    expect(message).toMatchObject({ context: 2, authenticated: true, action: true, html: false });
    expect(JSON.stringify(message)).not.toContain("DO-NOT-PUBLISH");
    expect(summarizeMessage("GET / HTTP/1.1\r\nHost: external.test\r\n", "HTTP/1.1 200 OK")).toBeUndefined();
  });
});
