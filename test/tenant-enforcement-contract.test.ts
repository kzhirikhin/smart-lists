import { readFileSync } from "node:fs";
import { EXPECTED_ENUM_TYPES } from "../scripts/database-role-contract.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  identifyEnforcementProfile,
  parseEnforcementArguments,
  resolveEnforcementTransition,
} from "../scripts/configure-tenant-enforcement.mjs";

describe("tenant enforcement contract", () => {
  it("реально запускает CLI из пути с пробелами", () => {
    const scriptPath = fileURLToPath(
      new URL("../scripts/configure-tenant-enforcement.mjs", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [scriptPath, "--operation=unknown"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Неизвестная enforcement operation");
  });

  it("принимает только восемь именованных операций и явный apply", () => {
    expect(
      parseEnforcementArguments([
        "--apply",
        "--operation=enable-usage-canary",
      ]),
    ).toEqual({ apply: true, operation: "enable-usage-canary" });
    expect(
      parseEnforcementArguments(["--operation=rollback-usage-canary"]),
    ).toEqual({ apply: false, operation: "rollback-usage-canary" });
    expect(
      parseEnforcementArguments(["--operation=enable-list-item"]),
    ).toEqual({ apply: false, operation: "enable-list-item" });
    expect(
      parseEnforcementArguments(["--operation=rollback-list-item"]),
    ).toEqual({ apply: false, operation: "rollback-list-item" });
    expect(
      parseEnforcementArguments(["--operation=enable-space-groups"]),
    ).toEqual({ apply: false, operation: "enable-space-groups" });
    expect(
      parseEnforcementArguments(["--operation=rollback-space-groups"]),
    ).toEqual({ apply: false, operation: "rollback-space-groups" });
    expect(
      parseEnforcementArguments(["--operation=enable-tenant-full"]),
    ).toEqual({ apply: false, operation: "enable-tenant-full" });
    expect(
      parseEnforcementArguments(["--operation=rollback-tenant-full"]),
    ).toEqual({ apply: false, operation: "rollback-tenant-full" });

    expect(() => parseEnforcementArguments([])).toThrow("ровно один");
    expect(() =>
      parseEnforcementArguments(["--operation=enable-all"]),
    ).toThrow("Неизвестная enforcement operation");
    expect(() =>
      parseEnforcementArguments([
        "--operation=enable-usage-canary",
        "--environment=Production",
      ]),
    ).toThrow("Неизвестные аргументы");
  });

  it("распознаёт только пять последовательных rollout-профилей", () => {
    expect(identifyEnforcementProfile([], [])).toBe("disabled");
    expect(
      identifyEnforcementProfile(["UserDailyUsage"], ["UserDailyUsage"]),
    ).toBe("usage-canary");
    expect(
      identifyEnforcementProfile(
        ["Item", "List", "UserDailyUsage"],
        ["UserDailyUsage", "List", "Item"],
      ),
    ).toBe("list-item");
    expect(
      identifyEnforcementProfile(
        [
          "Space",
          "ListGroup",
          "_ListGroupMembers",
          "Item",
          "List",
          "UserDailyUsage",
        ],
        [
          "UserDailyUsage",
          "List",
          "Item",
          "Space",
          "ListGroup",
          "_ListGroupMembers",
        ],
      ),
    ).toBe("space-groups");
    expect(
      identifyEnforcementProfile(
        [
          "Attachment",
          "ListShare",
          "Space",
          "ListGroup",
          "_ListGroupMembers",
          "Item",
          "List",
          "UserDailyUsage",
        ],
        [
          "UserDailyUsage",
          "List",
          "Item",
          "Space",
          "ListGroup",
          "_ListGroupMembers",
          "ListShare",
          "Attachment",
        ],
      ),
    ).toBe("tenant-full");

    expect(() => identifyEnforcementProfile(["Space"], ["Space"])).toThrow(
      "не соответствует известному rollout-профилю",
    );
    expect(() =>
      identifyEnforcementProfile(["UserDailyUsage"], []),
    ).toThrow("не соответствует известному rollout-профилю");
    expect(() =>
      identifyEnforcementProfile(
        ["UserDailyUsage", "List", "Item"],
        ["UserDailyUsage", "List"],
      ),
    ).toThrow("не соответствует известному rollout-профилю");
  });

  it("делает линейные enable/rollback идемпотентными, не перепрыгивая профили", () => {
    expect(resolveEnforcementTransition("enable-usage-canary", "disabled"))
      .toEqual({
        targetProfile: "usage-canary",
        changed: true,
        tables: ["UserDailyUsage"],
      });
    expect(
      resolveEnforcementTransition("enable-usage-canary", "usage-canary"),
    ).toMatchObject({ targetProfile: "usage-canary", changed: false });
    expect(
      resolveEnforcementTransition("rollback-usage-canary", "usage-canary"),
    ).toEqual({ targetProfile: "disabled", changed: true, tables: [] });
    expect(resolveEnforcementTransition("rollback-usage-canary", "disabled"))
      .toMatchObject({ targetProfile: "disabled", changed: false });

    expect(resolveEnforcementTransition("enable-list-item", "usage-canary"))
      .toEqual({
        targetProfile: "list-item",
        changed: true,
        tables: ["UserDailyUsage", "List", "Item"],
      });
    expect(resolveEnforcementTransition("enable-list-item", "list-item"))
      .toMatchObject({ targetProfile: "list-item", changed: false });
    expect(resolveEnforcementTransition("rollback-list-item", "list-item"))
      .toEqual({
        targetProfile: "usage-canary",
        changed: true,
        tables: ["UserDailyUsage"],
      });
    expect(resolveEnforcementTransition("rollback-list-item", "usage-canary"))
      .toMatchObject({ targetProfile: "usage-canary", changed: false });

    expect(resolveEnforcementTransition("enable-space-groups", "list-item"))
      .toEqual({
        targetProfile: "space-groups",
        changed: true,
        tables: [
          "UserDailyUsage",
          "List",
          "Item",
          "Space",
          "ListGroup",
          "_ListGroupMembers",
        ],
      });
    expect(resolveEnforcementTransition("enable-space-groups", "space-groups"))
      .toMatchObject({ targetProfile: "space-groups", changed: false });
    expect(resolveEnforcementTransition("rollback-space-groups", "space-groups"))
      .toEqual({
        targetProfile: "list-item",
        changed: true,
        tables: ["UserDailyUsage", "List", "Item"],
      });
    expect(resolveEnforcementTransition("rollback-space-groups", "list-item"))
      .toMatchObject({ targetProfile: "list-item", changed: false });

    expect(resolveEnforcementTransition("enable-tenant-full", "space-groups"))
      .toEqual({
        targetProfile: "tenant-full",
        changed: true,
        tables: [
          "UserDailyUsage",
          "List",
          "Item",
          "Space",
          "ListGroup",
          "_ListGroupMembers",
          "ListShare",
          "Attachment",
        ],
      });
    expect(resolveEnforcementTransition("enable-tenant-full", "tenant-full"))
      .toMatchObject({ targetProfile: "tenant-full", changed: false });
    expect(resolveEnforcementTransition("rollback-tenant-full", "tenant-full"))
      .toEqual({
        targetProfile: "space-groups",
        changed: true,
        tables: [
          "UserDailyUsage",
          "List",
          "Item",
          "Space",
          "ListGroup",
          "_ListGroupMembers",
        ],
      });
    expect(resolveEnforcementTransition("rollback-tenant-full", "space-groups"))
      .toMatchObject({ targetProfile: "space-groups", changed: false });

    expect(() =>
      resolveEnforcementTransition("enable-list-item", "disabled"),
    ).toThrow("запрещена из профиля disabled");
    expect(() =>
      resolveEnforcementTransition("rollback-usage-canary", "list-item"),
    ).toThrow("запрещена из профиля list-item");
    expect(() =>
      resolveEnforcementTransition("enable-space-groups", "usage-canary"),
    ).toThrow("запрещена из профиля usage-canary");
    expect(() =>
      resolveEnforcementTransition("rollback-list-item", "space-groups"),
    ).toThrow("запрещена из профиля space-groups");
    expect(() =>
      resolveEnforcementTransition("enable-tenant-full", "list-item"),
    ).toThrow("запрещена из профиля list-item");
    expect(() =>
      resolveEnforcementTransition("rollback-space-groups", "tenant-full"),
    ).toThrow("запрещена из профиля tenant-full");
  });
});


it("enum-инвентарь операционных ролей совпадает с Prisma-схемой", () => {
  // Источник набора — схема: новый enum не должен ломать конфигуратор лишь
  // в интеграционном прогоне, оставаясь невидимым для статического gate.
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const enumNames = [...schema.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((match) => match[1]);
  expect(enumNames.length).toBeGreaterThan(0);
  expect([...EXPECTED_ENUM_TYPES].sort()).toEqual(enumNames.sort());
});
