/**
 * @file usage.int.test.ts
 * @description Суточный бюджет мутаций и ленивая уборка счётчиков.
 *
 * Отдельного внимания стоит последний блок. Он перечисляет действия, меняющие
 * данные, и требует, чтобы каждое отказывало при исчерпанном бюджете.
 *
 * Сам по себе список полноты не доказывает — он ведётся руками, и до
 * 2026-09-01 три attachment-действия отсутствовали в нём, хотя бюджет
 * списывали. Полноту обеспечивает `test/mutation-budget-coverage.test.ts`: он
 * берёт набор из фактических экспортов каталога `actions` и требует, чтобы
 * каждое мутирующее действие было покрыто здесь. Поэтому блок ниже проверяет
 * поведение, а полнота набора закреплена отдельно и не зависит от внимания.
 */

import { describe, expect, it } from "vitest";

import {
  DAILY_MUTATION_LIMIT,
  USAGE_RETENTION_DAYS,
  consumeMutationBudget,
  usageDate,
} from "@/lib/usage";
import {
  addItem,
  addListToGroup,
  createGroup,
  createList,
  deleteGroup,
  deleteItem,
  deleteList,
  leaveSharedList,
  moveGroup,
  moveItem,
  moveItemToList,
  moveListInGroup,
  removeListFromGroup,
  removeSharedUser,
  renameGroup,
  renameItem,
  renameList,
  setListAiEnabled,
  shareList,
  toggleItem,
  setItemStatus,
  updateItemNote,
  updateListNote,
} from "@/app/actions";
import { createSpace, deleteSpace, renameSpace } from "@/app/actions/spaces";
import {
  confirmUpload,
  deleteAttachment,
  requestUpload,
} from "@/app/actions/attachments";
import { prisma, setSessionUser } from "./setup";
import { formData, makeItem, makeList, makeUser } from "./factories";

/** День, отстоящий от сегодняшнего UTC-дня на указанное число суток назад. */
function daysAgo(days: number): Date {
  return new Date(usageDate().getTime() - days * 24 * 60 * 60 * 1000);
}

/** Ставит счётчик мутаций пользователя на потолок — следующая попытка лишняя. */
async function exhaustBudget(userId: string): Promise<void> {
  await prisma.userDailyUsage.create({
    data: { userId, date: usageDate(), mutations: DAILY_MUTATION_LIMIT },
  });
}

describe("суточный бюджет мутаций", () => {
  it("пускает до потолка и отказывает после", async () => {
    const user = await makeUser();

    await prisma.userDailyUsage.create({
      data: { userId: user.id, date: usageDate(), mutations: DAILY_MUTATION_LIMIT - 1 },
    });

    expect(await consumeMutationBudget(user.id)).toBe(true);
    expect(await consumeMutationBudget(user.id)).toBe(false);
  });

  it("откатывает инкремент отвергнутой попытки", async () => {
    const user = await makeUser();
    await exhaustBudget(user.id);

    await consumeMutationBudget(user.id);

    // Иначе отвергнутые попытки накручивали бы счётчик в тот момент, когда он
    // уже никого не пускает, и цифра в логе перестала бы что-либо значить.
    const usage = await prisma.userDailyUsage.findUnique({
      where: { userId_date: { userId: user.id, date: usageDate() } },
      select: { mutations: true },
    });
    expect(usage?.mutations).toBe(DAILY_MUTATION_LIMIT);
  });

  it("считает бюджет каждому пользователю отдельно", async () => {
    const exhausted = await makeUser();
    const fresh = await makeUser();
    await exhaustBudget(exhausted.id);

    expect(await consumeMutationBudget(exhausted.id)).toBe(false);
    expect(await consumeMutationBudget(fresh.id)).toBe(true);
  });

  it("не смешивает счётчик мутаций со счётчиком инсайтов", async () => {
    const user = await makeUser();
    await prisma.userDailyUsage.create({
      data: { userId: user.id, date: usageDate(), insights: 15, mutations: 0 },
    });

    expect(await consumeMutationBudget(user.id)).toBe(true);

    const usage = await prisma.userDailyUsage.findUnique({
      where: { userId_date: { userId: user.id, date: usageDate() } },
      select: { insights: true, mutations: true },
    });
    expect(usage).toEqual({ insights: 15, mutations: 1 });
  });

  it("при параллельных запросах пропускает ровно остаток бюджета", async () => {
    const user = await makeUser();
    await prisma.userDailyUsage.create({
      data: {
        userId: user.id,
        date: usageDate(),
        mutations: DAILY_MUTATION_LIMIT - 2,
      },
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => consumeMutationBudget(user.id)),
    );

    expect(results.filter(Boolean)).toHaveLength(2);
    expect(results.filter((allowed) => !allowed)).toHaveLength(6);
    const usage = await prisma.userDailyUsage.findUniqueOrThrow({
      where: { userId_date: { userId: user.id, date: usageDate() } },
      select: { mutations: true },
    });
    expect(usage.mutations).toBe(DAILY_MUTATION_LIMIT);
  });

  it("отклоняет некорректный userId до записи счётчика", async () => {
    await expect(consumeMutationBudget("\0")).rejects.toMatchObject({
      code: "INVALID_CONTEXT",
    });
  });
});

describe("ленивая уборка счётчиков", () => {
  it("удаляет ряды старше срока хранения при первой мутации дня", async () => {
    const user = await makeUser();
    await prisma.userDailyUsage.createMany({
      data: [
        { userId: user.id, date: daysAgo(USAGE_RETENTION_DAYS + 1), mutations: 5 },
        { userId: user.id, date: daysAgo(USAGE_RETENTION_DAYS - 1), mutations: 5 },
      ],
    });

    await consumeMutationBudget(user.id);

    const remaining = await prisma.userDailyUsage.findMany({
      where: { userId: user.id },
      orderBy: { date: "asc" },
      select: { date: true },
    });
    expect(remaining).toHaveLength(2);
    expect(remaining[0].date).toEqual(daysAgo(USAGE_RETENTION_DAYS - 1));
    expect(remaining[1].date).toEqual(usageDate());
  });

  it("не трогает ряды других пользователей", async () => {
    const active = await makeUser();
    const other = await makeUser();
    await prisma.userDailyUsage.create({
      data: { userId: other.id, date: daysAgo(USAGE_RETENTION_DAYS + 1), mutations: 5 },
    });

    await consumeMutationBudget(active.id);

    // Уборка «за всех» превратилась бы в длинный DELETE у случайного человека,
    // которому не повезло зайти первым.
    expect(await prisma.userDailyUsage.count({ where: { userId: other.id } })).toBe(1);
  });

  it("не запускается на второй и последующих мутациях дня", async () => {
    const user = await makeUser();
    await prisma.userDailyUsage.createMany({
      data: [
        { userId: user.id, date: usageDate(), mutations: 1 },
        { userId: user.id, date: daysAgo(USAGE_RETENTION_DAYS + 1), mutations: 5 },
      ],
    });

    await consumeMutationBudget(user.id);

    // Ряд за сегодня уже был, значит сутки не новые — старый ряд ещё лежит и
    // будет убран завтра. Уборка на каждой мутации стоила бы лишней записи в
    // каждом запросе, то есть ровно той нагрузки, которую бюджет ограничивает.
    expect(await prisma.userDailyUsage.count({ where: { userId: user.id } })).toBe(2);
  });
});

describe("действия соблюдают бюджет", () => {
  /**
   * Аргументы намеренно пустые: бюджет проверяется сразу после сессии, до
   * валидации и до обращения к данным. Тест отвечает на вопрос «списывается ли
   * бюджет вообще», а не «как действие разбирает свой ввод».
   */
  const actions: Array<[string, () => Promise<{ success?: boolean; error?: string }>]> = [
    ["addItem", () => addItem(formData({}))],
    ["setItemStatus", () => setItemStatus(formData({}))],
    ["renameItem", () => renameItem(formData({}))],
    ["moveItem", () => moveItem(formData({}))],
    ["moveItemToList", () => moveItemToList(formData({}))],
    ["updateItemNote", () => updateItemNote(formData({}))],
    ["updateListNote", () => updateListNote(formData({}))],
    ["createList", () => createList(formData({}))],
    ["deleteList", () => deleteList(formData({}))],
    ["renameList", () => renameList(formData({}))],
    ["setListAiEnabled", () => setListAiEnabled(formData({}))],
    ["shareList", () => shareList(formData({}))],
    ["removeSharedUser", () => removeSharedUser(formData({}))],
    ["leaveSharedList", () => leaveSharedList(formData({}))],
    ["createGroup", () => createGroup(formData({}))],
    ["deleteGroup", () => deleteGroup(formData({}))],
    ["renameGroup", () => renameGroup(formData({}))],
    ["moveGroup", () => moveGroup(formData({}))],
    ["moveListInGroup", () => moveListInGroup(formData({}))],
    ["addListToGroup", () => addListToGroup(formData({}))],
    ["removeListFromGroup", () => removeListFromGroup(formData({}))],
    ["createSpace", () => createSpace("Пространство")],
    ["renameSpace", () => renameSpace("space_1", "Имя")],
    ["deleteSpace", () => deleteSpace("space_1", "Имя")],
    // Вложения стоят двух единиц бюджета (`requestUpload` + `confirmUpload`),
    // и обе половины, как и удаление, списывают его сразу после сессии — до
    // проверки S3 и до валидации. Поэтому S3 здесь не нужен.
    [
      "requestUpload",
      () =>
        requestUpload({
          listId: "",
          spaceId: "",
          fileName: "",
          contentType: "",
          size: 0,
        }),
    ],
    ["confirmUpload", () => confirmUpload({ attachmentId: "", spaceId: "" })],
    [
      "deleteAttachment",
      () => deleteAttachment({ attachmentId: "", spaceId: "" }),
    ],
  ];

  it.each(actions)("%s отказывает при исчерпанном бюджете", async (_name, call) => {
    const user = await makeUser();
    setSessionUser(user.id);
    await exhaustBudget(user.id);

    expect(await call()).toEqual({ success: false, error: "dailyLimitReached" });
  });

  /**
   * `deleteItem` и `toggleItem` по существующему контракту ничего не
   * возвращают клиенту, поэтому отказ проверяется по данным: действие просто
   * не должно произойти.
   */
  it("deleteItem при исчерпанном бюджете не удаляет запись", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const item = await makeItem(list.id, { name: "Остаётся" });
    setSessionUser(user.id);
    await exhaustBudget(user.id);

    await deleteItem(
      formData({ itemId: item.id, spaceId: user.defaultSpaceId }),
    );

    expect(await prisma.item.count({ where: { id: item.id } })).toBe(1);
  });

  it("toggleItem при исчерпанном бюджете не меняет отметку", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const item = await makeItem(list.id, { name: "Не отмечается" });
    setSessionUser(user.id);
    await exhaustBudget(user.id);

    await toggleItem(
      formData({
        itemId: item.id,
        isCompleted: "true",
        spaceId: user.defaultSpaceId,
      }),
    );

    const stored = await prisma.item.findUnique({
      where: { id: item.id },
      select: { isCompleted: true },
    });
    expect(stored?.isCompleted).toBe(false);
  });
});
