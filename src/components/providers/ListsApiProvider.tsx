/**
 * @file ListsApiProvider.tsx
 * @description Слой-адаптер операций над списками (контекст + типы).
 *
 * Client Component (`"use client"`).
 *
 * Зачем нужен адаптер:
 *   Раньше клиентские компоненты (`ListsContainer`, `SmartList`) импортировали
 *   Server Actions напрямую и были жёстко привязаны к серверу/БД. Теперь все
 *   операции описаны единым интерфейсом `ListsApi`, у которого две реализации:
 *
 *   1. Серверная (`ServerListsApiProvider`) — оборачивает Server Actions,
 *      данные живут в PostgreSQL. Используется для авторизованных пользователей.
 *
 *   2. Гостевая (`createGuestListsApi` в `src/lib/guest-storage.ts`) —
 *      данные живут в localStorage браузера. Используется в гостевом режиме
 *      (вход без аккаунта).
 *
 * Компоненты получают реализацию через хук `useListsApi()` и не знают,
 * куда именно сохраняются данные. Формы результатов (`{ success, error }`)
 * полностью повторяют контракт существующих Server Actions, поэтому логика
 * оптимистичных обновлений в компонентах не меняется.
 */

"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ItemStatus } from "@/lib/item-status";
import type { ListData, ListGroup } from "@/components/lists/ListCard";

/** Базовый результат операции — контракт Server Actions. */
export type ActionResult = { success: boolean; error?: string };

/**
 * Результат сохранения заметки. При конфликте возвращает актуальную серверную
 * версию, чтобы UI мог предложить загрузить её или явно перезаписать.
 */
export type NoteActionResult = ActionResult & {
  note?: string | null;
  noteVersion?: number;
  currentNote?: string | null;
  currentVersion?: number;
};

/** Результат создания списка: при успехе содержит созданный список. */
export type CreateListResult = ActionResult & { list?: ListData };

/** Результат создания группы: при успехе содержит созданную группу. */
export type CreateGroupResult = ActionResult & { group?: ListGroup };

/**
 * Интерфейс операций над списками, записями и группами.
 * Сигнатуры принимают обычные аргументы (не FormData) — сборка FormData
 * для Server Actions инкапсулирована в серверной реализации.
 */
export type ListsApi = {
  /** true — гостевой режим (localStorage): скрываем шаринг/AI/вложения и Pusher. */
  isGuest: boolean;

  // ---- Списки ----
  createList: (input: { title: string; groupId?: string | null }) => Promise<CreateListResult>;
  renameList: (listId: string, title: string) => Promise<ActionResult>;
  updateListNote: (listId: string, note: string, expectedVersion: number) => Promise<NoteActionResult>;
  deleteList: (listId: string) => Promise<ActionResult>;
  leaveSharedList: (listId: string) => Promise<ActionResult>;

  // ---- Записи ----
  /**
   * Добавляет запись в конец списка. `parentItemId` создаёт подпункт указанного
   * пункта — вложенность ровно одна, поэтому родитель сам обязан быть пунктом
   * верхнего уровня; проверяет это реализация, а не вызывающий код.
   */
  addItem: (
    listId: string,
    itemName: string,
    parentItemId?: string | null,
  ) => Promise<ActionResult>;
  renameItem: (itemId: string, itemName: string) => Promise<ActionResult>;
  updateItemNote: (itemId: string, note: string, expectedVersion: number) => Promise<NoteActionResult>;
  deleteItem: (itemId: string) => Promise<void>;
  setItemStatus: (itemId: string, status: ItemStatus) => Promise<ActionResult>;
  toggleItem: (itemId: string, isCompleted: boolean) => Promise<void>;
  /**
   * Перемещает запись между двумя соседями. null означает край списка:
   * previousItemId = null — в начало, nextItemId = null — в конец.
   *
   * Соседи, а не индекс: индекс мог устареть, пока другой участник менял
   * список. У гостя порядок задаёт сам массив в localStorage, на сервере —
   * дробная позиция в БД; для вызывающего кода разницы нет.
   */
  moveItem: (
    itemId: string,
    previousItemId: string | null,
    nextItemId: string | null,
  ) => Promise<ActionResult>;
  /**
   * Переносит (`move`) или копирует (`copy`) запись в другой список того же
   * пространства вместе с её подпунктами. Запись встаёт в конец
   * списка-получателя.
   *
   * Целевой список проверяется на стороне реализации: перенос в тот же список
   * отклоняется, как и список, недоступный пользователю в текущем пространстве.
   * Отдельный подпункт перенести нельзя — он принадлежит родителю.
   */
  moveItemToList: (
    itemId: string,
    targetListId: string,
    mode: "move" | "copy",
  ) => Promise<ActionResult>;

  // ---- Группы ----
  createGroup: (name: string) => Promise<CreateGroupResult>;
  renameGroup: (groupId: string, name: string) => Promise<ActionResult>;
  moveGroup: (
    groupId: string,
    previousGroupId: string | null,
    nextGroupId: string | null,
  ) => Promise<ActionResult>;
  moveListInGroup: (
    groupId: string,
    listId: string,
    previousListId: string | null,
    nextListId: string | null,
  ) => Promise<ActionResult>;
  deleteGroup: (groupId: string) => Promise<ActionResult>;
  addListToGroup: (listId: string, groupId: string) => Promise<ActionResult>;
  removeListFromGroup: (listId: string, groupId: string) => Promise<ActionResult>;
};

const ListsApiContext = createContext<ListsApi | null>(null);

/** Провайдер адаптера: реализация передаётся сверху (серверная или гостевая). */
export function ListsApiProvider({
  api,
  children,
}: {
  api: ListsApi;
  children: ReactNode;
}) {
  return <ListsApiContext.Provider value={api}>{children}</ListsApiContext.Provider>;
}

/**
 * Хук доступа к адаптеру операций.
 * Бросает ошибку вне провайдера — это ошибка композиции, а не рантайма.
 */
export function useListsApi(): ListsApi {
  const api = useContext(ListsApiContext);
  if (!api) {
    throw new Error("useListsApi вызван вне ListsApiProvider");
  }
  return api;
}
