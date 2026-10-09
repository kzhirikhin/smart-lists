import { describe, expect, it } from "vitest";
import { deriveParentStatus, getItemStatus } from "@/lib/item-status";

describe("состояние записи и совместимость", () => {
  it("читает старые отметки и игнорирует устаревший кеш статуса", () => {
    expect(getItemStatus({ isCompleted: false })).toBe("NOT_STARTED");
    expect(getItemStatus({ isCompleted: true })).toBe("COMPLETED");
    expect(getItemStatus({ isCompleted: false, status: "IN_PROGRESS" })).toBe("IN_PROGRESS");
    expect(getItemStatus({ isCompleted: false, status: "COMPLETED" })).toBe("NOT_STARTED");
  });
  it("выводит состояние блока из подпунктов", () => {
    expect(deriveParentStatus([])).toBe("NOT_STARTED");
    expect(deriveParentStatus([{ isCompleted: false }])).toBe("NOT_STARTED");
    expect(deriveParentStatus([{ isCompleted: true }, { isCompleted: false }])).toBe("IN_PROGRESS");
    expect(deriveParentStatus([{ isCompleted: false, status: "IN_PROGRESS" }])).toBe("IN_PROGRESS");
    expect(deriveParentStatus([{ isCompleted: true }])).toBe("COMPLETED");
  });
});
