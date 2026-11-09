import { describe, expect, it, vi } from "vitest";
import { moveItemToList, updateItemState } from "@/app/actions";
import { clearSession, flushAfter, prisma, setSessionUser } from "./setup";
import { formData, makeItem, makeList, makeSpace, makeUser, shareList } from "./factories";

describe("подпись текущего состояния", () => {
  it("отказывает без сессии", async () => {
    clearSession();
    expect((await updateItemState(formData({ itemId: "missing", statusText: "Жду" }))).success).toBe(false);
  });
  it("editor меняет пункт и подпункт, уведомляет участников после ответа без эха", async () => {
    const owner = await makeUser();
    const editor = await makeUser();
    const list = await makeList(owner.id, owner.defaultSpaceId);
    await shareList(list.id, editor.id);
    const item = await makeItem(list.id, { name: "Название" });
    const sub = await makeItem(list.id, { parentId: item.id });
    setSessionUser(editor.id);
    const { notifyUsers } = await import("@/lib/notify");
    vi.mocked(notifyUsers).mockClear();
    expect((await updateItemState(formData({ itemId: item.id, statusText: " Жду ответа ", spaceId: editor.defaultSpaceId, socketId: "123.456" }))).success).toBe(true);
    expect(notifyUsers).not.toHaveBeenCalled();
    await flushAfter();
    expect(notifyUsers).toHaveBeenCalledWith([owner.id, editor.id], "123.456");
    expect((await updateItemState(formData({ itemId: sub.id, statusText: "Нужна доработка", spaceId: editor.defaultSpaceId }))).success).toBe(true);
    const saved = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(saved.statusText).toBe("Жду ответа");
    expect(saved.name).toBe("Название");
    expect(saved.noteVersion).toBe(0);
    expect(saved.status).toBe("NOT_STARTED");
    await updateItemState(formData({ itemId: item.id, statusText: " ", spaceId: editor.defaultSpaceId }));
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).statusText).toBeNull();
  });
  it("отказывает постороннему, другому пространству и после отзыва share", async () => {
    const owner = await makeUser();
    const editor = await makeUser();
    const stranger = await makeUser();
    const list = await makeList(owner.id, owner.defaultSpaceId);
    const item = await makeItem(list.id);
    await shareList(list.id, editor.id);
    for (const [userId, spaceId] of [[stranger.id, stranger.defaultSpaceId], [editor.id, (await makeSpace(editor.id, "Другое")).id]]) {
      setSessionUser(userId);
      expect((await updateItemState(formData({ itemId: item.id, statusText: "Чужое", spaceId }))).success).toBe(false);
    }
    await prisma.listShare.deleteMany({ where: { listId: list.id, userId: editor.id } });
    setSessionUser(editor.id);
    expect((await updateItemState(formData({ itemId: item.id, statusText: "Чужое", spaceId: editor.defaultSpaceId }))).success).toBe(false);
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).statusText).toBeNull();
  });
  it("отбивает неверный ввод, сохраняет при переносе и сбрасывает у копии", async () => {
    const owner = await makeUser();
    setSessionUser(owner.id);
    const source = await makeList(owner.id, owner.defaultSpaceId);
    const target = await makeList(owner.id, owner.defaultSpaceId);
    const item = await makeItem(source.id);
    const fields = { itemId: item.id, spaceId: owner.defaultSpaceId };
    for (const statusText of ["x".repeat(121), "A\nB"]) expect((await updateItemState(formData({ ...fields, statusText }))).success).toBe(false);
    await updateItemState(formData({ ...fields, statusText: "Жду" }));
    await moveItemToList(formData({ ...fields, targetListId: target.id, mode: "copy" }));
    expect((await prisma.item.findFirstOrThrow({ where: { listId: target.id } })).statusText).toBeNull();
    await moveItemToList(formData({ ...fields, targetListId: target.id, mode: "move" }));
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).statusText).toBe("Жду");
  });
});
