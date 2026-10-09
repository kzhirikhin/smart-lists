/** Три состояния записи; boolean сохранён как совместимый кеш для AI. */
export const ITEM_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

type StatusInput = { isCompleted: boolean; status?: ItemStatus };

/** Старый клиент меняет только отметку: устаревший COMPLETED не должен её возвращать. */
export function getItemStatus(item: StatusInput): ItemStatus {
  if (item.isCompleted) return "COMPLETED";
  return item.status === "IN_PROGRESS" ? "IN_PROGRESS" : "NOT_STARTED";
}

/** Родитель завершён только целиком; частично сделанный блок уже начат. */
export function deriveParentStatus(children: readonly StatusInput[]): ItemStatus {
  if (children.length === 0) return "NOT_STARTED";
  if (children.every((child) => getItemStatus(child) === "COMPLETED")) {
    return "COMPLETED";
  }
  return children.some((child) => getItemStatus(child) !== "NOT_STARTED")
    ? "IN_PROGRESS"
    : "NOT_STARTED";
}
