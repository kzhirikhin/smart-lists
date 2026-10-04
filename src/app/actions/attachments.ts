/**
 * @file attachments.ts
 * @description Server Actions для фичи вложений к спискам (S3).
 *
 * Поток загрузки — two-phase, чтобы недозалитый файл не светился в UI:
 *   1. `requestUpload`  — проверка прав + квоты, создание PENDING-строки,
 *                         выдача presigned POST. Байты идут НЕ через нас.
 *   2. клиент           — POST файла напрямую в S3 (см. AttachmentUploader).
 *   3. `confirmUpload`  — HeadObject подтверждает факт + реальный размер,
 *                         сигнатура подтверждает содержимое, статус
 *                         становится UPLOADED.
 *
 * Безопасность (как в остальных actions):
 *   - membership-проверка по сессии на каждое действие (защита от IDOR);
 *   - данные о доступе берутся из БД, не от клиента;
 *   - квота на список считается под row-lock на строке List (защита от TOCTOU).
 */

"use server";

import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { logger, hashId } from "@/lib/logger";
import { notifyUsers } from "@/lib/notify";
import {
  DatabaseContextError,
  withSpaceDb,
} from "@/lib/scoped-db";
import { listInSpaceWhere } from "@/lib/spaces";
import {
  requestUploadSchema,
  confirmUploadSchema,
  deleteAttachmentSchema,
  getAttachmentUrlSchema,
} from "@/lib/validations";
import {
  MAGIC_BYTES_PREFIX_LENGTH,
  MAX_FILE_SIZE,
  MAX_FILES_PER_LIST,
  MAX_FILES_PER_USER,
  getCategory,
  hasMagicBytes,
  isAllowedType,
  matchesMagicBytes,
} from "@/lib/attachments";
import {
  finishAttachmentMaintenance,
  prepareAttachmentMaintenance,
} from "@/lib/attachment-maintenance";
import type { AttachmentCleanupItem } from "@/lib/attachment-maintenance";
import {
  buildAttachmentKey,
  createUploadPost,
  headObject,
  getObjectPrefix,
  getDownloadUrl,
  deleteObject,
  deleteObjects,
  isS3Configured,
} from "@/lib/s3";
import type { FileCategory } from "@/generated/prisma/client";
import { consumeMutationBudget } from "@/lib/usage";
import { writeAuditEvent } from "@/lib/audit";

function isMissingSpace(error: unknown): boolean {
  return (
    error instanceof DatabaseContextError && error.code === "SPACE_NOT_FOUND"
  );
}

/** Результат запроса на загрузку: данные для прямого POST в S3. */
interface RequestUploadResult {
  success: boolean;
  error?: string;
  upload?: {
    /** URL бакета, куда слать multipart/form-data. */
    url: string;
    /** Поля формы из presigned POST (добавляются перед файлом). */
    fields: Record<string, string>;
    /** ID созданной PENDING-строки — нужен для confirm. */
    attachmentId: string;
  };
}

function scheduleAttachmentCleanup(input: {
  cleanupItems: AttachmentCleanupItem[];
  userId: string;
  spaceId: string;
  listId: string;
}): void {
  if (input.cleanupItems.length === 0) return;

  logger.info(
    {
      count: input.cleanupItems.length,
      listId: input.listId,
      action: "requestUpload",
    },
    "Просроченные PENDING-вложения подготовлены к ленивой уборке",
  );

  after(async () => {
    // S3 DeleteObjects принимает не больше 1000 ключей. Каждый batch
    // финализируется отдельно: успех S3 никогда не откатывается обратно в
    // PENDING, а сбой не затрагивает токены успешных batch.
    for (let offset = 0; offset < input.cleanupItems.length; offset += 1000) {
      const batch = input.cleanupItems.slice(offset, offset + 1000);
      const tokens = batch.map((attachment) => attachment.token);

      try {
        await deleteObjects(batch.map((attachment) => attachment.key));
      } catch (s3Error) {
        try {
          await withSpaceDb(input.userId, input.spaceId, (tx) => {
            return finishAttachmentMaintenance(tx, tokens, true);
          });
        } catch (restoreError) {
          logger.error(
            {
              error: restoreError,
              count: batch.length,
              listId: input.listId,
              action: "requestUpload.cleanup.restore",
            },
            "Не удалось вернуть cleanup-токены в PENDING",
          );
        }
        logger.error(
          {
            error: s3Error,
            count: batch.length,
            listId: input.listId,
            action: "requestUpload.cleanup",
          },
          "Не удалось удалить просроченные PENDING-объекты из S3",
        );
        continue;
      }

      try {
        await withSpaceDb(input.userId, input.spaceId, (tx) => {
          return finishAttachmentMaintenance(tx, tokens, false);
        });
      } catch (finalizeError) {
        // Объекты уже удалены. Оставляем CLEANUP_PENDING для безопасного
        // идемпотентного повтора вместо восстановления битых ссылок.
        logger.error(
          {
            error: finalizeError,
            count: batch.length,
            listId: input.listId,
            action: "requestUpload.cleanup.finalize",
          },
          "Не удалось финализировать cleanup-токены после удаления S3",
        );
      }
    }
  });
}

/**
 * Шаг 1 — запросить загрузку файла.
 *
 * Проверяет авторизацию, доступ к списку и квоты, создаёт PENDING-строку
 * вложения и возвращает presigned POST для прямой заливки в S3.
 *
 * @param input - `{ listId, fileName, contentType, size }` (size/contentType —
 *                заявленные клиентом, реальные проверит S3 + HeadObject).
 * @returns `{ success, upload? , error? }`. Коды ошибок переводятся на клиенте.
 */
export async function requestUpload(input: {
  listId: string;
  spaceId: string;
  fileName: string;
  contentType: string;
  size: number;
}): Promise<RequestUploadResult> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "unauthorized" };
    }

    // Загрузка стоит двух единиц бюджета — эта и `confirmUpload`. Так и должно
    // быть: обе половины создают запись в БД, а вторая ещё и ходит в S3.
    if (!(await consumeMutationBudget(session.user.id))) {
      return { success: false, error: "dailyLimitReached" };
    }

    // S3 не настроен — нет смысла создавать PENDING-строку, которую некуда залить.
    if (!isS3Configured()) {
      logger.error({ action: "requestUpload" }, "S3 не сконфигурирован (env)");
      return { success: false, error: "uploadError" };
    }

    const result = requestUploadSchema.safeParse(input);
    if (!result.success) {
      return { success: false, error: "validationError" };
    }
    const { listId, spaceId, fileName, contentType, size } = result.data;

    // Тип файла — по белому списку (png/jpeg/txt/pdf). Это ранний отсев;
    // окончательно тип закрепляет S3-policy (eq $Content-Type).
    if (!isAllowedType(contentType)) {
      return { success: false, error: "invalidFileType" };
    }
    const category = getCategory(contentType) as FileCategory;

    // Object key генерируем сами — исключает коллизии и path-traversal.
    const key = buildAttachmentKey(listId, contentType);
    if (!key) {
      return { success: false, error: "invalidFileType" };
    }

    const userId = session.user.id;

    // --- Транзакция с row-lock: проверка квоты без гонок (TOCTOU) ---
    // Лочим строку List (SELECT ... FOR UPDATE): параллельные запросы на тот же
    // список выстраиваются в очередь и видят актуальный COUNT, а не одинаковый
    // устаревший. Тот же приём, что у UserDailyUsage.
    const txResult = await withSpaceDb(userId, spaceId, async (tx) => {
      // Лок + проверка существования списка
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "List" WHERE id = ${listId} FOR UPDATE`;
      if (locked.length === 0) {
        return { error: "listNotFound" as const };
      }

      // Membership: владелец или пользователь с записью ListShare.
      const list = await tx.list.findFirst({
        where: {
          id: listId,
          ...listInSpaceWhere(userId, spaceId),
        },
        select: { id: true },
      });
      if (!list) {
        return { error: "listNotFound" as const };
      }

      // SECURITY DEFINER helper видит глобальную пользовательскую квоту, но
      // принимает только проверенный transaction-local user/space context.
      // Просроченные PENDING не удаляются сразу: БД выдаёт одноразовые токены
      // и переводит их в невидимое CLEANUP_PENDING до результата S3.
      const maintenance = await prepareAttachmentMaintenance(tx, listId);

      // Квота на список: считаем PENDING + UPLOADED (иначе обход через пачку
      // запросов «всё PENDING — ничего не в счёт»). CLEANUP_PENDING уже
      // исключён из активной квоты, но метаданные остаются восстанавливаемыми.
      const listCount = await tx.attachment.count({
        where: {
          listId,
          status: { in: ["PENDING", "UPLOADED"] },
        },
      });
      if (listCount >= MAX_FILES_PER_LIST) {
        return {
          error: "listQuotaExceeded" as const,
          cleanupItems: maintenance.cleanupItems,
        };
      }

      // Квота на пользователя — без отдельного лока (ставки низкие, см. доку).
      if (maintenance.userCount >= MAX_FILES_PER_USER) {
        return {
          error: "userQuotaExceeded" as const,
          cleanupItems: maintenance.cleanupItems,
        };
      }

      // Создаём PENDING-строку. size здесь — заявленный; реальный перезапишем
      // на confirm после HeadObject.
      const attachment = await tx.attachment.create({
        data: {
          key,
          name: fileName,
          type: category,
          contentType,
          size,
          status: "PENDING",
          listId,
          uploadedById: userId,
        },
        select: { id: true },
      });
      return {
        attachmentId: attachment.id,
        cleanupItems: maintenance.cleanupItems,
      };
    }).catch((error) => {
      if (isMissingSpace(error)) {
        return { error: "listNotFound" as const };
      }
      throw error;
    });

    // S3-уборка не должна задерживать выдачу нового presigned POST и не
    // откатывает уже завершённую транзакцию. Versioning бакета превращает
    // удаление в recoverable delete marker, а noncurrent-версия истекает по
    // lifecycle-правилу.
    if ("cleanupItems" in txResult && txResult.cleanupItems) {
      scheduleAttachmentCleanup({
        cleanupItems: txResult.cleanupItems,
        userId,
        spaceId,
        listId,
      });
    }

    if ("error" in txResult) {
      return { success: false, error: txResult.error };
    }

    // Presigned POST генерим вне транзакции (это сетевой вызов к AWS, не БД).
    const { url, fields } = await createUploadPost({
      key,
      contentType,
      maxSize: MAX_FILE_SIZE,
    });

    logger.info(
      {
        uid: hashId(userId),
        listId,
        attachmentId: txResult.attachmentId,
        action: "requestUpload",
      },
      "Запрошена загрузка вложения",
    );

    return {
      success: true,
      upload: { url, fields, attachmentId: txResult.attachmentId },
    };
  } catch (error) {
    logger.error({ error }, "Ошибка при запросе загрузки вложения:");
    return { success: false, error: "uploadError" };
  }
}

/**
 * Шаг 3 — подтвердить загрузку.
 *
 * Вызывается клиентом после успешного ответа S3. Не доверяем слову клиента:
 * HeadObject проверяет, что файл действительно в S3, и даёт честный размер.
 * Только после этого строка переходит в UPLOADED и становится видимой в UI.
 *
 * При любом обломе строка остаётся PENDING — её приберёт ленивая уборка при
 * следующем `requestUpload` (квота временно занята, но это самоблокировка
 * юзера, не дыра).
 *
 * @param input - `{ attachmentId }` созданной на шаге 1 PENDING-строки.
 */
export async function confirmUpload(input: {
  attachmentId: string;
  spaceId: string;
  socketId?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "unauthorized" };
    }
    const userId = session.user.id;
    if (!(await consumeMutationBudget(userId))) {
      return { success: false, error: "dailyLimitReached" };
    }

    const result = confirmUploadSchema.safeParse(input);
    if (!result.success) {
      return { success: false, error: "validationError" };
    }

    // Membership-проверка + берём только PENDING-строку (идемпотентность:
    // повторный confirm на уже UPLOADED ничего не найдёт и не навредит).
    const attachment = await withSpaceDb(
      userId,
      result.data.spaceId,
      (tx) => {
        return tx.attachment.findFirst({
          where: {
            id: result.data.attachmentId,
            status: "PENDING",
            list: {
              ...listInSpaceWhere(userId, result.data.spaceId),
            },
          },
          select: { id: true, key: true, listId: true },
        });
      },
    ).catch((error) => {
      if (isMissingSpace(error)) return null;
      throw error;
    });
    if (!attachment) {
      logger.info(
        {
          uid: hashId(userId),
          attachmentId: result.data.attachmentId,
          action: "confirmUpload",
        },
        "PENDING-строка не найдена: нет доступа, чужое пространство или уже подтверждено",
      );
      return { success: false, error: "attachmentNotFound" };
    }

    // HeadObject — доказательство факта загрузки и реальный размер/тип.
    // Сеть вызывается после закрытия scoped DB-транзакции.
    const head = await headObject(attachment.key);
    if (!head) {
      // Файла в S3 нет (клиент соврал или загрузка сорвалась) — оставляем
      // PENDING. Причину отказа печатает сам headObject: без неё сорванная
      // загрузка и отсутствие прав выглядели в логе одинаково — то есть никак.
      logger.warn(
        {
          uid: hashId(userId),
          attachmentId: attachment.id,
          action: "confirmUpload",
        },
        "Объект не найден в S3 — подтверждать нечего",
      );
      return { success: false, error: "uploadNotFound" };
    }

    // Размер здесь фактический — его считает сам S3. Тип фактическим НЕ
    // является: `HeadObject` возвращает ярлык, который клиент положил в форму
    // presigned POST, а policy лишь сверила его с разрешённым значением.
    if (
      head.contentLength <= 0 ||
      head.contentLength > MAX_FILE_SIZE ||
      !isAllowedType(head.contentType)
    ) {
      logger.warn(
        {
          uid: hashId(userId),
          attachmentId: attachment.id,
          size: head.contentLength,
          contentType: head.contentType,
          action: "confirmUpload",
        },
        "Фактический файл не прошёл валидацию",
      );
      return { success: false, error: "invalidFileType" };
    }

    // Содержимое: сверяем начало файла с сигнатурой заявленного типа. Это
    // единственная проверка, которая смотрит на байты, а не на метаданные, —
    // без неё под ярлыком image/png хранится что угодно. Для типов без
    // сигнатуры (text/plain) в S3 не ходим: проверять нечем.
    if (hasMagicBytes(head.contentType)) {
      const prefix = await getObjectPrefix(
        attachment.key,
        MAGIC_BYTES_PREFIX_LENGTH,
      );
      // null — прочитать не удалось; трактуем как отказ (fail-closed), строка
      // остаётся PENDING и попадёт под ленивую уборку.
      if (!prefix || !matchesMagicBytes(head.contentType, prefix)) {
        logger.warn(
          {
            uid: hashId(userId),
            attachmentId: attachment.id,
            contentType: head.contentType,
            read: prefix !== null,
            action: "confirmUpload",
          },
          "Содержимое файла не соответствует сигнатуре заявленного типа",
        );
        return { success: false, error: "invalidFileType" };
      }
    }

    // status = UPLOADED + реальный размер. updateMany c status=PENDING в where
    // делает переход атомарным и идемпотентным.
    const confirmation = await withSpaceDb(
      userId,
      result.data.spaceId,
      async (tx) => {
        const list = await tx.list.findFirst({
          where: {
            id: attachment.listId,
            ...listInSpaceWhere(userId, result.data.spaceId),
          },
          select: {
            ownerId: true,
            shares: { select: { userId: true } },
          },
        });
        if (!list) return null;

        const updated = await tx.attachment.updateMany({
          where: {
            id: attachment.id,
            status: "PENDING",
            list: listInSpaceWhere(userId, result.data.spaceId),
          },
          data: { status: "UPLOADED", size: head.contentLength },
        });
        if (updated.count === 0) return null;

        await writeAuditEvent(tx, {
          action: "ATTACHMENT_UPLOADED",
          spaceId: result.data.spaceId,
          listId: attachment.listId,
          targetId: attachment.id,
        });

        return {
          recipientIds: [
            ...new Set([
              list.ownerId,
              ...list.shares.map((share) => share.userId),
            ]),
          ],
        };
      },
    ).catch((error) => {
      if (isMissingSpace(error)) return null;
      throw error;
    });
    if (!confirmation) {
      return { success: false, error: "attachmentNotFound" };
    }

    revalidatePath("/", "layout");
    // Получатели вычислены до commit; after не обращается к tenant-таблицам.
    after(() => notifyUsers(confirmation.recipientIds, result.data.socketId));
    logger.info(
      {
        uid: hashId(userId),
        listId: attachment.listId,
        attachmentId: attachment.id,
        action: "confirmUpload",
      },
      "Загрузка вложения подтверждена",
    );
    return { success: true };
  } catch (error) {
    logger.error({ error }, "Ошибка при подтверждении загрузки вложения:");
    return { success: false, error: "uploadError" };
  }
}

/**
 * Удаляет вложение. Доступно любому участнику списка (не только загрузившему) —
 * переиспользуется тот же membership-чек, закрывая IDOR.
 *
 * Порядок: сначала БД, потом S3 (best-effort). Если S3-удаление упадёт,
 * останется невидимый сирота — это дешевле, чем битая ссылка в UI.
 *
 * @param input - `{ attachmentId }`.
 */
export async function deleteAttachment(input: {
  attachmentId: string;
  spaceId: string;
  socketId?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "unauthorized" };
    }
    const userId = session.user.id;
    if (!(await consumeMutationBudget(userId))) {
      return { success: false, error: "dailyLimitReached" };
    }

    const result = deleteAttachmentSchema.safeParse(input);
    if (!result.success) {
      return { success: false, error: "validationError" };
    }

    // Membership, payload для post-commit эффектов и удаление строки образуют
    // одну scoped-транзакцию. Ни S3, ни Pusher внутри неё не вызываются.
    const deletion = await withSpaceDb(
      userId,
      result.data.spaceId,
      async (tx) => {
        const attachment = await tx.attachment.findFirst({
          where: {
            id: result.data.attachmentId,
            list: {
              ...listInSpaceWhere(userId, result.data.spaceId),
            },
          },
          select: {
            id: true,
            key: true,
            listId: true,
            list: {
              select: {
                ownerId: true,
                shares: { select: { userId: true } },
              },
            },
          },
        });
        if (!attachment) return null;

        const deleted = await tx.attachment.deleteMany({
          where: {
            id: attachment.id,
            list: listInSpaceWhere(userId, result.data.spaceId),
          },
        });
        if (deleted.count === 0) return null;

        await writeAuditEvent(tx, {
          action: "ATTACHMENT_DELETED",
          spaceId: result.data.spaceId,
          listId: attachment.listId,
          targetId: attachment.id,
        });

        return {
          id: attachment.id,
          key: attachment.key,
          listId: attachment.listId,
          recipientIds: [
            ...new Set([
              attachment.list.ownerId,
              ...attachment.list.shares.map((share) => share.userId),
            ]),
          ],
        };
      },
    ).catch((error) => {
      if (isMissingSpace(error)) return null;
      throw error;
    });
    if (!deletion) {
      return { success: false, error: "attachmentNotFound" };
    }

    // Потом S3 — best-effort: сбой логируем, но не валим операцию.
    try {
      await deleteObject(deletion.key);
    } catch (s3Error) {
      logger.error(
        { error: s3Error, key: deletion.key, action: "deleteAttachment" },
        "Не удалось удалить объект из S3 (осиротевший файл)",
      );
    }

    revalidatePath("/", "layout");
    // Получатели вычислены до commit; after не обращается к tenant-таблицам.
    after(() => notifyUsers(deletion.recipientIds, result.data.socketId));
    logger.info(
      {
        uid: hashId(userId),
        listId: deletion.listId,
        attachmentId: deletion.id,
        action: "deleteAttachment",
      },
      "Вложение удалено",
    );
    return { success: true };
  } catch (error) {
    logger.error({ error }, "Ошибка при удалении вложения:");
    return { success: false, error: "deleteError" };
  }
}

/**
 * Выдаёт presigned GET-ссылку на скачивание/просмотр вложения.
 * Bucket приватный — это единственный способ отдать файл. TTL короткий.
 *
 * @param input - `{ attachmentId, download? }`.
 * @returns `{ success, url? , error? }`.
 */
export async function getAttachmentUrl(input: {
  attachmentId: string;
  spaceId: string;
  download?: boolean;
}): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: "unauthorized" };
    }
    // Суточный бюджет здесь намеренно не списывается: это единственное действие
    // модуля, которое ничего не меняет. Подпись считается локально, в AWS
    // вызов не идёт, а раздать уже скачанные байты можно и без новой ссылки.
    const userId = session.user.id;

    const result = getAttachmentUrlSchema.safeParse(input);
    if (!result.success) {
      return { success: false, error: "validationError" };
    }

    // Membership + только UPLOADED (PENDING-файла в S3 может ещё не быть).
    const attachment = await withSpaceDb(
      userId,
      result.data.spaceId,
      (tx) => {
        return tx.attachment.findFirst({
          where: {
            id: result.data.attachmentId,
            status: "UPLOADED",
            list: {
              ...listInSpaceWhere(userId, result.data.spaceId),
            },
          },
          select: { key: true, name: true, contentType: true },
        });
      },
    ).catch((error) => {
      if (isMissingSpace(error)) return null;
      throw error;
    });
    if (!attachment) {
      return { success: false, error: "attachmentNotFound" };
    }

    // Presigned GET создаётся только после закрытия DB-транзакции.
    const url = await getDownloadUrl(
      attachment.key,
      attachment.name,
      attachment.contentType,
      result.data.download ?? false,
    );
    return { success: true, url };
  } catch (error) {
    logger.error({ error }, "Ошибка при выдаче ссылки на вложение:");
    return { success: false, error: "downloadError" };
  }
}
