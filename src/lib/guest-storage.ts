/**
 * @file guest-storage.ts
 * @description Гостевое хранилище списков в localStorage браузера.
 *
 * Клиентский модуль (использует localStorage — импортировать только из
 * клиентских компонентов).
 *
 * Гостевой режим: пользователь работает без аккаунта, данные НЕ попадают
 * в БД — всё хранится локально в этом браузере под ключом `guest-data-v1`.
 * Версия в ключе позволяет в будущем мигрировать формат без конфликтов.
 *
 * Модуль экспортирует:
 *   - `loadGuestData()` / типы — чтение и Zod-валидация сырых данных;
 *   - `toListData()` — преобразование в формат `ListData`, который ожидают
 *     компоненты (`ListsContainer`, `ListCard`, `SmartList`);
 *   - `createGuestListsApi()` — гостевую реализацию адаптера `ListsApi`
 *     (см. `ListsApiProvider.tsx`): те же контракты, что у Server Actions,
 *     но операции выполняются синхронно над localStorage.
 *
 * Валидация входных данных — теми же Zod-схемами, что и на сервере
 * (`src/lib/validations.ts`): лимиты длины и коды ошибок ("tooLong")
 * полностью совпадают с серверным поведением.
 *
 * Задел на будущее: данные гостя лежат в одном ключе, поэтому «перенос
 * в аккаунт» при регистрации сведётся к одному чтению + Server Action.
 */

import { z } from "zod";
import { ZodError } from "zod";
import {
  createItemSchema,
  renameItemSchema,
  moveItemSchema,
  moveItemToListSchema,
  createListSchema,
  renameListSchema,
  createGroupSchema,
  renameGroupSchema,
  moveGroupSchema,
  moveListInGroupSchema,
  updateListNoteSchema,
  updateItemNoteSchema,
  setItemStatusSchema,
} from "@/lib/validations";
import type { ListData } from "@/components/lists/ListCard";
import type { ListsApi } from "@/components/providers/ListsApiProvider";
import { ITEM_STATUSES, deriveParentStatus, getItemStatus } from "@/lib/item-status";
import { randomUUID } from "@/lib/uuid";
import { normalizeNote } from "@/lib/notes";

// ---------------------------------------------------------------------------
// Схема хранимых данных
// ---------------------------------------------------------------------------

/** Ключ localStorage. Суффикс версии — на случай смены формата. */
const STORAGE_KEY = "guest-data-v1";

/** Фиктивный ID гостя: подставляется в ownerId/addedBy вместо ID из БД. */
export const GUEST_USER_ID = "guest";

/** Подпункт: та же запись, но своих подпунктов иметь не может. */
const storedSubItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  isCompleted: z.boolean(),
  status: z.enum(ITEM_STATUSES).optional(),
  note: z.string().nullable().optional(),
  noteVersion: z.number().int().nonnegative().optional(),
});

/**
 * Запись в гостевом списке.
 *
 * Подпункты вложены прямо в родителя, а не лежат плоско с `parentId`, как на
 * сервере. Причины две. Первая: у гостя порядок задаёт сам массив, и вложение
 * делает «подпункты следуют за родителем» свойством структуры — при переносе
 * и удалении пункта с ними не нужно делать ничего. Вторая: одна вложенность
 * закреплена самой схемой, потому что у подпункта поля `subItems` нет.
 */
const storedItemSchema = storedSubItemSchema.extend({
  subItems: z.array(storedSubItemSchema).default([]),
});

/** Гостевой список. Порядок в массиве = порядок отображения (новые сверху). */
const storedListSchema = z.object({
  id: z.string(),
  title: z.string(),
  note: z.string().nullable().optional(),
  noteVersion: z.number().int().nonnegative().optional(),
  /** ID групп, к которым привязан список. */
  groupIds: z.array(z.string()),
  /**
   * Записи в порядке отображения. У гостя порядок задаёт сам массив, поле
   * position не нужно: сервер хранит дробную позицию только потому, что там
   * порядок нужно восстанавливать из реляционной выборки и защищать от гонок
   * между участниками. Контракт с компонентами при этом одинаковый —
   * в `SmartList` массив записей всегда приходит уже упорядоченным.
   */
  items: z.array(storedItemSchema),
});

/** Гостевая группа списков. */
const storedGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** ID списков в персональном порядке этой группы. */
  listIds: z.array(z.string()).default([]),
});

/** Все гостевые данные под одним ключом localStorage. */
const guestDataSchema = z.object({
  lists: z.array(storedListSchema),
  groups: z.array(storedGroupSchema),
});

export type GuestData = z.infer<typeof guestDataSchema>;
type StoredList = z.infer<typeof storedListSchema>;
type StoredGroup = z.infer<typeof storedGroupSchema>;
type StoredItem = z.infer<typeof storedItemSchema>;
type StoredSubItem = z.infer<typeof storedSubItemSchema>;

// ---------------------------------------------------------------------------
// Чтение / запись localStorage
// ---------------------------------------------------------------------------

/**
 * Пустое состояние создаётся заново на каждый вызов.
 *
 * Раньше здесь была общая константа, и `loadGuestData` возвращал ссылку на
 * неё. Мутации идут прямо в результат (`data.lists.unshift(...)`), поэтому
 * при пустом хранилище они накапливались в общем объекте на весь срок жизни
 * вкладки: если запись в localStorage не удавалась (приватный режим, квота),
 * пользователь получал ошибку, но список оставался в памяти и всплывал при
 * следующем чтении как несуществующий.
 */
function emptyData(): GuestData {
  return { lists: [], groups: [] };
}

/**
 * Читает гостевые данные из localStorage.
 * Повреждённые или отсутствующие данные заменяются пустым состоянием —
 * safeParse гарантирует, что в компоненты не попадёт неожиданная структура.
 */
export function loadGuestData(): GuestData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyData();

    const result = guestDataSchema.safeParse(JSON.parse(raw));
    if (!result.success) return emptyData();

    // Старый формат не содержал listIds. Заодно очищаем исчезнувшие и
    // дублирующиеся ID, а недостающие membership дописываем в прежнем
    // глобальном порядке списков.
    const existingListIds = new Set(result.data.lists.map((list) => list.id));
    for (const group of result.data.groups) {
      const members = new Set(
        result.data.lists
          .filter((list) => list.groupIds.includes(group.id))
          .map((list) => list.id),
      );
      const seen = new Set<string>();
      group.listIds = [
        ...group.listIds.filter((id) => {
          if (
            !existingListIds.has(id) ||
            !members.has(id) ||
            seen.has(id)
          ) {
            return false;
          }
          seen.add(id);
          return true;
        }),
        ...result.data.lists
          .map((list) => list.id)
          .filter((id) => members.has(id) && !seen.has(id)),
      ];
    }
    return result.data;
  } catch {
    // JSON.parse упал или localStorage недоступен (privacy mode)
    return emptyData();
  }
}

/**
 * Сохраняет гостевые данные.
 * @returns false, если запись не удалась (например, квота localStorage).
 */
function saveGuestData(data: GuestData): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** Генерирует ID гостевой сущности. Префикс отличает от CUID из БД. */
function guestId(): string {
  return `guest-${randomUUID()}`;
}

/** Код ошибки валидации — та же логика, что в Server Actions. */
function getValidationError(error: ZodError): string {
  return error.issues.some((i) => i.code === "too_big") ? "tooLong" : "validationError";
}

/**
 * Найденная запись вместе с её окружением: списком, родителем и уровнем.
 *
 * Тип размеченный по `parent`: у записи верхнего уровня есть поле `subItems`,
 * у подпункта его нет и быть не может. Проверка `location.parent` сразу даёт
 * нужный тип и избавляет операции от приведения типов.
 *
 * Поле `siblings` — массив, в котором лежит запись, то есть её уровень. Его
 * порядок и есть порядок отображения, поэтому перемещение работает с ним.
 */
type ItemLocation =
  | {
      list: StoredList;
      parent: null;
      item: StoredItem;
      siblings: StoredSubItem[];
    }
  | {
      list: StoredList;
      parent: StoredItem;
      item: StoredSubItem;
      siblings: StoredSubItem[];
    };

/**
 * Находит запись любого уровня по ID.
 *
 * Операции над записью не знают заранее, пункт это или подпункт: клиент
 * присылает только ID, ровно как Server Action получает его из FormData.
 */
function locateItem(data: GuestData, itemId: string): ItemLocation | null {
  for (const list of data.lists) {
    const item = list.items.find((entry) => entry.id === itemId);
    if (item) return { list, parent: null, item, siblings: list.items };

    for (const parent of list.items) {
      const subItem = parent.subItems.find((entry) => entry.id === itemId);
      if (subItem) {
        return { list, parent, item: subItem, siblings: parent.subItems };
      }
    }
  }
  return null;
}

/**
 * Приводит отметку родителя в соответствие с подпунктами — гостевой аналог
 * `syncParentCompletion` из Server Actions и того же правила в `item-tree`.
 *
 * Родитель без подпунктов сохраняет своё значение: оно снова его собственное.
 */
function syncParentCompletion(parent: StoredItem): void {
  if (parent.subItems.length === 0) return;
  parent.status = deriveParentStatus(parent.subItems);
  parent.isCompleted = parent.status === "COMPLETED";
}

// ---------------------------------------------------------------------------
// Преобразование в формат компонентов
// ---------------------------------------------------------------------------

/**
 * Преобразует один хранимый список в `ListData` для компонентов.
 * Гость всегда владелец: sharedWith/files пусты, addedBy — сам гость.
 *
 * @param list - Хранимый список.
 * @param groups - Все гостевые группы (для резолва groupIds → {id, name}).
 * @param guestName - Локализованное имя гостя (показывается как автор/владелец).
 */
function storedListToListData(
  list: StoredList,
  groups: StoredGroup[],
  guestName: string,
): ListData {
  const guestUser = { id: GUEST_USER_ID, name: guestName, email: "" };
  return {
    id: list.id,
    title: list.title,
    note: list.note ?? null,
    noteVersion: list.noteVersion ?? 0,
    // Гостю AI недоступен целиком, наружу ничего не уходит — поэтому честное
    // значение здесь `false`, а не умолчание БД. Поле в гостевом режиме не
    // читается, но неверное значение однажды всплывёт в новом месте.
    aiEnabled: false,
    ownerId: GUEST_USER_ID,
    owner: { name: guestName, email: "" },
    // Компоненты работают с плоским массивом и полем parentId: дерево они
    // собирают сами через `buildItemTree`. Вложенное хранение разворачивается
    // здесь — подпункты идут сразу за своим родителем.
    items: list.items.flatMap((item) => [
      {
        id: item.id,
        name: item.name,
        isCompleted: item.isCompleted,
        status: getItemStatus(item),
        note: item.note ?? null,
        noteVersion: item.noteVersion ?? 0,
        parentId: null,
        addedBy: guestUser,
      },
      ...item.subItems.map((subItem) => ({
        id: subItem.id,
        name: subItem.name,
        isCompleted: subItem.isCompleted,
        status: getItemStatus(subItem),
        note: subItem.note ?? null,
        noteVersion: subItem.noteVersion ?? 0,
        parentId: item.id,
        addedBy: guestUser,
      })),
    ]),
    sharedWith: [],
    groups: groups
      .filter((group) => list.groupIds.includes(group.id))
      .map((group) => ({
        id: group.id,
        name: group.name,
        position: Math.max(0, group.listIds.indexOf(list.id)) + 1,
      })),
    files: [],
  };
}

/** Преобразует все гостевые данные в массив `ListData` (новые списки сверху). */
export function toListData(data: GuestData, guestName: string): ListData[] {
  return data.lists.map((list) => storedListToListData(list, data.groups, guestName));
}

// ---------------------------------------------------------------------------
// Гостевая реализация адаптера ListsApi
// ---------------------------------------------------------------------------

/**
 * Создаёт гостевую реализацию `ListsApi` поверх localStorage.
 *
 * Каждая операция: валидация (Zod) → мутация данных → запись в localStorage →
 * `refresh()`. Колбэк `refresh` перечитывает данные в состояние React —
 * это гостевой аналог `revalidatePath` на сервере: базовое состояние
 * `useOptimistic` в компонентах обновляется после каждой операции.
 *
 * @param refresh - Колбэк перезагрузки данных в состояние (из `GuestHome`).
 * @param guestName - Локализованное имя гостя (для `createList`).
 */
export function createGuestListsApi(refresh: () => void, guestName: string): ListsApi {
  /** Общий шаблон мутации: загрузка → изменение → сохранение → refresh. */
  function mutate(change: (data: GuestData) => { success: boolean; error?: string }): {
    success: boolean;
    error?: string;
  } {
    const data = loadGuestData();
    const result = change(data);
    if (!result.success) return result;

    if (!saveGuestData(data)) {
      return { success: false, error: "storageFailed" };
    }
    refresh();
    return result;
  }

  return {
    isGuest: true,

    // ---- Списки ----

    createList: async ({ title, groupId }) => {
      const parsed = createListSchema.safeParse({ title, groupId: groupId ?? undefined });
      if (!parsed.success) {
        return { success: false, error: getValidationError(parsed.error) };
      }

      const data = loadGuestData();
      const initialGroup = parsed.data.groupId
        ? (data.groups.find((group) => group.id === parsed.data.groupId) ??
          null)
        : null;
      if (parsed.data.groupId && !initialGroup) {
        return { success: false, error: "Группа не найдена" };
      }
      const newList: StoredList = {
        id: guestId(),
        title: parsed.data.title,
        note: null,
        noteVersion: 0,
        // Привязываем к проверенной группе сразу (как на сервере).
        groupIds: initialGroup ? [initialGroup.id] : [],
        items: [],
      };
      data.lists.unshift(newList); // Новые списки сверху (createdAt desc на сервере)
      initialGroup?.listIds.unshift(newList.id);

      if (!saveGuestData(data)) {
        return { success: false, error: "storageFailed" };
      }
      refresh();
      return { success: true, list: storedListToListData(newList, data.groups, guestName) };
    },

    renameList: async (listId, title) => {
      const parsed = renameListSchema.safeParse({ listId, title });
      if (!parsed.success) {
        return { success: false, error: getValidationError(parsed.error) };
      }
      return mutate((data) => {
        const list = data.lists.find((l) => l.id === parsed.data.listId);
        if (!list) return { success: false, error: "Список не найден" };
        list.title = parsed.data.title;
        return { success: true };
      });
    },

    updateListNote: async (listId, note, expectedVersion) => {
      const parsed = updateListNoteSchema.safeParse({ listId, note, expectedVersion });
      if (!parsed.success) {
        return { success: false, error: getValidationError(parsed.error) };
      }
      let savedNote: string | null = null;
      let savedVersion = expectedVersion;
      const result = mutate((data) => {
        const list = data.lists.find((l) => l.id === parsed.data.listId);
        if (!list) return { success: false, error: "Список не найден" };
        const currentVersion = list.noteVersion ?? 0;
        if (currentVersion !== parsed.data.expectedVersion) {
          return { success: false, error: "noteConflict" };
        }
        savedNote = normalizeNote(parsed.data.note);
        if ((list.note ?? null) === savedNote) {
          savedVersion = currentVersion;
          return { success: true };
        }
        savedVersion = currentVersion + 1;
        list.note = savedNote;
        list.noteVersion = savedVersion;
        return { success: true };
      });
      return { ...result, note: savedNote, noteVersion: savedVersion };
    },

    deleteList: async (listId) => {
      return mutate((data) => {
        const before = data.lists.length;
        data.lists = data.lists.filter((l) => l.id !== listId);
        if (data.lists.length === before) {
          return { success: false, error: "Список не найден" };
        }
        for (const group of data.groups) {
          group.listIds = group.listIds.filter((id) => id !== listId);
        }
        return { success: true };
      });
    },

    // Расшаренных списков у гостя нет — операция недоступна по построению
    leaveSharedList: async () => ({ success: false, error: "Недоступно в гостевом режиме" }),

    // ---- Записи ----

    addItem: async (listId, itemName, parentItemId) => {
      const parsed = createItemSchema.safeParse({
        listId,
        itemName,
        parentItemId: parentItemId ?? null,
      });
      if (!parsed.success) {
        return { success: false, error: getValidationError(parsed.error) };
      }
      return mutate((data) => {
        const list = data.lists.find((l) => l.id === parsed.data.listId);
        if (!list) return { success: false, error: "Список не найден" };

        const created: StoredSubItem = {
          id: guestId(),
          name: parsed.data.itemName,
          isCompleted: false,
          status: "NOT_STARTED",
          note: null,
          noteVersion: 0,
        };

        if (parsed.data.parentItemId) {
          // Родитель ищется только среди пунктов верхнего уровня, поэтому
          // вторая вложенность недостижима: ID подпункта тут не найдётся.
          const parent = list.items.find(
            (entry) => entry.id === parsed.data.parentItemId,
          );
          if (!parent) return { success: false, error: "Пункт не найден" };
          parent.subItems.push(created);
          // Новый подпункт невыполненный, значит и родитель заведомо тоже.
          syncParentCompletion(parent);
          return { success: true };
        }

        list.items.push({ ...created, subItems: [] });
        return { success: true };
      });
    },

    renameItem: async (itemId, itemName) => {
      const parsed = renameItemSchema.safeParse({ itemId, itemName });
      if (!parsed.success) {
        return { success: false, error: getValidationError(parsed.error) };
      }
      return mutate((data) => {
        const location = locateItem(data, parsed.data.itemId);
        if (!location) return { success: false, error: "Запись не найдена" };
        location.item.name = parsed.data.itemName;
        return { success: true };
      });
    },

    updateItemNote: async (itemId, note, expectedVersion) => {
      const parsed = updateItemNoteSchema.safeParse({ itemId, note, expectedVersion });
      if (!parsed.success) {
        return { success: false, error: getValidationError(parsed.error) };
      }
      let savedNote: string | null = null;
      let savedVersion = expectedVersion;
      const result = mutate((data) => {
        const item = locateItem(data, parsed.data.itemId)?.item;
        if (!item) return { success: false, error: "Запись не найдена" };
        const currentVersion = item.noteVersion ?? 0;
        if (currentVersion !== parsed.data.expectedVersion) {
          return { success: false, error: "noteConflict" };
        }
        savedNote = normalizeNote(parsed.data.note);
        if ((item.note ?? null) === savedNote) {
          savedVersion = currentVersion;
          return { success: true };
        }
        savedVersion = currentVersion + 1;
        item.note = savedNote;
        item.noteVersion = savedVersion;
        return { success: true };
      });
      return { ...result, note: savedNote, noteVersion: savedVersion };
    },

    deleteItem: async (itemId) => {
      mutate((data) => {
        const location = locateItem(data, itemId);
        if (!location) return { success: true };

        // Подпункты удаляемого пункта уходят вместе с ним: они лежат внутри
        // него — это гостевой эквивалент каскада по составному ключу в БД.
        location.siblings.splice(
          location.siblings.findIndex((entry) => entry.id === itemId),
          1,
        );
        // Удалённый подпункт мог быть последним невыполненным.
        if (location.parent) syncParentCompletion(location.parent);
        return { success: true };
      });
    },

    /**
     * Перемещение записи у гостя — это перестановка в массиве: порядок
     * элементов и есть порядок отображения, отдельного поля position тут нет.
     * Контракт с UI тот же, что у серверной реализации.
     *
     * Перестановка идёт внутри уровня записи: подпункт двигается среди
     * подпунктов своего родителя, пункт — среди пунктов списка. Сосед с
     * другого уровня в этом массиве просто не найдётся и вернёт `stale`.
     */
    moveItem: async (itemId, previousItemId, nextItemId) => {
      const parsed = moveItemSchema.safeParse({ itemId, previousItemId, nextItemId });
      if (!parsed.success) {
        return { success: false, error: getValidationError(parsed.error) };
      }
      return mutate((data) => {
        const location = locateItem(data, parsed.data.itemId);
        if (!location) return { success: false, error: "Запись не найдена" };
        const siblings = location.siblings;

        // Сначала изымаем запись: соседи ищутся уже в массиве без неё, иначе
        // индекс вставки съедет на единицу при движении вниз.
        const currentIndex = siblings.findIndex((i) => i.id === parsed.data.itemId);
        const [moved] = siblings.splice(currentIndex, 1);

        let insertAt: number;
        if (parsed.data.previousItemId) {
          const previousIndex = siblings.findIndex(
            (i) => i.id === parsed.data.previousItemId,
          );
          // Сосед пропал — представление UI устарело. mutate не сохранит
          // изменения при ошибке, поэтому восстанавливать массив не нужно.
          if (previousIndex === -1) return { success: false, error: "stale" };
          insertAt = previousIndex + 1;
        } else if (parsed.data.nextItemId) {
          const nextIndex = siblings.findIndex(
            (i) => i.id === parsed.data.nextItemId,
          );
          if (nextIndex === -1) return { success: false, error: "stale" };
          insertAt = nextIndex;
        } else {
          insertAt = siblings.length;
        }

        siblings.splice(insertAt, 0, moved);
        return { success: true };
      });
    },

    /**
     * Перенос и копирование записи между списками. У гостя все списки лежат
     * в одном ключе localStorage, поэтому обе операции — работа с двумя
     * массивами: изъять и вставить либо склонировать и вставить.
     *
     * Как и на сервере, запись встаёт в конец списка-получателя, копия теряет
     * отметку о выполнении и начинает историю заметки с нулевой версии.
     * Подпункты едут за родителем — здесь буквально, потому что лежат внутри
     * него. Отдельный подпункт перенести нельзя: он принадлежит родителю.
     */
    moveItemToList: async (itemId, targetListId, mode) => {
      const parsed = moveItemToListSchema.safeParse({ itemId, targetListId, mode });
      if (!parsed.success) {
        return { success: false, error: getValidationError(parsed.error) };
      }
      return mutate((data) => {
        const location = locateItem(data, parsed.data.itemId);
        if (!location) return { success: false, error: "Запись не найдена" };
        if (location.parent) return { success: false, error: "subItem" };

        const source = location.list;
        if (source.id === parsed.data.targetListId) {
          return { success: false, error: "sameList" };
        }

        const target = data.lists.find((l) => l.id === parsed.data.targetListId);
        if (!target) return { success: false, error: "Список не найден" };

        const item = location.item;

        if (parsed.data.mode === "move") {
          source.items.splice(
            source.items.findIndex((i) => i.id === item.id),
            1,
          );
          target.items.push(item);
        } else {
          target.items.push({
            id: guestId(),
            name: item.name,
            isCompleted: false,
            status: "NOT_STARTED",
            note: item.note ?? null,
            noteVersion: 0,
            // У копий подпунктов свои ID и своя история заметки — как у копии
            // самого пункта.
            subItems: item.subItems.map((subItem) => ({
              id: guestId(),
              name: subItem.name,
              isCompleted: false,
              status: "NOT_STARTED",
              note: subItem.note ?? null,
              noteVersion: 0,
            })),
          });
        }
        return { success: true };
      });
    },

    /**
     * Отметка выполнения с тем же правилом синхронизации, что на сервере:
     * у пункта с подпунктами собственной отметки нет, она производная, поэтому
     * клик по нему проставляет значение всем подпунктам, а клик по подпункту
     * пересчитывает родителя.
     */
    setItemStatus: async (itemId, status) => {
      const parsed = setItemStatusSchema.safeParse({ itemId, status });
      if (!parsed.success) return { success: false, error: "validationError" };
      return mutate((data) => {
        const location = locateItem(data, itemId);
        if (!location) return { success: false, error: "notFound" };
        location.item.status = parsed.data.status;
        location.item.isCompleted = parsed.data.status === "COMPLETED";
        if (location.parent) {
          syncParentCompletion(location.parent);
        } else {
          for (const subItem of location.item.subItems) {
            if (parsed.data.status === "IN_PROGRESS" && subItem.isCompleted) continue;
            subItem.status = parsed.data.status;
            subItem.isCompleted = parsed.data.status === "COMPLETED";
          }
          syncParentCompletion(location.item);
        }
        return { success: true };
      });
    },

    toggleItem: async (itemId, isCompleted) => {
      mutate((data) => {
        const location = locateItem(data, itemId);
        if (!location) return { success: true };

        // Сохраняем инверсию ТЕКУЩЕГО значения — как в Server Action toggleItem
        const next = !isCompleted;
        location.item.isCompleted = next;
        location.item.status = next ? "COMPLETED" : "NOT_STARTED";

        if (location.parent) {
          syncParentCompletion(location.parent);
        } else {
          for (const subItem of location.item.subItems) {
            subItem.isCompleted = next;
            subItem.status = next ? "COMPLETED" : "NOT_STARTED";
          }
        }
        return { success: true };
      });
    },

    // ---- Группы ----

    createGroup: async (name) => {
      const parsed = createGroupSchema.safeParse({ name });
      if (!parsed.success) {
        return { success: false, error: getValidationError(parsed.error) };
      }

      const data = loadGuestData();
      const group = { id: guestId(), name: parsed.data.name, listIds: [] };
      data.groups.push(group); // Порядок создания (createdAt asc на сервере)

      if (!saveGuestData(data)) {
        return { success: false, error: "storageFailed" };
      }
      refresh();
      return { success: true, group };
    },

    renameGroup: async (groupId, name) => {
      const parsed = renameGroupSchema.safeParse({ groupId, name });
      if (!parsed.success) {
        return { success: false, error: getValidationError(parsed.error) };
      }
      return mutate((data) => {
        const group = data.groups.find((g) => g.id === parsed.data.groupId);
        if (!group) return { success: false, error: "Группа не найдена" };
        group.name = parsed.data.name;
        return { success: true };
      });
    },

    moveGroup: async (groupId, previousGroupId, nextGroupId) => {
      const parsed = moveGroupSchema.safeParse({
        groupId,
        previousGroupId,
        nextGroupId,
      });
      if (!parsed.success) {
        return { success: false, error: getValidationError(parsed.error) };
      }

      return mutate((data) => {
        const currentIndex = data.groups.findIndex(
          (group) => group.id === parsed.data.groupId,
        );
        if (currentIndex === -1) {
          return { success: false, error: "Группа не найдена" };
        }

        const reordered = [...data.groups];
        const [movingGroup] = reordered.splice(currentIndex, 1);
        const previousIndex = parsed.data.previousGroupId
          ? reordered.findIndex(
              (group) => group.id === parsed.data.previousGroupId,
            )
          : -1;
        const nextIndex = parsed.data.nextGroupId
          ? reordered.findIndex((group) => group.id === parsed.data.nextGroupId)
          : reordered.length;

        if (
          (parsed.data.previousGroupId && previousIndex === -1) ||
          (parsed.data.nextGroupId && nextIndex === -1) ||
          nextIndex !== previousIndex + 1 ||
          (!parsed.data.previousGroupId && nextIndex !== 0) ||
          (!parsed.data.nextGroupId && previousIndex !== reordered.length - 1)
        ) {
          return { success: false, error: "stale" };
        }

        reordered.splice(nextIndex, 0, movingGroup);
        data.groups = reordered;
        return { success: true };
      });
    },

    moveListInGroup: async (
      groupId,
      listId,
      previousListId,
      nextListId,
    ) => {
      const parsed = moveListInGroupSchema.safeParse({
        groupId,
        listId,
        previousListId,
        nextListId,
      });
      if (!parsed.success) {
        return { success: false, error: getValidationError(parsed.error) };
      }

      return mutate((data) => {
        const group = data.groups.find(
          (entry) => entry.id === parsed.data.groupId,
        );
        const list = data.lists.find(
          (entry) => entry.id === parsed.data.listId,
        );
        if (!group) return { success: false, error: "Группа не найдена" };
        if (!list || !list.groupIds.includes(group.id)) {
          return { success: false, error: "Список не входит в группу" };
        }

        const currentIndex = group.listIds.indexOf(list.id);
        if (currentIndex === -1) return { success: false, error: "stale" };

        const reordered = [...group.listIds];
        reordered.splice(currentIndex, 1);
        const previousIndex = parsed.data.previousListId
          ? reordered.indexOf(parsed.data.previousListId)
          : -1;
        const nextIndex = parsed.data.nextListId
          ? reordered.indexOf(parsed.data.nextListId)
          : reordered.length;
        if (
          (parsed.data.previousListId && previousIndex === -1) ||
          (parsed.data.nextListId && nextIndex === -1) ||
          nextIndex !== previousIndex + 1 ||
          (!parsed.data.previousListId && nextIndex !== 0) ||
          (!parsed.data.nextListId && previousIndex !== reordered.length - 1)
        ) {
          return { success: false, error: "stale" };
        }

        reordered.splice(nextIndex, 0, list.id);
        group.listIds = reordered;
        return { success: true };
      });
    },

    deleteGroup: async (groupId) => {
      return mutate((data) => {
        const before = data.groups.length;
        data.groups = data.groups.filter((g) => g.id !== groupId);
        if (data.groups.length === before) {
          return { success: false, error: "Группа не найдена" };
        }
        // Списки не удаляются — только их связь с группой (как на сервере)
        for (const list of data.lists) {
          list.groupIds = list.groupIds.filter((id) => id !== groupId);
        }
        return { success: true };
      });
    },

    addListToGroup: async (listId, groupId) => {
      return mutate((data) => {
        const list = data.lists.find((l) => l.id === listId);
        const group = data.groups.find((entry) => entry.id === groupId);
        if (!list || !group) {
          return { success: false, error: "Список или группа не найдены" };
        }
        if (!list.groupIds.includes(groupId)) {
          list.groupIds.push(groupId);
          group.listIds.push(list.id);
        }
        return { success: true };
      });
    },

    removeListFromGroup: async (listId, groupId) => {
      return mutate((data) => {
        const list = data.lists.find((l) => l.id === listId);
        if (!list) return { success: false, error: "Список не найден" };
        list.groupIds = list.groupIds.filter((id) => id !== groupId);
        const group = data.groups.find((entry) => entry.id === groupId);
        if (group) {
          group.listIds = group.listIds.filter((id) => id !== list.id);
        }
        return { success: true };
      });
    },
  };
}
