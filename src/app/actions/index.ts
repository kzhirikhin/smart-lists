/**
 * @file actions.ts
 * @description Server Actions — серверные функции, вызываемые напрямую из клиентских компонентов.
 *
 * Директива `"use server"` в начале файла обозначает, что ВСЕ экспортируемые функции
 * здесь являются Server Actions: они выполняются исключительно на сервере, даже если
 * их вызывают из клиентских компонентов (`"use client"`).
 *
 * Преимущества Server Actions:
 *   - Прямой доступ к БД (через Prisma) без промежуточных API-роутов.
 *   - Автоматическая защита: клиент видит только имя функции, not its body.
 *   - Встроенная интеграция с формами Next.js (`<form action={serverAction}>`).
 *
 * Общая схема каждого Action:
 *   1. Проверка авторизации (`auth()`) — для защищённых операций.
 *   2. Сборка сырых данных из `FormData`.
 *   3. Валидация через Zod (`schema.safeParse`).
 *   4. Операция с БД через Prisma.
 *   5. Инвалидация кеша Next.js (`revalidatePath("/", "layout")` — весь layout-дерево, включая все локали: /ru, /vi, /en, /ja).
 *   6. Возврат результата `{ success: true }` или `{ success: false, error: string }`.
 */

"use server";

import {
  createItemSchema,
  deleteItemSchema,
  toggleItemSchema,
  setItemStatusSchema,
  createListSchema,
  deleteListSchema,
  shareListSchema,
  removeSharedUserSchema,
  renameListSchema,
  renameItemSchema,
  moveItemSchema,
  moveItemToListSchema,
  createGroupSchema,
  deleteGroupSchema,
  renameGroupSchema,
  moveGroupSchema,
  moveListInGroupSchema,
  listGroupMembershipSchema,
  updateListNoteSchema,
  updateItemNoteSchema,
  setListAiEnabledSchema,
} from "@/lib/validations";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { deriveParentStatus } from "@/lib/item-status";
import { auth } from "@/auth";
import { logger, hashId } from "@/lib/logger";
import { notifyUsers } from "@/lib/notify";
import { deleteObjects } from "@/lib/s3";
import { ZodError } from "zod";
import {
  defaultSpaceId,
  getUserSpace,
  listInSpaceWhere,
} from "@/lib/spaces";
import { normalizeNote } from "@/lib/notes";
import {
  MAX_GROUPS_PER_SPACE,
  MAX_ITEMS_PER_LIST,
  MAX_LISTS_PER_SPACE,
  MAX_SUB_ITEMS_PER_ITEM,
} from "@/lib/limits";
import { consumeMutationBudget } from "@/lib/usage";
import { withSpaceDb, type ScopedTransaction } from "@/lib/scoped-db";
import { writeAuditEvent } from "@/lib/audit";

/**
 * Шаг между позициями записей при добавлении в конец списка.
 * Величина произвольна: значимо только сравнение позиций между собой.
 */
const POSITION_STEP = 1;

/** Возвращает код ошибки валидации: "tooLong" при превышении длины, иначе "validationError". */
function getValidationError(error: ZodError): string {
  return error.issues.some((i) => i.code === "too_big") ? "tooLong" : "validationError";
}

/**
 * Приводит кеш отметки родителя в соответствие с его подпунктами.
 *
 * Выполняет условные операции через переданный transaction client.
 * Вызывающий сначала меняет подпункт, затем пересчитывает родителя в той же
 * scoped-транзакции. Сначала пересчитывается завершённость, затем
 * незавершённый блок получает «в процессе», если работа уже началась.
 *
 * Отметка родителя производная (см. `src/lib/item-tree.ts`), и в строке лежит
 * лишь кеш для запросов, которые дерево не собирают. Поэтому атомарность с
 * изменением подпункта желательна, но не критична: расхождение кеша
 * пользователю не видно.
 *
 * Родитель, оставшийся вовсе без подпунктов, сохраняет прежнее значение —
 * с этого момента оно снова его собственное. Пустая выборка поэтому не
 * пересчитывается: «все ноль подпунктов выполнены» не завершает родителя.
 */
async function syncParentCompletion(
  tx: ScopedTransaction,
  parentId: string,
  listId: string,
) {
  const children = await tx.item.findMany({
    where: { parentId, listId },
    select: { isCompleted: true, status: true },
  });
  if (children.length === 0) return;
  const status = deriveParentStatus(children);
  await tx.item.updateMany({
    where: { id: parentId, listId },
    data: { status, isCompleted: status === "COMPLETED" },
  });
}

/** Собирает owner и editor ID для DB-free realtime после commit. */
function listNotificationUserIds(list: {
  ownerId: string;
  shares: ReadonlyArray<{ userId: string }>;
}): string[] {
  return [
    ...new Set([
      list.ownerId,
      ...list.shares.map((share) => share.userId),
    ]),
  ];
}

/** Проверяет, что spaceId из формы принадлежит текущему пользователю. */
async function resolveActionSpace(userId: string, formData: FormData) {
  const spaceId = formData.get("spaceId");
  if (typeof spaceId !== "string" || !spaceId) return null;
  return getUserSpace(userId, spaceId);
}

// ===========================================================================
// SERVER ACTIONS ДЛЯ ЗАПИСЕЙ (Item)
// ===========================================================================

/**
 * Добавляет новую запись в список.
 *
 * Вызывается из компонента `SmartList` оптимистично: запись сначала
 * появляется на экране мгновенно (с временным ID), а эта функция
 * сохраняет его в БД в фоне.
 *
 * @param formData - FormData с полями:
 *   - `itemName`     {string} — название записи (1–100 символов).
 *   - `listId`       {string} — ID списка, к которому добавляется запись.
 *   - `parentItemId` {string} — ID родительского пункта для подпункта ("" — обычный пункт).
 * @returns `{ success: true }` или `{ success: false, error: string }`.
 */
export async function addItem(formData: FormData) {
  try {
    // Проверяем сессию до обработки данных
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }
    const userId = session.user.id;

    if (!(await consumeMutationBudget(userId))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(userId, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    // Собираем объект из FormData: Zod лучше работает с обычными объектами
    const rawData = {
      itemName: formData.get("itemName"),
      listId: formData.get("listId"),
      // FormData не умеет передавать null: пустая строка означает обычный пункт.
      parentItemId: formData.get("parentItemId") || null,
    };

    // safeParse не бросает исключение, а возвращает { success, data | error }
    const result = createItemSchema.safeParse(rawData);

    if (!result.success) {
      logger.error({ error: result.error }, "Ошибка валидации:");
      return { success: false, error: getValidationError(result.error) };
    }

    const { listId, itemName, parentItemId } = result.data;

    // Позиция значима внутри своего уровня, поэтому максимум берётся по
    // соседям будущей записи: у подпункта это подпункты того же родителя,
    // у обычного пункта — пункты верхнего уровня списка.
    //
    // Два одновременных добавления могут прочитать один и тот же максимум и
    // получить равные позиции. Это допустимо: порядок доопределяет тайбрейк по
    // createdAt и id при выборке, список не ломается.
    const creation = await withSpaceDb(userId, space.id, async (tx) => {
      let position: number;
      let notificationUserIds: string[];

      if (parentItemId) {
        // Один запрос закрывает четыре проверки сразу: доступ к списку,
        // существование родителя ИМЕННО в этом списке, запрет второго уровня
        // вложенности (`parentId: null` у родителя) — и отдаёт максимальную
        // позицию среди уже существующих подпунктов.
        const parent = await tx.item.findFirst({
          where: {
            id: parentItemId,
            listId,
            parentId: null,
            list: listInSpaceWhere(userId, space.id),
          },
          select: {
            id: true,
            children: {
              orderBy: { position: "desc" },
              take: 1,
              select: { position: true },
            },
            // Счёт берётся тем же запросом, что и проверка доступа с позицией:
            // отдельный COUNT стоил бы лишнего round-trip до БД ради числа,
            // которое почти всегда далеко от потолка.
            _count: { select: { children: true } },
            list: {
              select: {
                ownerId: true,
                shares: { select: { userId: true } },
              },
            },
          },
        });

        if (!parent) return { status: "parentNotFound" } as const;
        if (parent._count.children >= MAX_SUB_ITEMS_PER_ITEM) {
          return { status: "subItemLimit" } as const;
        }

        position = (parent.children[0]?.position ?? 0) + POSITION_STEP;
        notificationUserIds = listNotificationUserIds(parent.list);
      } else {
        // Проверяем, что пользователь является владельцем или участником списка.
        // Заодно забираем максимальную позицию верхнего уровня: новая запись
        // встаёт в конец. Отдельным запросом это стоило бы лишнего round-trip
        // до БД, поэтому берём его тем же запросом, что и проверку доступа.
        const list = await tx.list.findFirst({
          where: {
            id: listId,
            ...listInSpaceWhere(userId, space.id),
          },
          select: {
            id: true,
            ownerId: true,
            shares: { select: { userId: true } },
            items: {
              where: { parentId: null },
              orderBy: { position: "desc" },
              take: 1,
              select: { position: true },
            },
            // Считаются только пункты верхнего уровня: у подпунктов свой потолок,
            // общий счёт означал бы разное для разных списков.
            _count: { select: { items: { where: { parentId: null } } } },
          },
        });

        if (!list) return { status: "listNotFound" } as const;
        if (list._count.items >= MAX_ITEMS_PER_LIST) {
          return { status: "itemLimit" } as const;
        }

        position = (list.items[0]?.position ?? 0) + POSITION_STEP;
        notificationUserIds = listNotificationUserIds(list);
      }

      // После safeParse TypeScript точно знает, что itemName — string.
      await tx.item.create({
        data: {
          name: itemName,
          listId,
          parentId: parentItemId,
          addedById: userId,
          position,
        },
      });

      if (parentItemId) {
        // Новый подпункт снимает завершённость; начатость зависит от остальных.
        // Обновление кеша атомарно с INSERT.
        await syncParentCompletion(tx, parentItemId, listId);
      }

      return {
        status: "created",
        notificationUserIds,
      } as const;
    });

    if (creation.status === "parentNotFound") {
      return { success: false, error: "Пункт не найден" };
    }
    if (creation.status === "listNotFound") {
      return { success: false, error: "Список не найден" };
    }
    if (creation.status === "subItemLimit") {
      logger.warn(
        { uid: hashId(userId), listId, action: "addItem" },
        "Достигнут потолок подпунктов у пункта",
      );
      return { success: false, error: "subItemLimitReached" };
    }
    if (creation.status === "itemLimit") {
      logger.warn(
        { uid: hashId(userId), listId, action: "addItem" },
        "Достигнут потолок пунктов в списке",
      );
      return { success: false, error: "itemLimitReached" };
    }

    // Инвалидируем весь layout-дерево (/ и все локали) → перефетч Server Component
    revalidatePath("/", "layout");
    // Pusher-уведомление уходит ПОСЛЕ отправки ответа клиенту (after) —
    // не задерживает action. Вкладка автора исключается по socketId:
    // ей свежие данные приходят вместе с ответом action (revalidatePath).
    const socketId = formData.get("socketId");
    after(() => notifyUsers(creation.notificationUserIds, socketId));
    logger.info({ uid: hashId(userId), listId, action: "addItem" }, "Запись добавлена");
    return { success: true };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при добавлении записи:");
    return { success: false, error: "Не удалось добавить запись" };
  }
}

/**
 * Удаляет запись из списка по её ID.
 *
 * Используется оптимистично: запись исчезает с экрана немедленно,
 * а эта функция удаляет его из БД в фоне.
 *
 * @param formData - FormData с полем:
 *   - `itemId` {string} — ID удаляемой записи.
 * @returns `void` (ошибки логируются в консоль, но не передаются клиенту).
 */
export async function deleteItem(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) return;
  const userId = session.user.id;
  // Бюджет списывается и здесь. Действие ничего не возвращает клиенту по
  // существующему контракту, поэтому отказ виден не сразу: оптимистичное
  // состояние держится до следующего обновления страницы. Это то же
  // поведение, что и у любого другого сбоя этих двух действий.
  if (!(await consumeMutationBudget(userId))) return;
  const space = await resolveActionSpace(userId, formData);
  if (!space) return;

  const data = { itemId: formData.get("itemId") };

  const result = deleteItemSchema.safeParse(data);

  if (!result.success) {
    logger.error({ error: result.error }, "Validation Error:");
    return;
  }

  const deletion = await withSpaceDb(userId, space.id, async (tx) => {
    // Получаем listId до удаления и одновременно проверяем права доступа.
    // parentId нужен, чтобы после удаления подпункта пересчитать родителя.
    const item = await tx.item.findFirst({
      where: {
        id: result.data.itemId,
        list: listInSpaceWhere(userId, space.id),
      },
      select: {
        listId: true,
        parentId: true,
        list: {
          select: {
            ownerId: true,
            shares: { select: { userId: true } },
          },
        },
      },
    });
    if (!item) return null;

    // Подпункты удаляемого пункта уходят каскадом на уровне БД (составной FK
    // с onDelete: Cascade), поэтому отдельного запроса на них нет.
    await tx.item.delete({ where: { id: result.data.itemId } });

    if (item.parentId) {
      // Удалённый подпункт мог быть последним невыполненным — тогда родитель
      // становится выполненным. Пересчёт атомарен с удалением.
      await syncParentCompletion(tx, item.parentId, item.listId);
    }

    return {
      listId: item.listId,
      notificationUserIds: listNotificationUserIds(item.list),
    };
  });

  // Если item не найден или нет доступа — молча выходим.
  if (!deletion) return;

  revalidatePath("/", "layout");
  // Уведомление после ответа (after), без эха вкладке автора (socketId)
  const socketId = formData.get("socketId");
  after(() => notifyUsers(deletion.notificationUserIds, socketId));
  logger.info({ uid: hashId(userId), listId: deletion.listId, action: "deleteItem" }, "Запись удалена");
}

/**
 * Переключает статус записи: "выполнено" ↔ "не выполнено".
 *
 * Важный нюанс: FormData всегда возвращает строки.
 * Поэтому `isCompleted` нужно явно преобразовать до отправки в схему:
 * `formData.get("isCompleted") === "true"` → `true | false`.
 *
 * Логика: мы передаём ТЕКУЩЕЕ значение `isCompleted`, а в БД сохраняем ИНВЕРСИЮ.
 * Присланное значение — то, что видел пользователь на экране: если чужая
 * правка успела прийти раньше, результат всё равно соответствует его намерению.
 *
 * Подпункты меняют смысл операции в обе стороны:
 *   - у пункта с подпунктами собственной отметки нет, она производная, поэтому
 *     клик по нему означает «проставить это значение всем подпунктам»;
 *   - клик по подпункту меняет только его, а родитель пересчитывается по итогу.
 *
 * @param formData - FormData с полями:
 *   - `itemId`      {string} — ID записи.
 *   - `isCompleted` {string} — текущий статус ("true" | "false").
 * @returns `void`.
 */
export async function toggleItem(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) return;
  const userId = session.user.id;
  // Бюджет списывается и здесь. Действие ничего не возвращает клиенту по
  // существующему контракту, поэтому отказ виден не сразу: оптимистичное
  // состояние держится до следующего обновления страницы. Это то же
  // поведение, что и у любого другого сбоя этих двух действий.
  if (!(await consumeMutationBudget(userId))) return;
  const space = await resolveActionSpace(userId, formData);
  if (!space) return;

  const data = {
    itemId: formData.get("itemId"),
    // FormData возвращает строки → явно преобразуем в boolean
    isCompleted: formData.get("isCompleted") === "true",
  };

  const result = toggleItemSchema.safeParse(data);

  if (!result.success) {
    logger.error({ error: result.error }, "Validation Error:");
    return;
  }

  const isCompleted = !result.data.isCompleted; // Инвертируем текущее значение
  const toggled = await withSpaceDb(userId, space.id, async (tx) => {
    // Проверяем права доступа перед обновлением. Заодно узнаём положение записи
    // в дереве: подпункт она или пункт, и есть ли у неё свои подпункты.
    const item = await tx.item.findFirst({
      where: {
        id: result.data.itemId,
        list: listInSpaceWhere(userId, space.id),
      },
      select: {
        listId: true,
        parentId: true,
        _count: { select: { children: true } },
        list: {
          select: {
            ownerId: true,
            shares: { select: { userId: true } },
          },
        },
      },
    });
    if (!item) return null;

    if (item._count.children > 0) {
      // Каскад вниз. Собственное поле пункта пишется вместе с подпунктами: на
      // чтении оно не используется, но остаётся согласованным кешем.
      await tx.item.updateMany({
        where: { parentId: result.data.itemId, listId: item.listId },
        data: { isCompleted, status: isCompleted ? "COMPLETED" : "NOT_STARTED" },
      });
      await tx.item.update({
        where: { id: result.data.itemId },
        data: { isCompleted, status: isCompleted ? "COMPLETED" : "NOT_STARTED" },
      });
    } else if (item.parentId) {
      // Каскад вверх. Пересчёт родителя видит уже изменённый подпункт.
      await tx.item.update({
        where: { id: result.data.itemId },
        data: { isCompleted, status: isCompleted ? "COMPLETED" : "NOT_STARTED" },
      });
      await syncParentCompletion(tx, item.parentId, item.listId);
    } else {
      await tx.item.update({
        where: { id: result.data.itemId },
        data: { isCompleted, status: isCompleted ? "COMPLETED" : "NOT_STARTED" },
      });
    }

    return {
      listId: item.listId,
      notificationUserIds: listNotificationUserIds(item.list),
    };
  });

  if (!toggled) return;

  revalidatePath("/", "layout");
  // Уведомление после ответа (after), без эха вкладке автора (socketId)
  const socketId = formData.get("socketId");
  after(() => notifyUsers(toggled.notificationUserIds, socketId));
  logger.info({ uid: hashId(userId), listId: toggled.listId, completed: isCompleted, action: "toggleItem" }, "Статус записи изменён");
}

/** Меняет состояние содержимого с теми же правами owner/editor и scoped-контекстом. */
export async function setItemStatus(formData: FormData) {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "unauthorized" };
  const userId = session.user.id;
  if (!(await consumeMutationBudget(userId))) return { success: false, error: "dailyLimitReached" };
  const parsed = setItemStatusSchema.safeParse({
    itemId: formData.get("itemId"),
    status: formData.get("status"),
  });
  if (!parsed.success) return { success: false, error: "validationError" };
  const space = await resolveActionSpace(userId, formData);
  if (!space) return { success: false, error: "notFound" };
  const { itemId, status } = parsed.data;
  const changed = await withSpaceDb(userId, space.id, async (tx) => {
    const item = await tx.item.findFirst({
      where: { id: itemId, list: listInSpaceWhere(userId, space.id) },
      select: {
        listId: true,
        parentId: true,
        list: {
          select: { ownerId: true, shares: { select: { userId: true } } },
        },
      },
    });
    if (!item) return null;
    const data = { status, isCompleted: status === "COMPLETED" };
    await tx.item.update({ where: { id: itemId }, data });
    if (item.parentId) {
      await syncParentCompletion(tx, item.parentId, item.listId);
    } else {
      await tx.item.updateMany({
        where: {
          parentId: itemId,
          listId: item.listId,
          ...((status === "IN_PROGRESS" || status === "DEFERRED") ? { isCompleted: false } : {}),
        },
        data,
      });
      await syncParentCompletion(tx, itemId, item.listId);
    }
    return { notificationUserIds: listNotificationUserIds(item.list) };
  });
  if (!changed) return { success: false, error: "notFound" };
  revalidatePath("/", "layout");
  const socketId = formData.get("socketId");
  after(() => notifyUsers(changed.notificationUserIds, socketId));
  return { success: true };
}

/**
 * Переименовывает запись в списке.
 *
 * Доступно владельцу списка и пользователям, которым список расшарен.
 *
 * @param formData - FormData с полями:
 *   - `itemId`   {string} — ID переименовываемой записи.
 *   - `itemName` {string} — новое название (1–100 символов).
 * @returns `{ success: true }` или `{ success: false, error: string }`.
 */
export async function renameItem(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }
    const userId = session.user.id;

    if (!(await consumeMutationBudget(userId))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(userId, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const rawData = {
      itemId: formData.get("itemId"),
      itemName: formData.get("itemName"),
    };

    const result = renameItemSchema.safeParse(rawData);
    if (!result.success) {
      return {
        success: false,
        error: getValidationError(result.error),
      };
    }

    const renamedItem = await withSpaceDb(userId, space.id, async (tx) => {
      const item = await tx.item.findFirst({
        where: {
          id: result.data.itemId,
          list: listInSpaceWhere(userId, space.id),
        },
        select: {
          listId: true,
          list: {
            select: {
              ownerId: true,
              shares: { select: { userId: true } },
            },
          },
        },
      });
      if (!item) return null;

      // Условие доступа повторяется в UPDATE: если share отозван между
      // SELECT и записью, операция завершится fail-closed.
      const renamed = await tx.item.updateMany({
        where: {
          id: result.data.itemId,
          list: listInSpaceWhere(userId, space.id),
        },
        data: { name: result.data.itemName },
      });
      if (renamed.count === 0) return null;

      return {
        listId: item.listId,
        notificationUserIds: listNotificationUserIds(item.list),
      };
    });

    if (!renamedItem) {
      return { success: false, error: "Запись не найдена" };
    }

    revalidatePath("/", "layout");
    // Уведомление после ответа (after), без эха вкладке автора (socketId)
    const socketId = formData.get("socketId");
    after(() => notifyUsers(renamedItem.notificationUserIds, socketId));
    logger.info({ uid: hashId(userId), listId: renamedItem.listId, action: "renameItem" }, "Запись переименована");
    return { success: true };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при переименовании записи:");
    return { success: false, error: "Не удалось переименовать запись" };
  }
}

/**
 * Перемещает запись внутри списка.
 *
 * Клиент присылает ID новых соседей, а не целевой индекс: индекс мог устареть,
 * пока другой участник добавлял или удалял записи. Позиции соседей читаются
 * из БД — присланным клиентом значениям доверять нельзя.
 *
 * Обычный путь пишет ОДНУ строку: новая позиция это середина между позициями
 * соседей. Перенумерация всего списка выполняется только в вырожденном случае,
 * когда дробное деление исчерпало точность double (см. ниже).
 *
 * @param formData - FormData с полями:
 *   - `itemId`         {string} — ID перемещаемой записи.
 *   - `previousItemId` {string} — ID записи, после которой встать ("" — в начало).
 *   - `nextItemId`     {string} — ID записи, перед которой встать ("" — в конец).
 * @returns `{ success: true }` или `{ success: false, error: string }`.
 */
export async function moveItem(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }
    const userId = session.user.id;

    if (!(await consumeMutationBudget(userId))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(userId, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const result = moveItemSchema.safeParse({
      itemId: formData.get("itemId"),
      // FormData не умеет передавать null: пустая строка означает край списка.
      previousItemId: formData.get("previousItemId") || null,
      nextItemId: formData.get("nextItemId") || null,
    });

    if (!result.success) {
      logger.error({ error: result.error }, "Validation Error:");
      return { success: false, error: getValidationError(result.error) };
    }

    const { itemId, previousItemId, nextItemId } = result.data;

    const movement = await withSpaceDb(
      userId,
      space.id,
      async (tx) => {
        // Один запрос закрывает доступ, принадлежность записи списку и позиции.
        const list = await tx.list.findFirst({
          where: {
            items: { some: { id: itemId } },
            ...listInSpaceWhere(userId, space.id),
          },
          select: {
            id: true,
            ownerId: true,
            shares: { select: { userId: true } },
            items: {
              orderBy: [
                { position: "asc" },
                { createdAt: "asc" },
                { id: "asc" },
              ],
              select: { id: true, position: true, parentId: true },
            },
          },
        });
        if (!list) return { status: "notFound" } as const;

        // Позиции сравнимы только внутри одного уровня дерева.
        const moving = list.items.find((item) => item.id === itemId);
        if (!moving) return { status: "notFound" } as const;
        const siblings = list.items.filter(
          (item) => item.parentId === moving.parentId,
        );

        const previous = previousItemId
          ? (siblings.find((item) => item.id === previousItemId) ?? null)
          : null;
        const next = nextItemId
          ? (siblings.find((item) => item.id === nextItemId) ?? null)
          : null;
        if ((previousItemId && !previous) || (nextItemId && !next)) {
          return { status: "stale" } as const;
        }

        const lowestPosition = siblings[0].position;
        const highestPosition = siblings[siblings.length - 1].position;
        let newPosition: number;
        if (previous && next) {
          newPosition = (previous.position + next.position) / 2;
        } else if (previous) {
          newPosition = highestPosition + POSITION_STEP;
        } else if (next) {
          newPosition = lowestPosition - POSITION_STEP;
        } else {
          return { status: "unchanged" } as const;
        }

        const needsRebalance =
          previous !== null &&
          next !== null &&
          (newPosition <= previous.position || newPosition >= next.position);

        if (needsRebalance) {
          // Rebalance уже атомарен внутри scoped callback, вложенная транзакция
          // здесь лишь потеряла бы установленный transaction-local контекст.
          const reordered = siblings.filter((item) => item.id !== itemId);
          const insertAt = previous
            ? reordered.findIndex((item) => item.id === previous.id) + 1
            : 0;
          reordered.splice(insertAt, 0, {
            id: itemId,
            position: newPosition,
            parentId: moving.parentId,
          });
          await Promise.all(
            reordered.map((item, index) =>
              tx.item.update({
                where: { id: item.id },
                data: { position: (index + 1) * POSITION_STEP },
              }),
            ),
          );
        } else {
          await tx.item.update({
            where: { id: itemId },
            data: { position: newPosition },
          });
        }

        return {
          status: "moved",
          listId: list.id,
          notificationUserIds: listNotificationUserIds(list),
          rebalanced: needsRebalance,
        } as const;
      },
    );

    if (movement.status === "notFound") {
      return { success: false, error: "Запись не найдена" };
    }
    if (movement.status === "stale") {
      return { success: false, error: "stale" };
    }
    if (movement.status === "unchanged") {
      return { success: true };
    }
    if (movement.rebalanced) {
      logger.info(
        {
          uid: hashId(userId),
          listId: movement.listId,
          action: "moveItem",
        },
        "Позиции записей перенумерованы: исчерпана точность дробной позиции",
      );
    }

    revalidatePath("/", "layout");
    // Уведомление после ответа (after), без эха вкладке автора (socketId)
    const socketId = formData.get("socketId");
    after(() => notifyUsers(movement.notificationUserIds, socketId));
    logger.info(
      { uid: hashId(userId), listId: movement.listId, action: "moveItem" },
      "Запись перемещена",
    );
    return { success: true };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при перемещении записи:");
    return { success: false, error: "Не удалось переместить запись" };
  }
}

/**
 * Переносит или копирует запись в другой список ТОГО ЖЕ пространства.
 *
 * Ограничение «в рамках пространства» не требует отдельного кода: оба списка
 * ищутся через `listInSpaceWhere` с одним и тем же `spaceId`, поэтому список
 * из другого пространства просто не найдётся.
 *
 * Перенос — это одна запись в БД: у существующей строки меняются `listId` и
 * `position`. Заметка, её версия, автор и `createdAt` едут со строкой сами.
 * Подпункты тоже: составной внешний ключ `(parentId, listId)` объявлен с
 * ON UPDATE CASCADE, поэтому смена `listId` у родителя переносит их на уровне
 * БД. Их позиции значимы внутри родителя и потому не меняются.
 *
 * Копирование создаёт новую строку: `noteVersion` начинается с нуля (у новой
 * строки свой счётчик optimistic concurrency), автором становится тот, кто
 * копировал, а отметка о выполнении сбрасывается — копию заводят, чтобы
 * сделать дело заново в другом списке. Подпункты копируются по тем же
 * правилам и сохраняют свой порядок.
 *
 * Сам подпункт перенести нельзя: он принадлежит родителю, а не списку.
 * Интерфейс такого пункта меню не показывает, но присланному ID доверять
 * нельзя, поэтому проверка есть и здесь.
 *
 * Запись встаёт в конец целевого списка, как при обычном добавлении.
 *
 * @param formData - FormData с полями:
 *   - `itemId`       {string} — ID переносимой записи.
 *   - `targetListId` {string} — ID списка-получателя.
 *   - `mode`         {string} — "move" | "copy".
 * @returns `{ success: true }` или `{ success: false, error: string }`.
 */
export async function moveItemToList(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }
    const userId = session.user.id;

    if (!(await consumeMutationBudget(userId))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(userId, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const result = moveItemToListSchema.safeParse({
      itemId: formData.get("itemId"),
      targetListId: formData.get("targetListId"),
      mode: formData.get("mode"),
    });

    if (!result.success) {
      logger.error({ error: result.error }, "Validation Error:");
      return { success: false, error: getValidationError(result.error) };
    }

    const { itemId, targetListId, mode } = result.data;

    const mutation = await withSpaceDb(
      userId,
      space.id,
      async (tx) => {
        // Исходная запись, оба списка и все записи меняются в одном контексте:
        // будущая RLS-политика видит одну пару app.user_id/app.space_id.
        const item = await tx.item.findFirst({
          where: {
            id: itemId,
            list: listInSpaceWhere(userId, space.id),
          },
          select: {
            id: true,
            name: true,
            note: true,
            listId: true,
            parentId: true,
            list: {
              select: {
                ownerId: true,
                shares: { select: { userId: true } },
              },
            },
            children: {
              orderBy: [
                { position: "asc" },
                { createdAt: "asc" },
                { id: "asc" },
              ],
              select: { name: true, note: true, position: true },
            },
          },
        });
        if (!item) return { status: "itemNotFound" } as const;
        if (item.parentId) return { status: "subItem" } as const;
        if (item.listId === targetListId) {
          return { status: "sameList" } as const;
        }

        const targetList = await tx.list.findFirst({
          where: {
            id: targetListId,
            ...listInSpaceWhere(userId, space.id),
          },
          select: {
            id: true,
            ownerId: true,
            shares: { select: { userId: true } },
            items: {
              where: { parentId: null },
              orderBy: { position: "desc" },
              take: 1,
              select: { position: true },
            },
            _count: { select: { items: { where: { parentId: null } } } },
          },
        });
        if (!targetList) return { status: "listNotFound" } as const;
        if (targetList._count.items >= MAX_ITEMS_PER_LIST) {
          return { status: "itemLimit" } as const;
        }

        const position =
          (targetList.items[0]?.position ?? 0) + POSITION_STEP;
        if (mode === "move") {
          // Составной FK каскадно переносит listId подпунктов вместе с родителем.
          await tx.item.update({
            where: { id: itemId },
            data: { listId: targetListId, position },
          });
        } else {
          const copyData = {
            name: item.name,
            note: item.note,
            noteUpdatedAt: item.note ? new Date() : null,
            listId: targetListId,
            addedById: userId,
            position,
          };
          const copy = await tx.item.create({
            data: copyData,
            select: { id: true },
          });
          if (item.children.length > 0) {
            await tx.item.createMany({
              data: item.children.map((child) => ({
                name: child.name,
                note: child.note,
                noteUpdatedAt: child.note ? new Date() : null,
                listId: targetListId,
                parentId: copy.id,
                addedById: userId,
                position: child.position,
              })),
            });
          }
        }

        const sourceUserIds = listNotificationUserIds(item.list);
        const targetUserIds = listNotificationUserIds(targetList);
        return {
          status: "mutated",
          sourceListId: item.listId,
          notificationUserIds:
            mode === "move"
              ? [...new Set([...sourceUserIds, ...targetUserIds])]
              : targetUserIds,
        } as const;
      },
    );

    if (mutation.status === "itemNotFound") {
      return { success: false, error: "Запись не найдена" };
    }
    if (mutation.status === "subItem") {
      return { success: false, error: "subItem" };
    }
    if (mutation.status === "sameList") {
      return { success: false, error: "sameList" };
    }
    if (mutation.status === "listNotFound") {
      return { success: false, error: "Список не найден" };
    }
    if (mutation.status === "itemLimit") {
      logger.warn(
        {
          uid: hashId(userId),
          listId: targetListId,
          action: "moveItemToList",
        },
        "Целевой список достиг потолка пунктов",
      );
      return { success: false, error: "itemLimitReached" };
    }

    revalidatePath("/", "layout");
    // Получатели собраны до commit; after не открывает tenant-контекст заново.
    const socketId = formData.get("socketId");
    after(() => notifyUsers(mutation.notificationUserIds, socketId));
    logger.info(
      {
        uid: hashId(userId),
        listId: mutation.sourceListId,
        targetListId,
        action: mode === "move" ? "moveItemToList" : "copyItemToList",
      },
      "Запись перенесена в другой список",
    );
    return { success: true };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при переносе записи в другой список:");
    return { success: false, error: "Не удалось перенести запись" };
  }
}

/**
 * Сохраняет заметку записи с optimistic concurrency control.
 * Редактировать её может любой участник списка с ролью EDITOR.
 */
export async function updateItemNote(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }
    const userId = session.user.id;

    if (!(await consumeMutationBudget(userId))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(userId, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const result = updateItemNoteSchema.safeParse({
      itemId: formData.get("itemId"),
      note: formData.get("note"),
      expectedVersion: formData.get("expectedVersion"),
    });
    if (!result.success) {
      return { success: false, error: getValidationError(result.error) };
    }

    const note = normalizeNote(result.data.note);
    const mutation = await withSpaceDb(
      userId,
      space.id,
      async (tx) => {
        const current = await tx.item.findFirst({
          where: {
            id: result.data.itemId,
            list: listInSpaceWhere(userId, space.id),
          },
          select: {
            note: true,
            noteVersion: true,
            listId: true,
            list: {
              select: {
                ownerId: true,
                shares: { select: { userId: true } },
              },
            },
          },
        });
        if (!current) return { status: "notFound" } as const;

        if (current.noteVersion !== result.data.expectedVersion) {
          return {
            status: "conflict",
            currentNote: current.note,
            currentVersion: current.noteVersion,
          } as const;
        }

        if (current.note === note) {
          return {
            status: "unchanged",
            note,
            noteVersion: current.noteVersion,
          } as const;
        }

        const updated = await tx.item.updateMany({
          where: {
            id: result.data.itemId,
            noteVersion: result.data.expectedVersion,
            list: listInSpaceWhere(userId, space.id),
          },
          data: {
            note,
            noteVersion: { increment: 1 },
            noteUpdatedAt: new Date(),
          },
        });

        if (updated.count === 0) {
          const latest = await tx.item.findFirst({
            where: {
              id: result.data.itemId,
              list: listInSpaceWhere(userId, space.id),
            },
            select: { note: true, noteVersion: true },
          });
          return {
            status: "conflict",
            currentNote: latest?.note ?? null,
            currentVersion:
              latest?.noteVersion ?? result.data.expectedVersion,
          } as const;
        }

        return {
          status: "updated",
          note,
          noteVersion: result.data.expectedVersion + 1,
          listId: current.listId,
          notificationUserIds: [
            ...new Set([
              current.list.ownerId,
              ...current.list.shares.map((share) => share.userId),
            ]),
          ],
        } as const;
      },
    );

    if (mutation.status === "notFound") {
      return { success: false, error: "Запись не найдена" };
    }
    if (mutation.status === "conflict") {
      return {
        success: false,
        error: "noteConflict",
        currentNote: mutation.currentNote,
        currentVersion: mutation.currentVersion,
      };
    }
    if (mutation.status === "unchanged") {
      return {
        success: true,
        note: mutation.note,
        noteVersion: mutation.noteVersion,
      };
    }

    revalidatePath("/", "layout");
    const socketId = formData.get("socketId");
    after(() =>
      notifyUsers([...mutation.notificationUserIds], socketId),
    );
    logger.info(
      {
        uid: hashId(userId),
        listId: mutation.listId,
        action: "updateItemNote",
      },
      "Заметка записи обновлена",
    );
    return {
      success: true,
      note: mutation.note,
      noteVersion: mutation.noteVersion,
    };
  } catch (error) {
    logger.error({ error }, "Ошибка при сохранении заметки записи:");
    return { success: false, error: "Не удалось сохранить заметку" };
  }
}

// ===========================================================================
// SERVER ACTIONS ДЛЯ СПИСКОВ (List)
// ===========================================================================

/**
 * Сохраняет общую заметку списка с optimistic concurrency control.
 * В отличие от названия списка, заметка доступна всем EDITOR-участникам.
 */
export async function updateListNote(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }
    const userId = session.user.id;

    if (!(await consumeMutationBudget(userId))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(userId, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const result = updateListNoteSchema.safeParse({
      listId: formData.get("listId"),
      note: formData.get("note"),
      expectedVersion: formData.get("expectedVersion"),
    });
    if (!result.success) {
      return { success: false, error: getValidationError(result.error) };
    }

    const note = normalizeNote(result.data.note);
    const mutation = await withSpaceDb(
      userId,
      space.id,
      async (tx) => {
        const current = await tx.list.findFirst({
          where: {
            id: result.data.listId,
            ...listInSpaceWhere(userId, space.id),
          },
          select: {
            note: true,
            noteVersion: true,
            ownerId: true,
            shares: { select: { userId: true } },
          },
        });
        if (!current) return { status: "notFound" } as const;

        if (current.noteVersion !== result.data.expectedVersion) {
          return {
            status: "conflict",
            currentNote: current.note,
            currentVersion: current.noteVersion,
          } as const;
        }

        if (current.note === note) {
          return {
            status: "unchanged",
            note,
            noteVersion: current.noteVersion,
          } as const;
        }

        const updated = await tx.list.updateMany({
          where: {
            id: result.data.listId,
            noteVersion: result.data.expectedVersion,
            ...listInSpaceWhere(userId, space.id),
          },
          data: {
            note,
            noteVersion: { increment: 1 },
            noteUpdatedAt: new Date(),
          },
        });

        if (updated.count === 0) {
          const latest = await tx.list.findFirst({
            where: {
              id: result.data.listId,
              ...listInSpaceWhere(userId, space.id),
            },
            select: { note: true, noteVersion: true },
          });
          return {
            status: "conflict",
            currentNote: latest?.note ?? null,
            currentVersion:
              latest?.noteVersion ?? result.data.expectedVersion,
          } as const;
        }

        return {
          status: "updated",
          note,
          noteVersion: result.data.expectedVersion + 1,
          notificationUserIds: [
            ...new Set([
              current.ownerId,
              ...current.shares.map((share) => share.userId),
            ]),
          ],
        } as const;
      },
    );

    if (mutation.status === "notFound") {
      return { success: false, error: "Список не найден" };
    }
    if (mutation.status === "conflict") {
      return {
        success: false,
        error: "noteConflict",
        currentNote: mutation.currentNote,
        currentVersion: mutation.currentVersion,
      };
    }
    if (mutation.status === "unchanged") {
      return {
        success: true,
        note: mutation.note,
        noteVersion: mutation.noteVersion,
      };
    }

    revalidatePath("/", "layout");
    const socketId = formData.get("socketId");
    after(() =>
      notifyUsers([...mutation.notificationUserIds], socketId),
    );
    logger.info(
      { uid: hashId(userId), listId: result.data.listId, action: "updateListNote" },
      "Заметка списка обновлена",
    );
    return {
      success: true,
      note: mutation.note,
      noteVersion: mutation.noteVersion,
    };
  } catch (error) {
    logger.error({ error }, "Ошибка при сохранении заметки списка:");
    return { success: false, error: "Не удалось сохранить заметку" };
  }
}

/**
 * Создаёт новый список для авторизованного пользователя.
 *
 * Ключевой принцип безопасности: `ownerId` берётся из серверной сессии,
 * а не из FormData. Клиент не может подменить владельца списка.
 *
 * @param formData - FormData с полем:
 *   - `title` {string} — название списка (1–50 символов).
 * @returns
 *   - `{ success: true, list: ListData }` — созданный список с полными данными.
 *   - `{ success: false, error: string }` — ошибка авторизации или валидации.
 */
export async function createList(formData: FormData) {
  try {
    // 1. Проверяем авторизацию НА СЕРВЕРЕ
    const session = await auth();
    if (!session || !session.user || !session.user.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(session.user.id, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    // 2. Валидация данных
    const rawData = {
      title: formData.get("title"),
      groupId: formData.get("groupId") ?? undefined,
    };

    const result = createListSchema.safeParse(rawData);

    if (!result.success) {
      return {
        success: false,
        error: getValidationError(result.error),
      };
    }

    const creation = await withSpaceDb(
      session.user.id,
      space.id,
      async (tx) => {
        // Потолок на размер пространства. Без сериализации: при 200 списках
        // небольшой конкурентный перебор допустим и ограничен mutation budget.
        const listsInSpace = await tx.list.count({
          where: { ownerId: space.userId, spaceId: space.id },
        });
        if (listsInSpace >= MAX_LISTS_PER_SPACE) {
          return { status: "limitReached" } as const;
        }

        // Если список создаётся из активной группы, группа и начальная позиция
        // проверяются в том же scoped-контексте, что и nested create.
        let initialMembership: {
          group: { id: string; name: string };
          position: number;
        } | null = null;
        if (result.data.groupId) {
          const group = await tx.listGroup.findFirst({
            where: {
              id: result.data.groupId,
              userId: space.userId,
              spaceId: space.id,
            },
            select: { id: true, name: true },
          });
          if (!group) return { status: "groupNotFound" } as const;

          const firstMembership = await tx.listGroupMembership.findFirst({
            where: { groupId: group.id },
            orderBy: { position: "asc" },
            select: { position: true },
          });
          initialMembership = {
            group,
            position: firstMembership
              ? firstMembership.position - POSITION_STEP
              : POSITION_STEP,
          };
        }

        // Список и начальное членство создаются одной атомарной Prisma-
        // операцией. ownerId всегда берётся из подтверждённой сессии.
        const list = await tx.list.create({
          data: {
            title: result.data.title,
            ownerId: space.userId,
            spaceId: space.id,
            groupMemberships: initialMembership
              ? {
                  create: {
                    groupId: initialMembership.group.id,
                    position: initialMembership.position,
                  },
                }
              : undefined,
          },
          include: {
            owner: true,
            items: {
              include: {
                addedBy: {
                  select: { id: true, name: true, email: true },
                },
              },
            },
          },
        });

        return { status: "created", list, initialMembership } as const;
      },
    );

    if (creation.status === "limitReached") {
      logger.warn(
        { uid: hashId(session.user.id), spaceId: space.id, action: "createList" },
        "Достигнут потолок списков в пространстве",
      );
      return { success: false, error: "listLimitReached" };
    }
    if (creation.status === "groupNotFound") {
      return { success: false, error: "Группа не найдена" };
    }

    const newList = creation.list;
    const initialMembership = creation.initialMembership;

    const listGroups = initialMembership
      ? [
          {
            id: initialMembership.group.id,
            name: initialMembership.group.name,
            position: initialMembership.position,
          },
        ]
      : [];

    revalidatePath("/", "layout");
    // Уведомление после ответа (after), без эха вкладке автора (socketId)
    const socketId = formData.get("socketId");
    after(() => notifyUsers([space.userId], socketId));
    logger.info({ uid: hashId(session.user.id), listId: newList.id, action: "createList" }, "Список создан");

    // Возвращаем только нужные поля (не весь объект Prisma)
    return {
      success: true,
      list: {
        id: newList.id,
        title: newList.title,
        note: newList.note,
        noteVersion: newList.noteVersion,
        aiEnabled: newList.aiEnabled,
        ownerId: newList.ownerId,
        owner: {
          name: newList.owner.name,
          email: newList.owner.email,
        },
        items: newList.items.map((item) => ({
          id: item.id,
          name: item.name,
          note: item.note,
          noteVersion: item.noteVersion,
          isCompleted: item.isCompleted,
          status: item.status,
          parentId: item.parentId,
          addedBy: item.addedBy
            ? {
                id: item.addedBy.id,
                name: item.addedBy.name,
                email: item.addedBy.email,
              }
            : null,
        })),
        sharedWith: [],
        groups: listGroups,
        // Новый список вложений ещё не имеет — поле обязательно для типа ListData.
        files: [],
      },
    };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при создании списка:");
    return { success: false, error: "Не удалось создать список" };
  }
}

/**
 * Удаляет список.
 *
 * Защита: `deleteMany` с фильтром `ownerId === session.user.id` гарантирует,
 * что только владелец может удалить свой список. Если `deleted.count === 0`,
 * значит запись не найдена или пользователь не является владельцем.
 *
 * @param formData - FormData с полем:
 *   - `listId` {string} — ID удаляемого списка.
 * @returns `{ success: true }` или `{ success: false, error: string }`.
 */
export async function deleteList(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(session.user.id, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const rawData = {
      listId: formData.get("listId"),
    };

    const result = deleteListSchema.safeParse(rawData);
    if (!result.success) {
      return { success: false, error: "Неверные данные" };
    }

    const deletion = await withSpaceDb(
      session.user.id,
      space.id,
      async (tx) => {
        // Участники и ключи должны быть собраны до каскадного удаления, но
        // внутри той же транзакции: наружу выйдет уже готовый post-commit payload.
        const list = await tx.list.findFirst({
          where: {
            id: result.data.listId,
            ownerId: space.userId,
            spaceId: space.id,
          },
          select: {
            ownerId: true,
            shares: { select: { userId: true } },
            files: { select: { key: true } },
          },
        });
        if (!list) return null;

        const deleted = await tx.list.deleteMany({
          where: {
            id: result.data.listId,
            ownerId: space.userId,
            spaceId: space.id,
          },
        });
        if (deleted.count === 0) return null;

        await writeAuditEvent(tx, {
          action: "LIST_DELETED",
          spaceId: space.id,
          listId: result.data.listId,
        });

        return {
          fileKeys: list.files.map((file) => file.key),
          userIds: [
            list.ownerId,
            ...list.shares.map((share) => share.userId),
          ],
        };
      },
    );

    if (!deletion) {
      return {
        success: false,
        error: "Только владелец может удалить список",
      };
    }

    // S3-уборка батчем — best-effort. Удаление списка НЕ блокируется её успехом:
    // при сбое останется редкий невидимый сирота в бакете (дешевле битой ссылки).
    if (deletion.fileKeys.length > 0) {
      try {
        await deleteObjects(deletion.fileKeys);
      } catch (s3Error) {
        logger.error(
          { error: s3Error, listId: result.data.listId, action: "deleteList" },
          "Не удалось удалить вложения списка из S3 (осиротевшие файлы)",
        );
      }
    }

    revalidatePath("/", "layout");
    // Уведомляем всех участников после удаления (используем заранее собранные ID).
    // after — после отправки ответа; socketId исключает вкладку автора из эха.
    const socketId = formData.get("socketId");
    after(() => notifyUsers(deletion.userIds, socketId));
    logger.info({ uid: hashId(session.user.id), listId: result.data.listId, action: "deleteList" }, "Список удалён");
    return { success: true };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при удалении списка:");
    return { success: false, error: "Не удалось удалить список" };
  }
}

/**
 * Предоставляет совместный доступ к списку другому пользователю.
 *
 * Порядок операций:
 *   1. Проверяем авторизацию.
 *   2. Валидируем listId и email приглашённого.
 *   3. Ищем пользователя с таким email в БД.
 *   4. Запрещаем приглашать самого себя.
 *   5. Создаём явную запись доступа `ListShare`.
 *
 * Защита: `update` с условием `ownerId === session.user.id` гарантирует,
 * что только владелец списка может приглашать других.
 *
 * @param formData - FormData с полями:
 *   - `listId` {string} — ID списка.
 *   - `email`  {string} — email приглашаемого пользователя.
 * @returns
 *   - `{ success: true, user: SharedUser }` — данные добавленного пользователя.
 *   - `{ success: false, error: string }` — описание ошибки.
 */
export async function shareList(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const ownerId = session.user.id;
    const space = await resolveActionSpace(ownerId, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const rawData = {
      listId: formData.get("listId"),
      email: formData.get("email"),
    };

    const result = shareListSchema.safeParse(rawData);
    if (!result.success) {
      return { success: false, error: "Неверные данные" };
    }

    const sharing = await withSpaceDb(ownerId, space.id, async (tx) => {
      // Сначала подтверждаем право на список. Так чужой listId нельзя
      // использовать как oracle существования зарегистрированных email.
      const ownedList = await tx.list.findFirst({
        where: { id: result.data.listId, ownerId, spaceId: space.id },
        select: { id: true, ownerId: true },
      });
      if (!ownedList) return { status: "listNotFound" } as const;

      const recipient = await tx.user.findUnique({
        where: { email: result.data.email },
        select: { id: true, name: true, email: true },
      });
      if (!recipient) return { status: "userNotFound" } as const;
      if (recipient.id === ownerId) return { status: "selfShare" } as const;

      // Default-space гарантирован backfill-миграцией и Auth.js createUser.
      // Здесь намеренно нет ensureSpaceState(recipient.id): Action не должен
      // устанавливать tenant-контекст другого пользователя. Составной FK
      // ListShare(spaceId, userId) остановит операцию fail-closed, если
      // инфраструктурный инвариант неожиданно нарушен.
      const created = await tx.listShare.createMany({
        data: [
          {
            listId: ownedList.id,
            userId: recipient.id,
            spaceId: defaultSpaceId(recipient.id),
          },
        ],
        skipDuplicates: true,
      });
      if (created.count > 0) {
        await writeAuditEvent(tx, {
          action: "LIST_SHARE_GRANTED",
          spaceId: space.id,
          listId: ownedList.id,
          subjectUserId: recipient.id,
        });
      }

      const shares = await tx.listShare.findMany({
        where: { listId: ownedList.id },
        select: { userId: true },
      });
      return {
        status: "shared",
        recipient,
        notificationUserIds: [
          ownedList.ownerId,
          ...shares.map((share) => share.userId),
        ],
      } as const;
    });

    if (sharing.status === "listNotFound") {
      return { success: false, error: "Не удалось предоставить доступ" };
    }
    if (sharing.status === "userNotFound") {
      return {
        success: false,
        error: "Пользователь с таким email не найден",
      };
    }
    if (sharing.status === "selfShare") {
      return {
        success: false,
        error: "Нельзя поделиться списком с самим собой",
      };
    }

    revalidatePath("/", "layout");
    // Уведомление после ответа (after), без эха вкладке автора (socketId)
    const socketId = formData.get("socketId");
    after(() => notifyUsers([...sharing.notificationUserIds], socketId));
    logger.info({ uid: hashId(session.user.id), listId: result.data.listId, action: "shareList" }, "Доступ к списку предоставлен");

    return {
      success: true,
      user: {
        id: sharing.recipient.id,
        name: sharing.recipient.name,
        email: sharing.recipient.email,
      },
    };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при предоставлении доступа:");
    return {
      success: false,
      error: "Не удалось предоставить доступ",
    };
  }
}

/**
 * Убирает пользователя из совместного доступа к списку.
 *
 * Защита: `update` с условием `ownerId === session.user.id` гарантирует,
 * что только владелец может отзывать доступ.
 *
 * @param formData - FormData с полями:
 *   - `listId` {string} — ID списка.
 *   - `userId` {string} — ID пользователя, которого убирают.
 * @returns `{ success: true }` или `{ success: false, error: string }`.
 */
export async function removeSharedUser(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const ownerId = session.user.id;
    const space = await resolveActionSpace(ownerId, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const rawData = {
      listId: formData.get("listId"),
      userId: formData.get("userId"),
    };

    const result = removeSharedUserSchema.safeParse(rawData);
    if (!result.success) {
      return { success: false, error: "Неверные данные" };
    }

    const notificationUserIds = await withSpaceDb(
      ownerId,
      space.id,
      async (tx) => {
        const ownedList = await tx.list.findFirst({
          where: { id: result.data.listId, ownerId, spaceId: space.id },
          select: { id: true, ownerId: true },
        });
        if (!ownedList) return null;

        const deleted = await tx.listShare.deleteMany({
          where: { listId: ownedList.id, userId: result.data.userId },
        });
        if (deleted.count > 0) {
          await writeAuditEvent(tx, {
            action: "LIST_SHARE_REVOKED",
            spaceId: space.id,
            listId: ownedList.id,
            subjectUserId: result.data.userId,
          });
        }
        const remainingShares = await tx.listShare.findMany({
          where: { listId: ownedList.id },
          select: { userId: true },
        });

        return [
          ...(deleted.count > 0 ? [result.data.userId] : []),
          ownedList.ownerId,
          ...remainingShares.map((share) => share.userId),
        ];
      },
    );
    if (!notificationUserIds) {
      return { success: false, error: "Не удалось убрать доступ" };
    }

    revalidatePath("/", "layout");
    // Получатели собраны до/после удаления внутри scoped-транзакции:
    // удалённый участник получает refresh вместе с владельцем и оставшимися.
    const socketId = formData.get("socketId");
    after(() => notifyUsers(notificationUserIds, socketId));
    logger.info({ uid: hashId(session.user.id), listId: result.data.listId, action: "removeSharedUser" }, "Доступ к списку отозван");
    return { success: true };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при удалении доступа:");
    return { success: false, error: "Не удалось убрать доступ" };
  }
}

/**
 * Позволяет пользователю самостоятельно покинуть расшаренный список.
 *
 * В отличие от `removeSharedUser` (где действует владелец), здесь
 * действует сам пользователь: он удаляет собственную запись `ListShare`.
 *
 * Защита: удаляется только ListShare текущего пользователя в выбранном
 * пространстве, существование которой проверено перед операцией.
 *
 * @param formData - FormData с полем:
 *   - `listId` {string} — ID списка, от которого пользователь хочет отписаться.
 * @returns `{ success: true }` или `{ success: false, error: string }`.
 */
export async function leaveSharedList(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }

    const listId = formData.get("listId");
    if (!listId || typeof listId !== "string" || !listId.trim()) {
      return { success: false, error: "Неверные данные" };
    }
    const userId = session.user.id;
    const space = await resolveActionSpace(userId, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };
    const notificationUserIds = await withSpaceDb(
      userId,
      space.id,
      async (tx) => {
        // Получателей собираем до удаления: после него будущая RLS-политика
        // справедливо перестанет давать участнику доступ к строке списка.
        const share = await tx.listShare.findFirst({
          where: { listId, userId, spaceId: space.id },
          select: {
            list: {
              select: {
                ownerId: true,
                shares: { select: { userId: true } },
              },
            },
          },
        });
        if (!share) return null;

        const deleted = await tx.listShare.deleteMany({
          where: { listId, userId, spaceId: space.id },
        });
        if (deleted.count === 0) return null;

        await writeAuditEvent(tx, {
          action: "LIST_SHARE_LEFT",
          spaceId: space.id,
          listId,
          subjectUserId: userId,
        });

        return [
          ...new Set([
            userId,
            share.list.ownerId,
            ...share.list.shares.map((member) => member.userId),
          ]),
        ];
      },
    );
    if (!notificationUserIds) {
      return { success: false, error: "Список не найден" };
    }

    revalidatePath("/", "layout");
    // Список получателей включает вышедшего пользователя, владельца и остальных
    // участников; after не выполняет повторное tenant-чтение.
    const socketId = formData.get("socketId");
    after(() => notifyUsers(notificationUserIds, socketId));
    logger.info({ uid: hashId(session.user.id), listId, action: "leaveSharedList" }, "Пользователь покинул список");
    return { success: true };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при выходе из списка:");
    return { success: false, error: "Не удалось отписаться от списка" };
  }
}

/**
 * Разрешает или запрещает отправку содержимого списка в AI-сервис.
 *
 * Право есть у любого участника, а не только у владельца, и это осознанно.
 * Инсайт отправляет наружу содержимое целиком — включая заметки того, кто
 * список не создавал и кнопку не нажимал. Владельческая проверка оставила бы
 * такого человека ровно там же, где он был: он узнал бы о передаче, но
 * помешать ей всё равно не смог бы, кроме как выйдя из списка.
 *
 * @param formData - FormData с полями:
 *   - `listId`    {string} — ID списка.
 *   - `aiEnabled` {"true"|"false"} — желаемое состояние.
 * @returns `{ success: true }` или `{ success: false, error: string }`.
 */
export async function setListAiEnabled(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }

    const space = await resolveActionSpace(session.user.id, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const result = setListAiEnabledSchema.safeParse({
      listId: formData.get("listId"),
      aiEnabled: formData.get("aiEnabled"),
    });

    if (!result.success) {
      return { success: false, error: getValidationError(result.error) };
    }

    const { listId, aiEnabled } = result.data;

    const notificationUserIds = await withSpaceDb(
      session.user.id,
      space.id,
      async (tx) => {
        // Членство проверяется тем же `listInSpaceWhere`, что и везде: право
        // выключить AI есть и у владельца, и у editor текущего пространства.
        const updated = await tx.list.updateMany({
          where: {
            id: listId,
            ...listInSpaceWhere(space.userId, space.id),
          },
          data: { aiEnabled },
        });
        if (updated.count === 0) return null;

        await writeAuditEvent(tx, {
          action: "LIST_AI_ACCESS_CHANGED",
          spaceId: space.id,
          listId,
        });

        const list = await tx.list.findUniqueOrThrow({
          where: { id: listId },
          select: {
            ownerId: true,
            shares: { select: { userId: true } },
          },
        });
        return [
          list.ownerId,
          ...list.shares.map((share) => share.userId),
        ];
      },
    );

    if (!notificationUserIds) {
      return { success: false, error: "Список не найден" };
    }

    revalidatePath("/", "layout");
    const socketId = formData.get("socketId");
    // Уведомление обязательно: остальные участники должны увидеть новое
    // состояние сразу. Иначе один выключил бы AI, а другой продолжал бы
    // видеть кнопку и считать, что отправка разрешена.
    after(() => notifyUsers(notificationUserIds, socketId));
    logger.info(
      { uid: hashId(session.user.id), listId, aiEnabled, action: "setListAiEnabled" },
      "Изменён доступ AI к списку",
    );
    return { success: true };
  } catch (error) {
    logger.error({ error }, "Ошибка при изменении доступа AI к списку:");
    return { success: false, error: "Не удалось изменить настройку" };
  }
}

/**
 * Переименовывает список покупок.
 *
 * Защита: `updateMany` с фильтром `ownerId === session.user.id` гарантирует,
 * что только владелец может переименовать свой список.
 *
 * @param formData - FormData с полями:
 *   - `listId` {string} — ID переименовываемого списка.
 *   - `title`  {string} — новое название (1–50 символов).
 * @returns `{ success: true }` или `{ success: false, error: string }`.
 */
export async function renameList(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(session.user.id, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const rawData = {
      listId: formData.get("listId"),
      title: formData.get("title"),
    };

    const result = renameListSchema.safeParse(rawData);
    if (!result.success) {
      return {
        success: false,
        error: getValidationError(result.error),
      };
    }

    const notificationUserIds = await withSpaceDb(
      session.user.id,
      space.id,
      async (tx) => {
        // updateMany сохраняет атомарную владельческую проверку.
        const updated = await tx.list.updateMany({
          where: {
            id: result.data.listId,
            ownerId: space.userId,
            spaceId: space.id,
          },
          data: {
            title: result.data.title,
          },
        });
        if (updated.count === 0) return null;

        const list = await tx.list.findUniqueOrThrow({
          where: { id: result.data.listId },
          select: {
            ownerId: true,
            shares: { select: { userId: true } },
          },
        });
        return [
          list.ownerId,
          ...list.shares.map((share) => share.userId),
        ];
      },
    );

    if (!notificationUserIds) {
      return {
        success: false,
        error: "Только владелец может переименовать список",
      };
    }

    revalidatePath("/", "layout");
    // Уведомление после ответа (after), без эха вкладке автора (socketId)
    const socketId = formData.get("socketId");
    after(() => notifyUsers(notificationUserIds, socketId));
    logger.info({ uid: hashId(session.user.id), listId: result.data.listId, action: "renameList" }, "Список переименован");
    return { success: true };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при переименовании списка:");
    return { success: false, error: "Не удалось переименовать список" };
  }
}

// ===========================================================================
// SERVER ACTIONS ДЛЯ ГРУПП СПИСКОВ (ListGroup)
// ===========================================================================

/**
 * Создаёт новую группу списков для авторизованного пользователя.
 *
 * @param formData - FormData с полем:
 *   - `name` {string} — название группы (1–50 символов).
 * @returns `{ success: true, group: { id, name } }` или `{ success: false, error: string }`.
 */
export async function createGroup(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(session.user.id, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const rawData = { name: formData.get("name") };
    const result = createGroupSchema.safeParse(rawData);
    if (!result.success) {
      return {
        success: false,
        error: getValidationError(result.error),
      };
    }

    const creation = await withSpaceDb(
      session.user.id,
      space.id,
      async (tx) => {
        const groupsInSpace = await tx.listGroup.count({
          where: { userId: space.userId, spaceId: space.id },
        });
        if (groupsInSpace >= MAX_GROUPS_PER_SPACE) {
          return { status: "limitReached" } as const;
        }

        // Новая группа встаёт в конец текущего порядка. Тайбрейки createdAt/id
        // сохранят детерминированность даже при двух одновременных созданиях.
        const lastGroup = await tx.listGroup.findFirst({
          where: { userId: space.userId, spaceId: space.id },
          orderBy: [
            { position: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
          ],
          select: { position: true },
        });

        const group = await tx.listGroup.create({
          data: {
            name: result.data.name,
            userId: space.userId,
            spaceId: space.id,
            position: (lastGroup?.position ?? 0) + POSITION_STEP,
          },
          select: { id: true, name: true },
        });
        return { status: "created", group } as const;
      },
    );

    if (creation.status === "limitReached") {
      logger.warn(
        { uid: hashId(session.user.id), spaceId: space.id, action: "createGroup" },
        "Достигнут потолок групп в пространстве",
      );
      return { success: false, error: "groupLimitReached" };
    }

    revalidatePath("/", "layout");
    logger.info({ uid: hashId(session.user.id), groupId: creation.group.id, action: "createGroup" }, "Группа создана");
    return { success: true, group: creation.group };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при создании группы:");
    return { success: false, error: "Не удалось создать группу" };
  }
}

/**
 * Удаляет группу списков.
 * Списки из группы не удаляются — только связь списков с группой.
 *
 * @param formData - FormData с полем:
 *   - `groupId` {string} — ID удаляемой группы.
 * @returns `{ success: true }` или `{ success: false, error: string }`.
 */
export async function deleteGroup(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(session.user.id, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const rawData = { groupId: formData.get("groupId") };
    const result = deleteGroupSchema.safeParse(rawData);
    if (!result.success) {
      return { success: false, error: "Неверные данные" };
    }

    // deleteMany с проверкой userId гарантирует что только владелец удаляет свою группу
    const deleted = await withSpaceDb(session.user.id, space.id, (tx) => {
      return tx.listGroup.deleteMany({
        where: {
          id: result.data.groupId,
          userId: space.userId,
          spaceId: space.id,
        },
      });
    });

    if (deleted.count === 0) {
      return { success: false, error: "Только владелец может удалить группу" };
    }

    revalidatePath("/", "layout");
    logger.info({ uid: hashId(session.user.id), groupId: result.data.groupId, action: "deleteGroup" }, "Группа удалена");
    return { success: true };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при удалении группы:");
    return { success: false, error: "Не удалось удалить группу" };
  }
}

/**
 * Переименовывает группу списков.
 *
 * @param formData - FormData с полями:
 *   - `groupId` {string} — ID переименовываемой группы.
 *   - `name`    {string} — новое название (1–50 символов).
 * @returns `{ success: true }` или `{ success: false, error: string }`.
 */
export async function renameGroup(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(session.user.id, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const rawData = {
      groupId: formData.get("groupId"),
      name: formData.get("name"),
    };
    const result = renameGroupSchema.safeParse(rawData);
    if (!result.success) {
      return {
        success: false,
        error: getValidationError(result.error),
      };
    }

    const updated = await withSpaceDb(session.user.id, space.id, (tx) => {
      return tx.listGroup.updateMany({
        where: {
          id: result.data.groupId,
          userId: space.userId,
          spaceId: space.id,
        },
        data: { name: result.data.name },
      });
    });

    if (updated.count === 0) {
      return {
        success: false,
        error: "Только владелец может переименовать группу",
      };
    }

    revalidatePath("/", "layout");
    logger.info({ uid: hashId(session.user.id), groupId: result.data.groupId, action: "renameGroup" }, "Группа переименована");
    return { success: true };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при переименовании группы:");
    return { success: false, error: "Не удалось переименовать группу" };
  }
}

/**
 * Перемещает личную группу между двумя новыми соседями.
 *
 * Клиент передаёт место назначения соседями, а не индексом. Сервер заново
 * читает их позиции в текущем пространстве и изменяет только одну строку.
 * Если сосед исчез или перестал быть соседним, клиентское представление
 * считается устаревшим и оптимистичное перемещение откатывается.
 */
export async function moveGroup(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(session.user.id, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const result = moveGroupSchema.safeParse({
      groupId: formData.get("groupId"),
      previousGroupId: formData.get("previousGroupId") || null,
      nextGroupId: formData.get("nextGroupId") || null,
    });
    if (!result.success) {
      return { success: false, error: getValidationError(result.error) };
    }

    const { groupId, previousGroupId, nextGroupId } = result.data;
    const movement = await withSpaceDb(
      session.user.id,
      space.id,
      async (tx) => {
        const groups = await tx.listGroup.findMany({
          where: { userId: space.userId, spaceId: space.id },
          orderBy: [
            { position: "asc" },
            { createdAt: "asc" },
            { id: "asc" },
          ],
          select: { id: true, position: true },
        });

        const movingGroup = groups.find((group) => group.id === groupId);
        if (!movingGroup) return { status: "notFound" } as const;

        const previous = previousGroupId
          ? (groups.find((group) => group.id === previousGroupId) ?? null)
          : null;
        const next = nextGroupId
          ? (groups.find((group) => group.id === nextGroupId) ?? null)
          : null;
        if ((previousGroupId && !previous) || (nextGroupId && !next)) {
          return { status: "stale" } as const;
        }

        // После удаления перемещаемой группы указанные соседи должны описывать
        // реальный разрыв в текущем порядке. Иначе другая вкладка успела
        // изменить порядок, и применять жест приблизительно было бы неожиданно.
        const withoutMoving = groups.filter((group) => group.id !== groupId);
        const previousIndex = previous
          ? withoutMoving.findIndex((group) => group.id === previous.id)
          : -1;
        const nextIndex = next
          ? withoutMoving.findIndex((group) => group.id === next.id)
          : withoutMoving.length;
        if (
          nextIndex !== previousIndex + 1 ||
          (!previous && nextIndex !== 0) ||
          (!next && previousIndex !== withoutMoving.length - 1)
        ) {
          return { status: "stale" } as const;
        }

        if (!previous && !next) {
          // Единственная группа уже находится на единственно возможном месте.
          return { status: "moved", rebalanced: false } as const;
        }

        const lowestPosition = groups[0].position;
        const highestPosition = groups[groups.length - 1].position;
        let newPosition: number;
        if (previous && next) {
          newPosition = (previous.position + next.position) / 2;
        } else if (previous) {
          newPosition = highestPosition + POSITION_STEP;
        } else {
          newPosition = lowestPosition - POSITION_STEP;
        }

        const needsRebalance =
          previous !== null &&
          next !== null &&
          (newPosition <= previous.position || newPosition >= next.position);

        if (needsRebalance) {
          const reordered = [...withoutMoving];
          reordered.splice(nextIndex, 0, movingGroup);
          await Promise.all(
            reordered.map((group, index) =>
              tx.listGroup.update({
                where: { id: group.id },
                data: { position: (index + 1) * POSITION_STEP },
              }),
            ),
          );
          return { status: "moved", rebalanced: true } as const;
        }

        await tx.listGroup.update({
          where: { id: groupId },
          data: { position: newPosition },
        });
        return { status: "moved", rebalanced: false } as const;
      },
    );

    if (movement.status === "notFound") {
      return { success: false, error: "Группа не найдена" };
    }
    if (movement.status === "stale") {
      return { success: false, error: "stale" };
    }

    if (movement.rebalanced) {
      logger.info(
        {
          uid: hashId(session.user.id),
          groupId,
          spaceId: space.id,
          action: "moveGroup",
        },
        "Позиции групп перенумерованы: исчерпана точность дробной позиции",
      );
    }

    revalidatePath("/", "layout");
    logger.info(
      {
        uid: hashId(session.user.id),
        groupId,
        spaceId: space.id,
        action: "moveGroup",
      },
      "Группа перемещена",
    );
    return { success: true };
  } catch (error) {
    logger.error({ error }, "Ошибка при перемещении группы:");
    return { success: false, error: "Не удалось переместить группу" };
  }
}

/**
 * Перемещает список между соседями внутри личной группы пользователя.
 *
 * Клиент передаёт соседей итогового порядка, а сервер читает их позиции из БД
 * и проверяет актуальность разрыва. Обычно меняется одна membership-строка;
 * при исчерпании точности перенумеровывается только целевая группа.
 */
export async function moveListInGroup(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(session.user.id, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const result = moveListInGroupSchema.safeParse({
      groupId: formData.get("groupId"),
      listId: formData.get("listId"),
      previousListId: formData.get("previousListId") || null,
      nextListId: formData.get("nextListId") || null,
    });
    if (!result.success) {
      return { success: false, error: getValidationError(result.error) };
    }

    const { groupId, listId, previousListId, nextListId } = result.data;
    const movement = await withSpaceDb(
      session.user.id,
      space.id,
      async (tx) => {
        const [group, visibleList] = await Promise.all([
          tx.listGroup.findFirst({
            where: { id: groupId, userId: space.userId, spaceId: space.id },
            select: { id: true },
          }),
          tx.list.findFirst({
            where: {
              id: listId,
              ...listInSpaceWhere(space.userId, space.id),
            },
            select: { id: true },
          }),
        ]);
        if (!group) return { status: "groupNotFound" } as const;
        if (!visibleList) return { status: "listNotFound" } as const;

        const memberships = await tx.listGroupMembership.findMany({
          where: { groupId },
          orderBy: [
            { position: "asc" },
            { list: { createdAt: "asc" } },
            { listId: "asc" },
          ],
          select: { listId: true, position: true },
        });
        const movingMembership = memberships.find(
          (membership) => membership.listId === listId,
        );
        if (!movingMembership) return { status: "notMember" } as const;

        const previous = previousListId
          ? (memberships.find(
              (membership) => membership.listId === previousListId,
            ) ?? null)
          : null;
        const next = nextListId
          ? (memberships.find(
              (membership) => membership.listId === nextListId,
            ) ?? null)
          : null;
        if ((previousListId && !previous) || (nextListId && !next)) {
          return { status: "stale" } as const;
        }

        const withoutMoving = memberships.filter(
          (membership) => membership.listId !== listId,
        );
        const previousIndex = previous
          ? withoutMoving.findIndex(
              (membership) => membership.listId === previous.listId,
            )
          : -1;
        const nextIndex = next
          ? withoutMoving.findIndex(
              (membership) => membership.listId === next.listId,
            )
          : withoutMoving.length;
        if (
          nextIndex !== previousIndex + 1 ||
          (!previous && nextIndex !== 0) ||
          (!next && previousIndex !== withoutMoving.length - 1)
        ) {
          return { status: "stale" } as const;
        }

        if (!previous && !next) {
          return { status: "moved", rebalanced: false } as const;
        }

        const lowestPosition = memberships[0].position;
        const highestPosition = memberships[memberships.length - 1].position;
        let newPosition: number;
        if (previous && next) {
          newPosition = (previous.position + next.position) / 2;
        } else if (previous) {
          newPosition = highestPosition + POSITION_STEP;
        } else {
          newPosition = lowestPosition - POSITION_STEP;
        }

        const needsRebalance =
          previous !== null &&
          next !== null &&
          (newPosition <= previous.position || newPosition >= next.position);

        if (needsRebalance) {
          const reordered = [...withoutMoving];
          reordered.splice(nextIndex, 0, movingMembership);
          await Promise.all(
            reordered.map((membership, index) =>
              tx.listGroupMembership.update({
                where: {
                  listId_groupId: {
                    listId: membership.listId,
                    groupId,
                  },
                },
                data: { position: (index + 1) * POSITION_STEP },
              }),
            ),
          );
          return { status: "moved", rebalanced: true } as const;
        }

        await tx.listGroupMembership.update({
          where: { listId_groupId: { listId, groupId } },
          data: { position: newPosition },
        });
        return { status: "moved", rebalanced: false } as const;
      },
    );

    if (movement.status === "groupNotFound") {
      return { success: false, error: "Группа не найдена" };
    }
    if (movement.status === "listNotFound") {
      return { success: false, error: "Список не найден" };
    }
    if (movement.status === "notMember") {
      return { success: false, error: "Список не входит в группу" };
    }
    if (movement.status === "stale") {
      return { success: false, error: "stale" };
    }

    if (movement.rebalanced) {
      logger.info(
        {
          uid: hashId(session.user.id),
          groupId,
          listId,
          spaceId: space.id,
          action: "moveListInGroup",
        },
        "Позиции списков группы перенумерованы: исчерпана точность дробной позиции",
      );
    }

    revalidatePath("/", "layout");
    logger.info(
      {
        uid: hashId(session.user.id),
        groupId,
        listId,
        spaceId: space.id,
        action: "moveListInGroup",
      },
      "Список перемещён внутри группы",
    );
    return { success: true };
  } catch (error) {
    logger.error({ error }, "Ошибка при перемещении списка внутри группы:");
    return { success: false, error: "Не удалось переместить список" };
  }
}

/**
 * Добавляет список в группу.
 *
 * Проверяет, что:
 *   1. Пользователь — владелец группы.
 *   2. Пользователь имеет доступ к списку (владелец или через ListShare).
 *
 * @param formData - FormData с полями:
 *   - `groupId` {string} — ID группы.
 *   - `listId`  {string} — ID списка.
 * @returns `{ success: true }` или `{ success: false, error: string }`.
 */
export async function addListToGroup(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(session.user.id, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const rawData = {
      groupId: formData.get("groupId"),
      listId: formData.get("listId"),
    };
    const result = listGroupMembershipSchema.safeParse(rawData);
    if (!result.success) {
      return { success: false, error: "Неверные данные" };
    }

    const addition = await withSpaceDb(
      session.user.id,
      space.id,
      async (tx) => {
        const [group, list] = await Promise.all([
          tx.listGroup.findFirst({
            where: {
              id: result.data.groupId,
              userId: space.userId,
              spaceId: space.id,
            },
            select: { id: true },
          }),
          tx.list.findFirst({
            where: {
              id: result.data.listId,
              ...listInSpaceWhere(space.userId, space.id),
            },
            select: { id: true },
          }),
        ]);
        if (!group) return { status: "groupNotFound" } as const;
        if (!list) return { status: "listNotFound" } as const;

        const lastMembership = await tx.listGroupMembership.findFirst({
          where: { groupId: result.data.groupId },
          orderBy: { position: "desc" },
          select: { position: true },
        });
        await tx.listGroupMembership.upsert({
          where: {
            listId_groupId: {
              listId: result.data.listId,
              groupId: result.data.groupId,
            },
          },
          create: {
            listId: result.data.listId,
            groupId: result.data.groupId,
            position: (lastMembership?.position ?? 0) + POSITION_STEP,
          },
          update: {},
        });
        return { status: "added" } as const;
      },
    );

    if (addition.status === "groupNotFound") {
      return { success: false, error: "Группа не найдена" };
    }
    if (addition.status === "listNotFound") {
      return { success: false, error: "Список не найден" };
    }

    revalidatePath("/", "layout");
    logger.info({ uid: hashId(session.user.id), groupId: result.data.groupId, listId: result.data.listId, action: "addListToGroup" }, "Список добавлен в группу");
    return { success: true };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при добавлении списка в группу:");
    return { success: false, error: "Не удалось добавить список в группу" };
  }
}

/**
 * Убирает список из группы.
 *
 * Проверяет что пользователь — владелец группы.
 *
 * @param formData - FormData с полями:
 *   - `groupId` {string} — ID группы.
 *   - `listId`  {string} — ID списка.
 * @returns `{ success: true }` или `{ success: false, error: string }`.
 */
export async function removeListFromGroup(formData: FormData) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "Необходима авторизация" };
    }

    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }
    const space = await resolveActionSpace(session.user.id, formData);
    if (!space) return { success: false, error: "Пространство не найдено" };

    const rawData = {
      groupId: formData.get("groupId"),
      listId: formData.get("listId"),
    };
    const result = listGroupMembershipSchema.safeParse(rawData);
    if (!result.success) {
      return { success: false, error: "Неверные данные" };
    }

    const removed = await withSpaceDb(
      session.user.id,
      space.id,
      async (tx) => {
        const group = await tx.listGroup.findFirst({
          where: {
            id: result.data.groupId,
            userId: space.userId,
            spaceId: space.id,
          },
          select: { id: true },
        });
        if (!group) return false;

        await tx.listGroupMembership.deleteMany({
          where: {
            groupId: result.data.groupId,
            listId: result.data.listId,
          },
        });
        return true;
      },
    );
    if (!removed) {
      return { success: false, error: "Группа не найдена" };
    }

    revalidatePath("/", "layout");
    logger.info({ uid: hashId(session.user.id), groupId: result.data.groupId, listId: result.data.listId, action: "removeListFromGroup" }, "Список убран из группы");
    return { success: true };
  } catch (error) {
    logger.error({ error: error }, "Ошибка при удалении списка из группы:");
    return { success: false, error: "Не удалось убрать список из группы" };
  }
}
