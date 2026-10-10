import { describe, expect, it } from "vitest";
import { deriveParentStatus, getItemStatus, type ItemStatus } from "@/lib/item-status";

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


describe("отложенная работа", () => {
  it("читает отложенное состояние, но завершённость имеет приоритет", () => {
    expect(getItemStatus({ isCompleted: false, status: "DEFERRED" })).toBe("DEFERRED");
    expect(getItemStatus({ isCompleted: true, status: "DEFERRED" })).toBe("COMPLETED");
  });
  it.each<[ItemStatus, ItemStatus, ItemStatus]>([
    ["DEFERRED", "DEFERRED", "DEFERRED"],
    ["COMPLETED", "DEFERRED", "DEFERRED"],
    ["DEFERRED", "NOT_STARTED", "NOT_STARTED"],
    ["DEFERRED", "IN_PROGRESS", "IN_PROGRESS"],
  ])("%s + %s дают %s независимо от порядка", (a, b, expected) => {
    const children = [a, b].map(status => ({ status, isCompleted: status === "COMPLETED" }));
    expect(deriveParentStatus(children)).toBe(expected);
    expect(deriveParentStatus(children.reverse())).toBe(expected);
  });
});
