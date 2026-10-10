/** Состояния записи; boolean сохранён как совместимый кеш для AI. */
export const ITEM_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "DEFERRED", "COMPLETED"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

type StatusInput = { isCompleted: boolean; status?: ItemStatus };

/** Старый клиент меняет только отметку: устаревший COMPLETED не должен её возвращать. */
export function getItemStatus(item: StatusInput): ItemStatus {
  if (item.isCompleted) return "COMPLETED";
  return item.status === "IN_PROGRESS" || item.status === "DEFERRED" ? item.status : "NOT_STARTED";
}

/** Родитель завершён только целиком; частично сделанный блок уже начат. */
export function deriveParentStatus(children: readonly StatusInput[]): ItemStatus {
  if (children.length === 0) return "NOT_STARTED";
  const statuses = children.map(getItemStatus);
  const remaining = statuses.filter((status) => status !== "COMPLETED");
  if (remaining.length === 0) return "COMPLETED";
  if (remaining.every((status) => status === "DEFERRED")) return "DEFERRED";
  return remaining.includes("IN_PROGRESS") || statuses.includes("COMPLETED")
    ? "IN_PROGRESS"
    : "NOT_STARTED";
}
