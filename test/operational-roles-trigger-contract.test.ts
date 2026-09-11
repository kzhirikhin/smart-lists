import { describe, expect, it } from "vitest";

import {
  EXPECTED_TRIGGERS,
  GUARD_NAME,
  PROFILE_TABLES,
  TENANT_TABLES,
  assertTriggerInventory,
} from "../scripts/database-role-contract.mjs";

// Строки контракта имеют вид `таблица:триггер:функция:состояние`.
type Trigger = {
  table: string;
  name: string;
  function: string;
  enabled: string;
};

const parse = (row: string): Trigger => {
  const [table, name, fn, enabled] = row.split(":");
  return { table, name, function: fn, enabled };
};

// Каталог собирается из самого контракта: guard-триггеры включаются ровно на
// таблицах профиля. Так тест ломается, если в контракт добавят триггер, а
// список профилей забудут, — в отличие от каталога, выписанного руками.
function catalogForProfile(profile: string) {
  const enabled = new Set(PROFILE_TABLES[profile as keyof typeof PROFILE_TABLES]);
  const triggers = EXPECTED_TRIGGERS.map(parse).map((trigger) =>
    trigger.name === GUARD_NAME
      ? { ...trigger, enabled: enabled.has(trigger.table) ? "O" : "D" }
      : trigger,
  );
  return { triggers, rlsEnabled: [...enabled] };
}

describe("контракт триггеров конфигуратора ролей", () => {
  const profiles = Object.keys(PROFILE_TABLES);

  it("знает те же профили, что и модель rollout", () => {
    expect(profiles.length).toBeGreaterThan(1);
    expect(profiles).toContain("disabled");
    expect(profiles).toContain("tenant-full");
  });

  it.each(profiles)("принимает базу в профиле %s", (profile) => {
    const { triggers, rlsEnabled } = catalogForProfile(profile);
    expect(assertTriggerInventory(triggers, rlsEnabled)).toBe(profile);
  });

  it("отвергает включённый guard без RLS на той же таблице", () => {
    const { triggers } = catalogForProfile("tenant-full");
    expect(() => assertTriggerInventory(triggers, [])).toThrow(
      /не соответствует известному rollout-профилю/,
    );
  });

  it("отвергает набор таблиц вне ступеней rollout", () => {
    const { triggers } = catalogForProfile("disabled");
    const partial = triggers.map((trigger) =>
      trigger.name === GUARD_NAME && trigger.table === "ListShare"
        ? { ...trigger, enabled: "O" }
        : trigger,
    );
    expect(() => assertTriggerInventory(partial, ["ListShare"])).toThrow(
      /не соответствует известному rollout-профилю/,
    );
  });

  it("отвергает RLS вне tenant-контура", () => {
    const { triggers, rlsEnabled } = catalogForProfile("disabled");
    expect(() => assertTriggerInventory(triggers, [...rlsEnabled, "Session"])).toThrow(
      /RLS неожиданно включён вне tenant-контура/,
    );
  });

  it("отвергает неизвестное состояние guard-триггера", () => {
    const { triggers, rlsEnabled } = catalogForProfile("disabled");
    const replicaGuard = triggers.map((trigger) =>
      trigger.name === GUARD_NAME && trigger.table === "Item"
        ? { ...trigger, enabled: "R" }
        : trigger,
    );
    expect(() => assertTriggerInventory(replicaGuard, rlsEnabled)).toThrow(
      /Неожиданное состояние guard-триггера Item/,
    );
  });

  it("отвергает лишний триггер", () => {
    const { triggers, rlsEnabled } = catalogForProfile("disabled");
    const extra = [
      ...triggers,
      { table: "Item", name: "app_extra", function: "app_extra", enabled: "O" },
    ];
    expect(() => assertTriggerInventory(extra, rlsEnabled)).toThrow(/Триггеры/);
  });

  it("отвергает выключенный аудит-триггер, в каком бы профиле база ни была", () => {
    const { triggers, rlsEnabled } = catalogForProfile("tenant-full");
    const disabledAudit = triggers.map((trigger) =>
      trigger.name === "app_audit_global_admin_change"
        ? { ...trigger, enabled: "D" }
        : trigger,
    );
    expect(() => assertTriggerInventory(disabledAudit, rlsEnabled)).toThrow(
      /Состояние always-on триггеров/,
    );
  });

  it("покрывает guard-ами весь tenant-контур", () => {
    const guarded = EXPECTED_TRIGGERS.map(parse)
      .filter((trigger) => trigger.name === GUARD_NAME)
      .map((trigger) => trigger.table);
    expect([...guarded].sort()).toEqual([...TENANT_TABLES].sort());
  });
});
