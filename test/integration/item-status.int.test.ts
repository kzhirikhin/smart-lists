/** Состояния работы, scoped-доступ и синхронизация подпунктов. */
import { describe, expect, it, vi } from "vitest";
import { setItemStatus, toggleItem, moveItemToList, deleteItem, addItem } from "@/app/actions";
import { clearSession, flushAfter, prisma, setSessionUser } from "./setup";
import { formData, makeItem, makeList, makeSpace, makeUser, shareList } from "./factories";

describe("состояние записи", () => {
  async function seed() {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const item = await makeItem(list.id);
    setSessionUser(user.id);
    const change = (status: string, itemId = item.id, spaceId = user.defaultSpaceId) => setItemStatus(formData({ itemId, status, spaceId, socketId: "123.456" }));
    return { user, list, item, change };
  }
  it("начало сохраняет позицию, галочка завершает и возвращает в не начатые", async () => {
    const { user, item, change } = await seed();
    expect(await change("IN_PROGRESS")).toEqual({ success: true });
    expect(await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "IN_PROGRESS", isCompleted: false, position: item.position });
    await toggleItem(formData({ itemId: item.id, isCompleted: "false", spaceId: user.defaultSpaceId }));
    expect(await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "COMPLETED", isCompleted: true });
    await toggleItem(formData({ itemId: item.id, isCompleted: "true", spaceId: user.defaultSpaceId }));
    expect(await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "NOT_STARTED", isCompleted: false });
  });
  it("редактор меняет состояние и уведомляет участников после commit без эха", async () => {
    const { user, list, change } = await seed();
    const editor = await makeUser();
    await shareList(list.id, editor.id);
    setSessionUser(editor.id);
    const { notifyUsers } = await import("@/lib/notify");
    expect(await change("IN_PROGRESS", undefined, editor.defaultSpaceId)).toEqual({ success: true });
    expect(vi.mocked(notifyUsers)).not.toHaveBeenCalled();
    await flushAfter();
    expect(vi.mocked(notifyUsers)).toHaveBeenCalledWith([user.id, editor.id], "123.456");
  });
  it("отказывает без сессии, чужому пользователю и через другое пространство", async () => {
    const { user, item, change } = await seed();
    clearSession();
    expect(await change("IN_PROGRESS")).toMatchObject({ success: false });
    const stranger = await makeUser();
    setSessionUser(stranger.id);
    expect(await change("IN_PROGRESS", item.id, stranger.defaultSpaceId)).toMatchObject({ success: false });
    setSessionUser(user.id);
    const otherSpace = await makeSpace(user.id, "Другое");
    expect(await change("IN_PROGRESS", item.id, otherSpace.id)).toMatchObject({ success: false });
    expect(await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "NOT_STARTED", isCompleted: false });
  });
  it("отбивает недоверенные значения до записи", async () => {
    const { item, change } = await seed();
    expect(await change("BAD")).toEqual({ success: false, error: "validationError" });
    expect(await change("IN_PROGRESS", "missing")).toMatchObject({ success: false });
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("NOT_STARTED");
  });
  it("начало блока сохраняет завершённые подпункты, сброс очищает весь блок", async () => {
    const { list, item, change } = await seed();
    const first = await makeItem(list.id, { parentId: item.id, isCompleted: true });
    const second = await makeItem(list.id, { parentId: item.id });
    await change("IN_PROGRESS");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: first.id } })).isCompleted).toBe(true);
    expect((await prisma.item.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("IN_PROGRESS");
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("IN_PROGRESS");
    await change("NOT_STARTED");
    expect((await prisma.item.findMany({ where: { listId: list.id } })).every((entry) => entry.status === "NOT_STARTED" && !entry.isCompleted)).toBe(true);
  });
  it("подпункт пересчитывает родителя; удаление последнего сохраняет его состояние", async () => {
    const { user, list, item, change } = await seed();
    const sub = await makeItem(list.id, { parentId: item.id });
    await change("IN_PROGRESS", sub.id);
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("IN_PROGRESS");
    await deleteItem(formData({ itemId: sub.id, spaceId: user.defaultSpaceId }));
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("IN_PROGRESS");
    await addItem(formData({ listId: list.id, parentItemId: item.id, itemName: "Новый", spaceId: user.defaultSpaceId }));
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("NOT_STARTED");
  });
  it("перенос сохраняет статус, копирование сбрасывает", async () => {
    const { user, item, change } = await seed();
    const target = await makeList(user.id, user.defaultSpaceId);
    await change("IN_PROGRESS");
    await moveItemToList(formData({ itemId: item.id, targetListId: target.id, mode: "copy", spaceId: user.defaultSpaceId }));
    expect((await prisma.item.findFirstOrThrow({ where: { listId: target.id } })).status).toBe("NOT_STARTED");
    await moveItemToList(formData({ itemId: item.id, targetListId: target.id, mode: "move", spaceId: user.defaultSpaceId }));
    expect(await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "IN_PROGRESS", listId: target.id });
  });
});
