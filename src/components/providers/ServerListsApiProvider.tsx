/**
 * @file ServerListsApiProvider.tsx
 * @description Серверная реализация адаптера `ListsApi` поверх Server Actions.
 *
 * Client Component (`"use client"`).
 *
 * Оборачивает существующие Server Actions в интерфейс `ListsApi`:
 *   - собирает FormData из обычных аргументов (раньше это делали компоненты);
 *   - добавляет socketId Pusher-соединения (`appendSocketId`), чтобы сервер
 *     исключил текущую вкладку из рассылки realtime-обновлений — вкладка-автор
 *     получает свежие данные вместе с ответом action (revalidatePath).
 *
 * Используется в `ListsDataFetcher` для авторизованных пользователей.
 */

"use client";

import { useMemo, type ReactNode } from "react";
import {
  addItem,
  deleteItem,
  toggleItem,
  setItemStatus,
  renameItem,
  moveItem,
  moveItemToList,
  updateItemNote,
  createList,
  deleteList,
  renameList,
  updateListNote,
  leaveSharedList,
  createGroup,
  deleteGroup,
  renameGroup,
  moveGroup,
  moveListInGroup,
  addListToGroup,
  removeListFromGroup,
} from "@/app/actions";
import { appendSocketId } from "@/lib/pusher-client";
import { ListsApiProvider, type ListsApi } from "@/components/providers/ListsApiProvider";

/** Собирает FormData из пар «ключ-значение» и добавляет socketId Pusher. */
function buildFormData(fields: Record<string, string>, spaceId: string): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  formData.append("spaceId", spaceId);
  appendSocketId(formData);
  return formData;
}

/** Провайдер серверного адаптера — данные сохраняются в БД через Server Actions. */
export default function ServerListsApiProvider({
  children,
  spaceId,
}: {
  children: ReactNode;
  spaceId: string;
}) {
  // Адаптер стабилен между рендерами: все Server Actions — модульные ссылки.
  const api = useMemo<ListsApi>(
    () => ({
      isGuest: false,

      // ---- Списки ----
      createList: async ({ title, groupId }) => {
        const fields: Record<string, string> = { title };
        if (groupId) fields.groupId = groupId;
        return createList(buildFormData(fields, spaceId));
      },
      renameList: async (listId, title) => renameList(buildFormData({ listId, title }, spaceId)),
      updateListNote: async (listId, note, expectedVersion) =>
        updateListNote(buildFormData({ listId, note, expectedVersion: expectedVersion.toString() }, spaceId)),
      deleteList: async (listId) => deleteList(buildFormData({ listId }, spaceId)),
      leaveSharedList: async (listId) => leaveSharedList(buildFormData({ listId }, spaceId)),

      // ---- Записи ----
      addItem: async (listId, itemName, parentItemId) =>
        // FormData не умеет null: обычный пункт передаётся пустой строкой.
        addItem(
          buildFormData(
            { listId, itemName, parentItemId: parentItemId ?? "" },
            spaceId,
          ),
        ),
      renameItem: async (itemId, itemName) => renameItem(buildFormData({ itemId, itemName }, spaceId)),
      updateItemNote: async (itemId, note, expectedVersion) =>
        updateItemNote(buildFormData({ itemId, note, expectedVersion: expectedVersion.toString() }, spaceId)),
      deleteItem: async (itemId) => deleteItem(buildFormData({ itemId }, spaceId)),
      setItemStatus: async (itemId, status) => setItemStatus(buildFormData({ itemId, status }, spaceId)),
      toggleItem: async (itemId, isCompleted) =>
        toggleItem(buildFormData({ itemId, isCompleted: isCompleted.toString() }, spaceId)),
      moveItem: async (itemId, previousItemId, nextItemId) =>
        // FormData не умеет null: край списка передаётся пустой строкой.
        moveItem(
          buildFormData(
            {
              itemId,
              previousItemId: previousItemId ?? "",
              nextItemId: nextItemId ?? "",
            },
            spaceId,
          ),
        ),
      moveItemToList: async (itemId, targetListId, mode) =>
        moveItemToList(buildFormData({ itemId, targetListId, mode }, spaceId)),

      // ---- Группы ----
      createGroup: async (name) => createGroup(buildFormData({ name }, spaceId)),
      renameGroup: async (groupId, name) => renameGroup(buildFormData({ groupId, name }, spaceId)),
      moveGroup: async (groupId, previousGroupId, nextGroupId) =>
        moveGroup(
          buildFormData(
            {
              groupId,
              previousGroupId: previousGroupId ?? "",
              nextGroupId: nextGroupId ?? "",
            },
            spaceId,
          ),
        ),
      moveListInGroup: async (
        groupId,
        listId,
        previousListId,
        nextListId,
      ) =>
        moveListInGroup(
          buildFormData(
            {
              groupId,
              listId,
              previousListId: previousListId ?? "",
              nextListId: nextListId ?? "",
            },
            spaceId,
          ),
        ),
      deleteGroup: async (groupId) => deleteGroup(buildFormData({ groupId }, spaceId)),
      addListToGroup: async (listId, groupId) =>
        addListToGroup(buildFormData({ groupId, listId }, spaceId)),
      removeListFromGroup: async (listId, groupId) =>
        removeListFromGroup(buildFormData({ groupId, listId }, spaceId)),
    }),
    [spaceId],
  );

  return <ListsApiProvider api={api}>{children}</ListsApiProvider>;
}
