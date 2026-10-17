import { describe, expect, it } from "vitest";
import { activePolicy, activeRunSchema, admitMutation, assertActiveTarget, canonicalMultipart, multipart, summarizePassive, type ActiveTarget } from "./active-policy";

const form = (title: string, space = "space_test") => `--zapBoundary\r\nContent-Disposition: form-data; name="1_title"\r\n\r\n${title}\r\n--zapBoundary\r\nContent-Disposition: form-data; name="1_spaceId"\r\n\r\n${space}\r\n--zapBoundary--\r\n`;
const target: ActiveTarget = { role: "owner", operation: "createList", path: "/en/spaces/space_test", method: "POST", field: "1_title", body: form("seed"), headers: { "content-type": "multipart/form-data; boundary=zapBoundary", "next-action": "a".repeat(40), cookie: "authjs.session-token=synthetic" } };

describe("ограничения активной фазы", () => {
  it("сохраняет safe причину неполной фазы A без текста ошибки и приватных полей", () => {
    const summary = summarizePassive({ status: "incomplete", pending: 0, requests: 20, coverage: [{ id: "notes", passed: false, complete: false }], reasons: ["coverage:notes", "PRIVATE_TOKEN"], error: "PRIVATE_TOKEN" });
    expect(summary.failedScenarios).toEqual(["notes"]);
    expect(summary.reasons).toEqual(["coverage", "other"]);
    expect(JSON.stringify(summary)).not.toContain("PRIVATE_TOKEN");
  });
  it("разрешает изменение только текстового поля реального Action", () => {
    expect(() => assertActiveTarget(target)).not.toThrow();
    expect(multipart(target.body.slice(0, -2), target.headers["content-type"]).get("1_title")).toBe("seed");
    expect(admitMutation(target, "POST", target.path, form("<script>alert(1)</script>"), target.headers["content-type"])).toEqual({ allowed: true, mutated: true });
    expect(admitMutation(target, "POST", target.path, form("seed", "other_space"), target.headers["content-type"]).allowed).toBe(false);
    expect(admitMutation(target, "POST", "/api/auth/signout", target.body, target.headers["content-type"]).allowed).toBe(false);
    expect(admitMutation(target, "POST", target.path, target.body, "application/json").allowed).toBe(false);
    expect(admitMutation(target, "DELETE", target.path, target.body, target.headers["content-type"]).allowed).toBe(false);
  });
  it("нормализует только boundary, сохраняя имена/значения и проверяя коллизии", () => {
    const normalized = canonicalMultipart(target.body, target.headers["content-type"]);
    expect(normalized.contentType).toBe("multipart/form-data; boundary=zapmanualboundary");
    expect([...multipart(normalized.body, normalized.contentType)]).toEqual([...multipart(target.body, target.headers["content-type"])]);
    expect(() => canonicalMultipart(form("--zapmanualboundary"), target.headers["content-type"])).toThrow();
  });
  it.each(["https://smart-lists-iota.vercel.app/en", "http://localhost:3000/en", "//localhost:3100/en", "/en/spaces/a%2fb", "/en/spaces/a#x"])("отказывает target %s", path => {
    expect(() => assertActiveTarget({ ...target, path })).toThrow();
  });
  it("отказывает неизвестному Action, cookie и body format", () => {
    expect(() => assertActiveTarget({ ...target, operation: "addItem" })).toThrow();
    expect(() => assertActiveTarget({ ...target, headers: { ...target.headers, cookie: "" } })).toThrow();
    expect(() => multipart(target.body.replace('name="1_title"', 'filename="private"'), target.headers["content-type"])).toThrow();
    expect(() => multipart(target.body.replace("1_spaceId", "1_title"), target.headers["content-type"])).toThrow();
    expect(admitMutation(target, "POST", target.path, "x".repeat(activePolicy.maxBodyBytes + 1), target.headers["content-type"]).allowed).toBe(false);
  });
  it("публичный вход не допускает перехода на другой origin, путь и новый параметр", () => {
    const publicTarget: ActiveTarget = { role: "anonymous", operation: "none", path: "/en?zap=baseline", field: "zap", method: "GET", headers: {}, body: "" };
    expect(() => assertActiveTarget(publicTarget)).not.toThrow();
    expect(admitMutation(publicTarget, "GET", "/en?zap=attack", "", "")).toEqual({ allowed: true, mutated: true });
    for (const path of ["http://outside.test/en?zap=a", "//outside.test/en?zap=a", "/api/auth/signout?zap=a", "/en?zap=a&other=b"]) expect(admitMutation(publicTarget, "GET", path, "", "").allowed).toBe(false);
  });
  it("диагностика не принимает произвольные URL, error или body", () => {
    expect(activeRunSchema.safeParse({ status: "completed", url: "private" }).success).toBe(false);
    expect(activePolicy.rules).toEqual(["40012", "40018"]);
  });
});
