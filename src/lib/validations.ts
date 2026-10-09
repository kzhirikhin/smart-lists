/**
 * @file validations.ts
 * @description Схемы валидации входных данных на основе библиотеки Zod.
 *
 * Все Server Actions принимают `FormData`, где все значения — строки.
 * Zod позволяет описать ожидаемую форму данных и автоматически:
 *   1. Проверить типы и ограничения (min/max длина, формат email и т.д.).
 *   2. Сообщить об ошибках с понятными сообщениями.
 *   3. Вернуть данные с правильными TypeScript-типами (type-narrowing).
 *
 * Использование: `schema.safeParse(rawData)` — не бросает исключение,
 * а возвращает `{ success: true, data }` или `{ success: false, error }`.
 */

import { z } from "zod";
import { ITEM_STATUSES } from "@/lib/item-status";
import { MAX_FILE_SIZE, sanitizeFileName } from "@/lib/attachments";
import { MAX_NOTE_LENGTH } from "@/lib/notes";

// ---------------------------------------------------------------------------
// Схемы для работы с записями (Item)
// ---------------------------------------------------------------------------

/**
 * Схема для создания новой записи в списке.
 * Используется в Server Action `addItem`.
 */
export const createItemSchema = z.object({
  /**
   * Название записи.
   * Минимум 1 символ (не пустое), максимум 100 символов (защита от спама).
   */
  itemName: z.string().min(1).max(200, "Слишком длинное название"),

  /**
   * ID списка, к которому привязывается запись.
   * Должен быть строкой (CUID, генерируется Prisma).
   */
  listId: z.string(),

  /**
   * Родительский пункт, если создаётся подпункт. null — обычный пункт списка.
   *
   * Вложенность ровно одна, поэтому сервер дополнительно проверяет, что сам
   * родитель подпунктом не является: схема этого выразить не может, ей
   * доступен только присланный ID.
   */
  parentItemId: z.string().min(1).nullable().default(null),
});

/**
 * Схема для удаления записи.
 * Используется в Server Action `deleteItem`.
 */
export const deleteItemSchema = z.object({
  /** Уникальный идентификатор удаляемой записи. */
  itemId: z.string(),
});

/**
 * Схема для переключения статуса записи (выполнена / не выполнена).
 * Используется в Server Action `toggleItem`.
 *
 * Важно: FormData всегда передаёт строки, поэтому перед передачей
 * в эту схему значение `isCompleted` нужно явно преобразовать:
 * `formData.get("isCompleted") === "true"`.
 */
export const toggleItemSchema = z.object({
  /** Уникальный идентификатор записи, чей статус меняется. */
  itemId: z.string(),
  /** Текущий статус записи (до переключения). Передаётся как boolean. */
  isCompleted: z.boolean(),
});

/** Явное целевое состояние вместо доверия к текущему состоянию клиента. */
export const setItemStatusSchema = z.object({
  itemId: z.string().min(1),
  status: z.enum(ITEM_STATUSES),
}).strict();

// ---------------------------------------------------------------------------
// Схемы для работы со списками (List)
// ---------------------------------------------------------------------------

/**
 * Схема для создания нового списка.
 * Используется в Server Action `createList`.
 */
export const createListSchema = z.object({
  /**
   * Название списка.
   * Обязательное поле. Максимум 50 символов.
   */
  title: z
    .string()
    .min(1, "Название обязательно")
    .max(50, "Слишком длинное название"),
  /**
   * Опциональный ID группы — если передан, новый список сразу добавляется в неё.
   */
  groupId: z.string().optional(),
});

/**
 * Схема для удаления списка покупок.
 * Используется в Server Action `deleteList`.
 */
export const deleteListSchema = z.object({
  /** Уникальный идентификатор удаляемого списка. */
  listId: z.string(),
});

/**
 * Схема для предоставления совместного доступа к списку.
 * Используется в Server Action `shareList`.
 */
export const shareListSchema = z.object({
  /** ID списка, которым делятся. */
  listId: z.string(),
  /**
   * Email пользователя, которого приглашают.
   * `.trim()` удаляет пробелы по краям до валидации email.
   * `.pipe(z.email(...))` проверяет корректность формата.
   */
  email: z.string().trim().pipe(z.email("Введите корректный email")),
});

/**
 * Схема для удаления пользователя из совместного доступа к списку.
 * Используется в Server Action `removeSharedUser`.
 */
export const removeSharedUserSchema = z.object({
  /** ID списка, из которого убирают доступ. */
  listId: z.string(),
  /** ID пользователя, которого убирают из доступа. */
  userId: z.string(),
});

/**
 * Схема для переименования списка покупок.
 * Используется в Server Action `renameList`.
 */
/**
 * Схема переключения AI для списка.
 * Используется в Server Action `setListAiEnabled`.
 */
export const setListAiEnabledSchema = z.object({
  /** Уникальный идентификатор списка. */
  listId: z.string(),

  /**
   * Желаемое состояние. Передаётся строкой: FormData не знает булевых
   * значений, а принимать «всё, кроме 'false'» за истину означало бы
   * молча включить AI на опечатке.
   */
  aiEnabled: z.enum(["true", "false"]).transform((value) => value === "true"),
});

export const renameListSchema = z.object({
  /** Уникальный идентификатор переименовываемого списка. */
  listId: z.string(),
  /**
   * Новое название списка.
   * Обязательное поле. Максимум 50 символов.
   */
  title: z
    .string()
    .min(1, "Название обязательно")
    .max(50, "Слишком длинное название"),
});

// ---------------------------------------------------------------------------
// Схемы для работы с группами списков (ListGroup)
// ---------------------------------------------------------------------------

/**
 * Схема для создания новой группы списков.
 * Используется в Server Action `createGroup`.
 */
export const createGroupSchema = z.object({
  /** Название группы. Обязательное поле. Максимум 50 символов. */
  name: z
    .string()
    .min(1, "Название обязательно")
    .max(50, "Слишком длинное название"),
});

/**
 * Схема для удаления группы списков.
 * Используется в Server Action `deleteGroup`.
 */
export const deleteGroupSchema = z.object({
  /** Уникальный идентификатор удаляемой группы. */
  groupId: z.string(),
});

/**
 * Схема для переименования группы списков.
 * Используется в Server Action `renameGroup`.
 */
export const renameGroupSchema = z.object({
  /** Уникальный идентификатор переименовываемой группы. */
  groupId: z.string(),
  /** Новое название группы. Обязательное поле. Максимум 50 символов. */
  name: z
    .string()
    .min(1, "Название обязательно")
    .max(50, "Слишком длинное название"),
});

/**
 * Схема перемещения группы между новыми соседями.
 * null означает край последовательности, пустая строка соседом не считается.
 */
export const moveGroupSchema = z
  .object({
    groupId: z.string().min(1),
    previousGroupId: z.string().min(1).nullable(),
    nextGroupId: z.string().min(1).nullable(),
  })
  .refine(
    ({ groupId, previousGroupId, nextGroupId }) =>
      groupId !== previousGroupId &&
      groupId !== nextGroupId &&
      (previousGroupId === null ||
        nextGroupId === null ||
        previousGroupId !== nextGroupId),
    { message: "Группа и её соседи должны различаться" },
  );

/**
 * Схема перемещения списка между новыми соседями внутри одной группы.
 * Позиция принадлежит membership, поэтому groupId входит в контракт явно.
 */
export const moveListInGroupSchema = z
  .object({
    groupId: z.string().min(1),
    listId: z.string().min(1),
    previousListId: z.string().min(1).nullable(),
    nextListId: z.string().min(1).nullable(),
  })
  .refine(
    ({ listId, previousListId, nextListId }) =>
      listId !== previousListId &&
      listId !== nextListId &&
      (previousListId === null ||
        nextListId === null ||
        previousListId !== nextListId),
    { message: "Список и его соседи должны различаться" },
  );

/**
 * Схема для добавления/удаления списка из группы.
 * Используется в Server Actions `addListToGroup` и `removeListFromGroup`.
 */
export const listGroupMembershipSchema = z.object({
  /** ID группы. */
  groupId: z.string(),
  /** ID списка. */
  listId: z.string(),
});

// ---------------------------------------------------------------------------
// Схемы для работы с вложениями (Attachment)
// ---------------------------------------------------------------------------

/**
 * Схема для запроса presigned URL на загрузку файла.
 * Используется в Server Action `requestUpload`.
 *
 * Важно: `contentType` и `size` здесь — то, что обещал клиент. Реальные
 * значения проверяются постфактум через S3 (policy + HeadObject на confirm),
 * поэтому эта валидация — лишь ранний отсев (defense in depth).
 */
export const requestUploadSchema = z.object({
  /** ID списка, к которому крепится вложение. */
  listId: z.string().min(1),
  /** Пространство, в контексте которого проверяется доступ к списку. */
  spaceId: z.string().min(1).max(100),
  /**
   * Оригинальное имя файла (для показа). Ограничиваем длину и чистим от
   * управляющих, bidi- и невидимых символов: имя показывается другим участникам
   * списка и попадает в `Content-Disposition`, поэтому подмена расширения через
   * `U+202E` вводила бы в заблуждение и в UI, и в диалоге сохранения.
   * `transform` идёт после `max`, а очистка имя только укорачивает.
   */
  fileName: z
    .string()
    .min(1)
    .max(255, "Слишком длинное имя файла")
    .transform(sanitizeFileName),
  /** Заявленный MIME-тип. Разрешённость проверяется отдельно по белому списку. */
  contentType: z.string().min(1),
  /** Заявленный размер в байтах. Потолок дублирует S3-policy. */
  size: z
    .number()
    .int()
    .positive()
    .max(MAX_FILE_SIZE, "Файл слишком большой"),
});

/**
 * Схема для подтверждения загрузки.
 * Используется в Server Action `confirmUpload`.
 */
export const confirmUploadSchema = z.object({
  /** ID ранее созданной PENDING-строки вложения. */
  attachmentId: z.string().min(1),
  /** Пространство, в контексте которого проверяется доступ к списку. */
  spaceId: z.string().min(1).max(100),
  /** socket_id Pusher-соединения автора — исключается из рассылки refresh. */
  socketId: z.string().optional(),
});

/**
 * Схема для удаления вложения.
 * Используется в Server Action `deleteAttachment`.
 */
export const deleteAttachmentSchema = z.object({
  /** ID удаляемого вложения. */
  attachmentId: z.string().min(1),
  /** Пространство, в контексте которого проверяется доступ к списку. */
  spaceId: z.string().min(1).max(100),
  /** socket_id Pusher-соединения автора — исключается из рассылки refresh. */
  socketId: z.string().optional(),
});

/**
 * Схема для получения ссылки на скачивание/просмотр вложения.
 * Используется в Server Action `getAttachmentUrl`.
 */
export const getAttachmentUrlSchema = z.object({
  /** ID вложения, для которого нужна presigned-ссылка. */
  attachmentId: z.string().min(1),
  /** Пространство, в контексте которого проверяется доступ к списку. */
  spaceId: z.string().min(1).max(100),
  /** true → форсировать скачивание, false → инлайн-просмотр. */
  download: z.boolean().optional(),
});

/**
 * Схема для переименования записи в списке.
 * Используется в Server Action `renameItem`.
 */
export const renameItemSchema = z.object({
  /** Уникальный идентификатор переименовываемой записи. */
  itemId: z.string(),
  /**
   * Новое название записи.
   * Обязательное поле. Максимум 100 символов.
   */
  itemName: z
    .string()
    .min(1, "Название обязательно")
    .max(200, "Слишком длинное название"),
});

/**
 * Схема для перемещения записи внутри списка.
 * Используется в Server Action `moveItem`.
 *
 * Клиент присылает не целевой индекс, а ID новых соседей: индекс мог устареть,
 * пока другой участник добавлял или удалял записи, а соседи однозначно задают
 * место даже в изменившемся списке. Сами позиции соседей сервер читает из БД —
 * присланным клиентом значениям доверять нельзя.
 *
 * null означает край: previousItemId = null — в начало списка,
 * nextItemId = null — в конец.
 */
export const moveItemSchema = z.object({
  /** Уникальный идентификатор перемещаемой записи. */
  itemId: z.string().min(1),
  /** Запись, после которой встанет перемещаемая. null — встать первой. */
  previousItemId: z.string().min(1).nullable(),
  /** Запись, перед которой встанет перемещаемая. null — встать последней. */
  nextItemId: z.string().min(1).nullable(),
});

/**
 * Схема для переноса или копирования записи в другой список.
 * Используется в Server Action `moveItemToList`.
 *
 * `mode` разделяет две операции с общей проверкой доступа: `move` меняет
 * `listId` у существующей строки, `copy` создаёт новую. Целевой список
 * проверяется на сервере по видимости в текущем пространстве — совпадение
 * с исходным отклоняется там же.
 */
export const moveItemToListSchema = z.object({
  /** Уникальный идентификатор переносимой или копируемой записи. */
  itemId: z.string().min(1),
  /** Список-получатель. Должен быть виден пользователю в текущем пространстве. */
  targetListId: z.string().min(1),
  /** `move` — перенести запись, `copy` — оставить оригинал и создать копию. */
  mode: z.enum(["move", "copy"]),
});

// ---------------------------------------------------------------------------
// Схемы для текстовых заметок списка и записей
// ---------------------------------------------------------------------------

/** Версия приходит числом из guest API или строкой из FormData Server Action. */
const noteVersionSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/).transform(Number),
]);

/** Общая часть обеих схем: plain text и ожидаемая версия для защиты от конфликтов. */
const noteFieldsSchema = {
  note: z.string().max(MAX_NOTE_LENGTH, "Слишком длинная заметка"),
  expectedVersion: noteVersionSchema,
};

/** Схема сохранения общей заметки списка. */
export const updateListNoteSchema = z.object({
  listId: z.string().min(1),
  ...noteFieldsSchema,
});

/** Схема сохранения заметки отдельной записи. */
export const updateItemNoteSchema = z.object({
  itemId: z.string().min(1),
  ...noteFieldsSchema,
});
