/**
 * @file validations.test.ts
 * @description Тесты Zod-схем — границы доверия между клиентом и Server Actions.
 *
 * Проверяется не сам Zod, а принятые в проекте решения: какие значения схема
 * обязана пропустить, какие отбить и в какой тип превратить. Ослабление любого
 * из них — это доступ к недоверенным данным глубже валидации.
 */

import { describe, expect, it } from "vitest";

import { FALLBACK_FILE_NAME, MAX_FILE_SIZE } from "@/lib/attachments";
import { MAX_NOTE_LENGTH } from "@/lib/notes";
import {
  createItemSchema,
  setItemStatusSchema,
  createListSchema,
  moveGroupSchema,
  moveListInGroupSchema,
  moveItemSchema,
  moveItemToListSchema,
  requestUploadSchema,
  shareListSchema,
  updateItemNoteSchema,
  updateListNoteSchema,
} from "@/lib/validations";

describe("createItemSchema", () => {
  it("принимает обычную запись", () => {
    const result = createItemSchema.safeParse({
      itemName: "Молоко",
      listId: "list_1",
    });

    expect(result.success).toBe(true);
  });

  it("отбивает пустое название", () => {
    expect(createItemSchema.safeParse({ itemName: "", listId: "list_1" }).success).toBe(
      false,
    );
  });

  it("принимает название ровно на границе в 200 символов", () => {
    const result = createItemSchema.safeParse({
      itemName: "я".repeat(200),
      listId: "list_1",
    });

    expect(result.success).toBe(true);
  });

  it("отбивает название длиннее 200 символов", () => {
    const result = createItemSchema.safeParse({
      itemName: "я".repeat(201),
      listId: "list_1",
    });

    expect(result.success).toBe(false);
  });

  it("отбивает отсутствующий listId", () => {
    expect(createItemSchema.safeParse({ itemName: "Молоко" }).success).toBe(false);
  });

  it("без родителя подставляет null — это обычный пункт списка", () => {
    const result = createItemSchema.safeParse({ itemName: "Молоко", listId: "list_1" });

    expect(result.success && result.data.parentItemId).toBeNull();
  });

  it("принимает родителя для подпункта", () => {
    const result = createItemSchema.safeParse({
      itemName: "Молоко",
      listId: "list_1",
      parentItemId: "item_1",
    });

    expect(result.success && result.data.parentItemId).toBe("item_1");
  });

  it("отбивает пустой ID родителя: край формы — это null, а не пустая строка", () => {
    expect(
      createItemSchema.safeParse({
        itemName: "Молоко",
        listId: "list_1",
        parentItemId: "",
      }).success,
    ).toBe(false);
  });
});

describe("createListSchema", () => {
  it("принимает список без группы", () => {
    expect(createListSchema.safeParse({ title: "Покупки" }).success).toBe(true);
  });

  it("принимает список с группой", () => {
    expect(
      createListSchema.safeParse({ title: "Покупки", groupId: "group_1" }).success,
    ).toBe(true);
  });

  it("отбивает название длиннее 50 символов", () => {
    expect(createListSchema.safeParse({ title: "я".repeat(51) }).success).toBe(false);
  });
});

describe("shareListSchema", () => {
  it("обрезает пробелы по краям email до проверки формата", () => {
    const result = shareListSchema.safeParse({
      listId: "list_1",
      email: "  user@example.com  ",
    });

    expect(result.success).toBe(true);
    expect(result.data?.email).toBe("user@example.com");
  });

  it("отбивает строку, которая не является email", () => {
    expect(
      shareListSchema.safeParse({ listId: "list_1", email: "не-email" }).success,
    ).toBe(false);
  });

  it("отбивает пустой email", () => {
    expect(shareListSchema.safeParse({ listId: "list_1", email: "   " }).success).toBe(
      false,
    );
  });
});

describe("moveItemSchema", () => {
  it("принимает обоих соседей", () => {
    const result = moveItemSchema.safeParse({
      itemId: "item_1",
      previousItemId: "item_0",
      nextItemId: "item_2",
    });

    expect(result.success).toBe(true);
  });

  it("принимает null как признак края списка", () => {
    const toStart = moveItemSchema.safeParse({
      itemId: "item_1",
      previousItemId: null,
      nextItemId: "item_2",
    });
    const toEnd = moveItemSchema.safeParse({
      itemId: "item_1",
      previousItemId: "item_0",
      nextItemId: null,
    });

    expect(toStart.success).toBe(true);
    expect(toEnd.success).toBe(true);
  });

  it("отбивает пустую строку вместо соседа: это не то же самое, что край", () => {
    const result = moveItemSchema.safeParse({
      itemId: "item_1",
      previousItemId: "",
      nextItemId: null,
    });

    expect(result.success).toBe(false);
  });

  it("отбивает отсутствующее поле соседа: null нужно передать явно", () => {
    const result = moveItemSchema.safeParse({
      itemId: "item_1",
      previousItemId: "item_0",
    });

    expect(result.success).toBe(false);
  });
});

describe("moveGroupSchema", () => {
  it("принимает соседей и null на краю", () => {
    expect(
      moveGroupSchema.safeParse({
        groupId: "group_2",
        previousGroupId: "group_1",
        nextGroupId: "group_3",
      }).success,
    ).toBe(true);
    expect(
      moveGroupSchema.safeParse({
        groupId: "group_2",
        previousGroupId: null,
        nextGroupId: "group_1",
      }).success,
    ).toBe(true);
  });

  it("отбивает саму перемещаемую группу в качестве соседа", () => {
    expect(
      moveGroupSchema.safeParse({
        groupId: "group_2",
        previousGroupId: "group_2",
        nextGroupId: null,
      }).success,
    ).toBe(false);
  });

  it("отбивает пустую строку вместо края", () => {
    expect(
      moveGroupSchema.safeParse({
        groupId: "group_2",
        previousGroupId: "",
        nextGroupId: null,
      }).success,
    ).toBe(false);
  });
});

describe("moveListInGroupSchema", () => {
  it("принимает группу, список и соседей итогового порядка", () => {
    expect(
      moveListInGroupSchema.safeParse({
        groupId: "group_1",
        listId: "list_2",
        previousListId: "list_1",
        nextListId: "list_3",
      }).success,
    ).toBe(true);
  });

  it("отбивает перемещаемый список в качестве соседа", () => {
    expect(
      moveListInGroupSchema.safeParse({
        groupId: "group_1",
        listId: "list_2",
        previousListId: "list_2",
        nextListId: null,
      }).success,
    ).toBe(false);
  });
});

describe("moveItemToListSchema", () => {
  it("принимает оба поддерживаемых режима", () => {
    for (const mode of ["move", "copy"] as const) {
      const result = moveItemToListSchema.safeParse({
        itemId: "item_1",
        targetListId: "list_2",
        mode,
      });

      expect(result.success).toBe(true);
    }
  });

  it("отбивает неизвестный режим", () => {
    const result = moveItemToListSchema.safeParse({
      itemId: "item_1",
      targetListId: "list_2",
      mode: "delete",
    });

    expect(result.success).toBe(false);
  });
});

describe("requestUploadSchema", () => {
  it("принимает файл на границе допустимого размера", () => {
    const result = requestUploadSchema.safeParse({
      listId: "list_1",
      spaceId: "space_1",
      fileName: "photo.png",
      contentType: "image/png",
      size: MAX_FILE_SIZE,
    });

    expect(result.success).toBe(true);
  });

  it("чистит имя файла от bidi-подмены расширения", () => {
    // Санитизация живёт в схеме, а не в Action: так очищенное имя получает
    // любой будущий вызывающий, а не только requestUpload.
    const result = requestUploadSchema.safeParse({
      listId: "list_1",
      spaceId: "space_1",
      fileName: "отчёт\u202Egnp.exe",
      contentType: "image/png",
      size: 1,
    });

    expect(result.success).toBe(true);
    expect(result.data?.fileName).toBe("отчётgnp.exe");
  });

  it("заменяет имя из одних невидимых символов на запасное", () => {
    const result = requestUploadSchema.safeParse({
      listId: "list_1",
      spaceId: "space_1",
      fileName: "\u202E\u200B",
      contentType: "image/png",
      size: 1,
    });

    // min(1) такую строку пропускал, и в UI имя рендерилось пустым.
    expect(result.success).toBe(true);
    expect(result.data?.fileName).toBe(FALLBACK_FILE_NAME);
  });

  it("отбивает файл больше лимита", () => {
    const result = requestUploadSchema.safeParse({
      listId: "list_1",
      spaceId: "space_1",
      fileName: "photo.png",
      contentType: "image/png",
      size: MAX_FILE_SIZE + 1,
    });

    expect(result.success).toBe(false);
  });

  it("отбивает нулевой и дробный размер", () => {
    const base = {
      listId: "list_1",
      spaceId: "space_1",
      fileName: "photo.png",
      contentType: "image/png",
    };

    expect(requestUploadSchema.safeParse({ ...base, size: 0 }).success).toBe(false);
    expect(requestUploadSchema.safeParse({ ...base, size: 1.5 }).success).toBe(false);
  });

  it("требует ограниченный spaceId для серверной проверки доступа", () => {
    const base = {
      listId: "list_1",
      fileName: "photo.png",
      contentType: "image/png",
      size: 1,
    };

    expect(requestUploadSchema.safeParse(base).success).toBe(false);
    expect(
      requestUploadSchema.safeParse({ ...base, spaceId: "x".repeat(101) })
        .success,
    ).toBe(false);
  });
});

describe("схемы заметок", () => {
  it("принимают версию числом — так её присылает guest API", () => {
    const result = updateListNoteSchema.safeParse({
      listId: "list_1",
      note: "текст",
      expectedVersion: 3,
    });

    expect(result.success).toBe(true);
    expect(result.data?.expectedVersion).toBe(3);
  });

  it("принимают версию строкой из FormData и приводят её к числу", () => {
    const result = updateItemNoteSchema.safeParse({
      itemId: "item_1",
      note: "текст",
      expectedVersion: "3",
    });

    expect(result.success).toBe(true);
    expect(result.data?.expectedVersion).toBe(3);
  });

  it("отбивают нечисловую версию", () => {
    const result = updateListNoteSchema.safeParse({
      listId: "list_1",
      note: "текст",
      expectedVersion: "3abc",
    });

    expect(result.success).toBe(false);
  });

  it("отбивают отрицательную версию", () => {
    const result = updateListNoteSchema.safeParse({
      listId: "list_1",
      note: "текст",
      expectedVersion: -1,
    });

    expect(result.success).toBe(false);
  });

  it("принимают пустую заметку: так она очищается", () => {
    const result = updateListNoteSchema.safeParse({
      listId: "list_1",
      note: "",
      expectedVersion: 0,
    });

    expect(result.success).toBe(true);
  });

  it("принимают заметку ровно на границе длины", () => {
    const result = updateListNoteSchema.safeParse({
      listId: "list_1",
      note: "я".repeat(MAX_NOTE_LENGTH),
      expectedVersion: 0,
    });

    expect(result.success).toBe(true);
  });

  it("отбивают заметку длиннее лимита", () => {
    const result = updateListNoteSchema.safeParse({
      listId: "list_1",
      note: "я".repeat(MAX_NOTE_LENGTH + 1),
      expectedVersion: 0,
    });

    expect(result.success).toBe(false);
  });
});

describe("setItemStatusSchema", () => {
  it.each(["NOT_STARTED", "IN_PROGRESS", "DEFERRED", "COMPLETED"])("принимает %s", (status) => {
    expect(setItemStatusSchema.safeParse({ itemId: "item-1", status }).success).toBe(true);
  });
  it.each(["unknown", "", null, true, { value: "IN_PROGRESS" }])("отбивает недоверенный статус %j", (status) => {
    expect(setItemStatusSchema.safeParse({ itemId: "item-1", status }).success).toBe(false);
  });
  it("отбивает пустой ID и чужие поля", () => {
    expect(setItemStatusSchema.safeParse({ itemId: "", status: "IN_PROGRESS" }).success).toBe(false);
    expect(setItemStatusSchema.safeParse({ itemId: "a", status: "IN_PROGRESS", ownerId: "other" }).success).toBe(false);
  });
});
