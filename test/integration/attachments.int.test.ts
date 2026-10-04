/**
 * @file attachments.int.test.ts
 * @description Вложения: two-phase-загрузка, квоты, ленивая уборка и доступ.
 *
 * S3 замокан (сеть и секреты не нужны), но вся логика вокруг него настоящая:
 * PENDING-строка занимает квоту до подтверждения, `confirmUpload` доверяет
 * не клиенту, а HeadObject, а зависшие PENDING убираются лениво при следующем
 * запросе загрузки. Проверяется именно это поведение на реальной БД.
 */

import { describe, expect, it, vi } from "vitest";

import {
  confirmUpload,
  deleteAttachment,
  getAttachmentUrl,
  requestUpload,
} from "@/app/actions/attachments";
import {
  MAX_FILES_PER_LIST,
  MAX_FILES_PER_USER,
  STALE_MINUTES,
} from "@/lib/attachments";
import { finishAttachmentMaintenance } from "@/lib/attachment-maintenance";
import { withSpaceDb } from "@/lib/scoped-db";
import { adminPrisma, flushAfter, prisma, setSessionUser } from "./setup";
import { makeList, makeSpace, makeUser, shareList } from "./factories";

/** Готовая строка вложения (по умолчанию UPLOADED) для наполнения квоты. */
async function makeAttachment(
  listId: string,
  uploadedById: string,
  overrides?: { status?: "PENDING" | "UPLOADED"; createdAt?: Date; key?: string },
) {
  return prisma.attachment.create({
    data: {
      key: overrides?.key ?? `lists/${listId}/${crypto.randomUUID()}.png`,
      name: "file.png",
      type: "IMAGE",
      contentType: "image/png",
      size: 100,
      status: overrides?.status ?? "UPLOADED",
      listId,
      uploadedById,
      ...(overrides?.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

const PNG = { fileName: "photo.png", contentType: "image/png", size: 1000 };

describe("requestUpload", () => {
  it("создаёт PENDING-строку и возвращает данные для загрузки", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    setSessionUser(user.id);
    const { createUploadPost } = await import("@/lib/s3");
    vi.mocked(createUploadPost).mockImplementationOnce(async ({ key }) => {
      // Presign вызывается после commit: отдельное соединение уже видит PENDING.
      expect(
        await adminPrisma.attachment.findUnique({
          where: { key },
          select: { status: true },
        }),
      ).toEqual({ status: "PENDING" });
      return { url: "https://s3.test/upload", fields: {} };
    });

    const result = await requestUpload({
      listId: list.id,
      spaceId: user.defaultSpaceId,
      ...PNG,
    });

    expect(result.success).toBe(true);
    expect(result.upload?.attachmentId).toBeDefined();
    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: result.upload!.attachmentId },
    });
    expect(row.status).toBe("PENDING");
    expect(row.type).toBe("IMAGE");
    expect(row.key).toMatch(new RegExp(`^lists/${list.id}/.+\\.png$`));
  });

  it("сохраняет очищенное имя файла, а не присланное клиентом", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    setSessionUser(user.id);

    const result = await requestUpload({
      listId: list.id,
      spaceId: user.defaultSpaceId,
      // RIGHT-TO-LEFT OVERRIDE показал бы это имя как "фотоgnp.exe" наоборот —
      // другим участникам списка расширение выглядело бы картинкой.
      fileName: "фото\u202Egnp.exe",
      contentType: "image/png",
      size: 1000,
    });

    expect(result.success).toBe(true);
    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: result.upload!.attachmentId },
    });
    expect(row.name).toBe("фотоgnp.exe");
  });

  it("отклоняет неразрешённый тип файла", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    setSessionUser(user.id);

    const result = await requestUpload({
      listId: list.id,
      spaceId: user.defaultSpaceId,
      fileName: "a.zip",
      contentType: "application/zip",
      size: 1000,
    });

    expect(result).toEqual({ success: false, error: "invalidFileType" });
    expect(await prisma.attachment.count()).toBe(0);
  });

  it("отклоняет файл больше лимита размера", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    setSessionUser(user.id);

    const result = await requestUpload({
      listId: list.id,
      spaceId: user.defaultSpaceId,
      fileName: "big.png",
      contentType: "image/png",
      size: 10 * 1024 * 1024 + 1,
    });

    expect(result).toEqual({ success: false, error: "validationError" });
  });

  it("не даёт загрузить в чужой список", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const list = await makeList(owner.id, owner.defaultSpaceId);
    setSessionUser(stranger.id);

    const result = await requestUpload({
      listId: list.id,
      spaceId: stranger.defaultSpaceId,
      ...PNG,
    });

    expect(result).toEqual({ success: false, error: "listNotFound" });
    expect(await prisma.attachment.count()).toBe(0);
  });

  it("редактору загрузка в расшаренный список разрешена", async () => {
    const owner = await makeUser();
    const editor = await makeUser();
    const list = await makeList(owner.id, owner.defaultSpaceId);
    await shareList(list.id, editor.id);
    setSessionUser(editor.id);

    const result = await requestUpload({
      listId: list.id,
      spaceId: editor.defaultSpaceId,
      ...PNG,
    });

    expect(result.success).toBe(true);
  });

  it("упирается в квоту списка (PENDING тоже считается)", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    // Заполняем список до предела смесью UPLOADED и PENDING.
    for (let i = 0; i < MAX_FILES_PER_LIST; i++) {
      await makeAttachment(list.id, user.id, {
        status: i % 2 === 0 ? "UPLOADED" : "PENDING",
      });
    }
    setSessionUser(user.id);

    const result = await requestUpload({
      listId: list.id,
      spaceId: user.defaultSpaceId,
      ...PNG,
    });

    expect(result).toEqual({ success: false, error: "listQuotaExceeded" });
  });

  it("завершает stale-cleanup, даже если активная квота списка исчерпана", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    for (let i = 0; i < MAX_FILES_PER_LIST; i++) {
      await makeAttachment(list.id, user.id);
    }
    const staleRow = await makeAttachment(list.id, user.id, {
      status: "PENDING",
      createdAt: new Date(Date.now() - (STALE_MINUTES + 5) * 60 * 1000),
    });
    setSessionUser(user.id);

    const result = await requestUpload({
      listId: list.id,
      spaceId: user.defaultSpaceId,
      ...PNG,
    });

    expect(result).toEqual({ success: false, error: "listQuotaExceeded" });
    expect(
      await prisma.attachment.findUnique({ where: { id: staleRow.id } }),
    ).toMatchObject({ status: "CLEANUP_PENDING" });
    await flushAfter();
    expect(
      await prisma.attachment.findUnique({ where: { id: staleRow.id } }),
    ).toBeNull();
    const { deleteObjects } = await import("@/lib/s3");
    expect(vi.mocked(deleteObjects)).toHaveBeenCalledWith([staleRow.key]);
  });

  it("упирается в квоту пользователя поверх нескольких списков", async () => {
    const user = await makeUser();
    // 20 файлов пользователя распределены по разным пространствам. Квота
    // глобальна для пользователя, а не начинается заново в каждом space.
    const lists = [];
    for (let l = 0; l < MAX_FILES_PER_USER / MAX_FILES_PER_LIST; l++) {
      const space = await makeSpace(user.id, `Space ${l + 1}`);
      const list = await makeList(user.id, space.id);
      lists.push(list);
      for (let i = 0; i < MAX_FILES_PER_LIST; i++) {
        await makeAttachment(list.id, user.id);
      }
    }
    // Свежий пустой список: квота списка свободна, но пользовательская исчерпана.
    const freshList = await makeList(user.id, user.defaultSpaceId);
    setSessionUser(user.id);

    const result = await requestUpload({
      listId: freshList.id,
      spaceId: user.defaultSpaceId,
      ...PNG,
    });

    expect(result).toEqual({ success: false, error: "userQuotaExceeded" });
  });

  it("лениво убирает зависшие PENDING и освобождает квоту", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const stale = new Date(Date.now() - (STALE_MINUTES + 5) * 60 * 1000);
    // Список забит, но все строки — просроченные PENDING.
    const staleIds: string[] = [];
    const staleKeys: string[] = [];
    for (let i = 0; i < MAX_FILES_PER_LIST; i++) {
      const row = await makeAttachment(list.id, user.id, {
        status: "PENDING",
        createdAt: stale,
      });
      staleIds.push(row.id);
      staleKeys.push(row.key);
    }
    setSessionUser(user.id);

    const result = await requestUpload({
      listId: list.id,
      spaceId: user.defaultSpaceId,
      ...PNG,
    });

    // Уборка освободила место, новая загрузка прошла.
    expect(result.success).toBe(true);
    // Квота уже освобождена, но метаданные остаются до результата S3.
    expect(
      await prisma.attachment.findMany({
        where: { id: { in: staleIds } },
        select: {
          status: true,
          cleanupToken: true,
          cleanupRequestedById: true,
        },
      }),
    ).toEqual(
      expect.arrayContaining(
        staleIds.map(() => ({
          status: "CLEANUP_PENDING",
          cleanupToken: expect.any(String),
          cleanupRequestedById: user.id,
        })),
      ),
    );

    const { deleteObjects } = await import("@/lib/s3");
    expect(vi.mocked(deleteObjects)).not.toHaveBeenCalled();
    await flushAfter();
    expect(vi.mocked(deleteObjects)).toHaveBeenCalledOnce();
    expect(vi.mocked(deleteObjects)).toHaveBeenCalledWith(staleKeys);
    expect(
      await prisma.attachment.count({ where: { id: { in: staleIds } } }),
    ).toBe(0);
  });

  it("убирает собственный stale PENDING из другого пространства", async () => {
    const user = await makeUser();
    const otherSpace = await makeSpace(user.id, "Другое");
    const otherList = await makeList(user.id, otherSpace.id);
    const currentList = await makeList(user.id, user.defaultSpaceId);
    const staleRow = await makeAttachment(otherList.id, user.id, {
      status: "PENDING",
      createdAt: new Date(Date.now() - (STALE_MINUTES + 5) * 60 * 1000),
    });
    setSessionUser(user.id);

    const result = await requestUpload({
      listId: currentList.id,
      spaceId: user.defaultSpaceId,
      ...PNG,
    });

    expect(result.success).toBe(true);
    expect(
      await prisma.attachment.findUnique({ where: { id: staleRow.id } }),
    ).toMatchObject({
      status: "CLEANUP_PENDING",
      cleanupRequestedById: user.id,
    });
    const { deleteObjects } = await import("@/lib/s3");
    await flushAfter();
    expect(vi.mocked(deleteObjects)).toHaveBeenCalledWith([staleRow.key]);
    expect(
      await prisma.attachment.findUnique({ where: { id: staleRow.id } }),
    ).toBeNull();
  });

  it("не трогает свежие PENDING при уборке", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    // Свежие PENDING (только что созданы) заполняют квоту и убираться не должны.
    for (let i = 0; i < MAX_FILES_PER_LIST; i++) {
      await makeAttachment(list.id, user.id, { status: "PENDING" });
    }
    setSessionUser(user.id);

    const result = await requestUpload({
      listId: list.id,
      spaceId: user.defaultSpaceId,
      ...PNG,
    });

    // Свежие PENDING на месте, квота списка по-прежнему исчерпана.
    expect(result).toEqual({ success: false, error: "listQuotaExceeded" });
    expect(await prisma.attachment.count({ where: { listId: list.id } })).toBe(
      MAX_FILES_PER_LIST,
    );
  });

  it("возвращает PENDING-метаданные для повтора при сбое S3-уборки", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const staleRow = await makeAttachment(list.id, user.id, {
      status: "PENDING",
      createdAt: new Date(Date.now() - (STALE_MINUTES + 5) * 60 * 1000),
    });
    setSessionUser(user.id);
    const { deleteObjects } = await import("@/lib/s3");
    vi.mocked(deleteObjects).mockRejectedValueOnce(new Error("S3 unavailable"));

    const result = await requestUpload({
      listId: list.id,
      spaceId: user.defaultSpaceId,
      ...PNG,
    });

    expect(result.success).toBe(true);
    expect(
      await prisma.attachment.findUnique({ where: { id: staleRow.id } }),
    ).toMatchObject({
      status: "CLEANUP_PENDING",
      cleanupRequestedById: user.id,
      cleanupToken: expect.any(String),
    });
    await flushAfter();
    expect(
      await prisma.attachment.findUnique({ where: { id: staleRow.id } }),
    ).toMatchObject({
      key: staleRow.key,
      status: "PENDING",
      cleanupToken: null,
      cleanupRequestedById: null,
      cleanupStartedAt: null,
    });
  });

  it("не позволяет другому пользователю завершить чужой cleanup-токен", async () => {
    const user = await makeUser();
    const stranger = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const staleRow = await makeAttachment(list.id, user.id, {
      status: "PENDING",
      createdAt: new Date(Date.now() - (STALE_MINUTES + 5) * 60 * 1000),
    });
    setSessionUser(user.id);

    expect(
      (
        await requestUpload({
          listId: list.id,
          spaceId: user.defaultSpaceId,
          ...PNG,
        })
      ).success,
    ).toBe(true);

    const claimed = await prisma.attachment.findUniqueOrThrow({
      where: { id: staleRow.id },
      select: { cleanupToken: true },
    });
    expect(claimed.cleanupToken).toEqual(expect.any(String));

    const affected = await withSpaceDb(
      stranger.id,
      stranger.defaultSpaceId,
      (tx) =>
        finishAttachmentMaintenance(tx, [claimed.cleanupToken!], false),
    );
    expect(affected).toBe(0);
    expect(
      await prisma.attachment.findUnique({ where: { id: staleRow.id } }),
    ).toMatchObject({
      status: "CLEANUP_PENDING",
      cleanupRequestedById: user.id,
    });
  });

  it("редактор может освободить квоту списка от чужого stale PENDING", async () => {
    const owner = await makeUser();
    const editor = await makeUser();
    const list = await makeList(owner.id, owner.defaultSpaceId);
    await shareList(list.id, editor.id);
    const staleRow = await makeAttachment(list.id, owner.id, {
      status: "PENDING",
      createdAt: new Date(Date.now() - (STALE_MINUTES + 5) * 60 * 1000),
    });
    setSessionUser(editor.id);

    const result = await requestUpload({
      listId: list.id,
      spaceId: editor.defaultSpaceId,
      ...PNG,
    });

    expect(result.success).toBe(true);
    expect(
      await prisma.attachment.findUnique({ where: { id: staleRow.id } }),
    ).toMatchObject({
      status: "CLEANUP_PENDING",
      cleanupRequestedById: editor.id,
    });
    await flushAfter();
    expect(
      await prisma.attachment.findUnique({ where: { id: staleRow.id } }),
    ).toBeNull();
  });

  it("fail-closed отклоняет подменённое чужое пространство во всех потоках", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const list = await makeList(owner.id, owner.defaultSpaceId);
    const row = await makeAttachment(list.id, owner.id, { status: "PENDING" });
    setSessionUser(stranger.id);

    expect(
      await requestUpload({
        listId: list.id,
        spaceId: owner.defaultSpaceId,
        ...PNG,
      }),
    ).toEqual({ success: false, error: "listNotFound" });
    expect(
      await confirmUpload({
        attachmentId: row.id,
        spaceId: owner.defaultSpaceId,
      }),
    ).toEqual({ success: false, error: "attachmentNotFound" });
    expect(
      await deleteAttachment({
        attachmentId: row.id,
        spaceId: owner.defaultSpaceId,
      }),
    ).toEqual({ success: false, error: "attachmentNotFound" });
    expect(
      await getAttachmentUrl({
        attachmentId: row.id,
        spaceId: owner.defaultSpaceId,
      }),
    ).toEqual({ success: false, error: "attachmentNotFound" });

    const s3 = await import("@/lib/s3");
    expect(vi.mocked(s3.createUploadPost)).not.toHaveBeenCalled();
    expect(vi.mocked(s3.headObject)).not.toHaveBeenCalled();
    expect(vi.mocked(s3.deleteObject)).not.toHaveBeenCalled();
    expect(vi.mocked(s3.getDownloadUrl)).not.toHaveBeenCalled();
    expect(
      await prisma.attachment.findUnique({ where: { id: row.id } }),
    ).not.toBeNull();
  });
});

describe("confirmUpload", () => {
  async function pending(userId: string, listId: string) {
    return makeAttachment(listId, userId, { status: "PENDING" });
  }

  it("переводит PENDING в UPLOADED и пишет реальный размер из HeadObject", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const row = await pending(user.id, list.id);
    setSessionUser(user.id);
    const { headObject } = await import("@/lib/s3");
    // HeadObject даёт честный размер, отличный от заявленного при создании.
    vi.mocked(headObject).mockImplementationOnce(async () => {
      // HeadObject идёт между двумя DB-фазами: первая уже закрыта, а переход
      // состояния ещё не начался.
      expect(
        await adminPrisma.attachment.findUnique({
          where: { id: row.id },
          select: { status: true },
        }),
      ).toEqual({ status: "PENDING" });
      return {
        contentLength: 4096,
        contentType: "image/png",
      };
    });

    const result = await confirmUpload({
      attachmentId: row.id,
      spaceId: user.defaultSpaceId,
    });

    expect(result).toEqual({ success: true });
    const updated = await prisma.attachment.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("UPLOADED");
    expect(updated.size).toBe(4096);
    await expect(
      adminPrisma.auditEvent.findFirstOrThrow({
        where: { action: "ATTACHMENT_UPLOADED", targetId: row.id },
      }),
    ).resolves.toMatchObject({
      actorUserId: user.id,
      listId: list.id,
      spaceId: user.defaultSpaceId,
      source: "APPLICATION",
    });
  });

  it("оставляет PENDING, когда файла нет в S3", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const row = await pending(user.id, list.id);
    setSessionUser(user.id);
    // headObject по умолчанию возвращает null (файла нет).

    const result = await confirmUpload({
      attachmentId: row.id,
      spaceId: user.defaultSpaceId,
    });

    expect(result).toEqual({ success: false, error: "uploadNotFound" });
    expect(
      (await prisma.attachment.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe("PENDING");
  });

  it("отбраковывает файл, не прошедший фактическую валидацию", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const row = await pending(user.id, list.id);
    setSessionUser(user.id);
    const { headObject } = await import("@/lib/s3");
    // Реальный файл оказался неразрешённого типа, что бы клиент ни заявлял.
    vi.mocked(headObject).mockResolvedValueOnce({
      contentLength: 100,
      contentType: "application/zip",
    });

    const result = await confirmUpload({
      attachmentId: row.id,
      spaceId: user.defaultSpaceId,
    });

    expect(result).toEqual({ success: false, error: "invalidFileType" });
    expect(
      (await prisma.attachment.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe("PENDING");
  });

  it("отбивает содержимое, не совпавшее с сигнатурой заявленного типа", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const row = await pending(user.id, list.id);
    setSessionUser(user.id);
    const { headObject, getObjectPrefix } = await import("@/lib/s3");
    // Метаданные безупречны: S3 подтверждает разрешённый тип и валидный размер.
    vi.mocked(headObject).mockResolvedValueOnce({
      contentLength: 100,
      contentType: "image/png",
    });
    // А в байтах — заголовок исполняемого файла Windows (MZ).
    vi.mocked(getObjectPrefix).mockResolvedValueOnce(
      new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
    );

    const result = await confirmUpload({
      attachmentId: row.id,
      spaceId: user.defaultSpaceId,
    });

    expect(result).toEqual({ success: false, error: "invalidFileType" });
    expect(
      (await prisma.attachment.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe("PENDING");
  });

  it("отказывает, когда прочитать содержимое не удалось (fail-closed)", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const row = await pending(user.id, list.id);
    setSessionUser(user.id);
    const { headObject, getObjectPrefix } = await import("@/lib/s3");
    vi.mocked(headObject).mockResolvedValueOnce({
      contentLength: 100,
      contentType: "image/png",
    });
    vi.mocked(getObjectPrefix).mockResolvedValueOnce(null);

    const result = await confirmUpload({
      attachmentId: row.id,
      spaceId: user.defaultSpaceId,
    });

    // Непрочитанное содержимое — не повод считать файл проверенным.
    expect(result).toEqual({ success: false, error: "invalidFileType" });
  });

  it("не читает содержимое у типа без сигнатуры", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const row = await pending(user.id, list.id);
    setSessionUser(user.id);
    const { headObject, getObjectPrefix } = await import("@/lib/s3");
    vi.mocked(headObject).mockResolvedValueOnce({
      contentLength: 100,
      contentType: "text/plain",
    });

    const result = await confirmUpload({
      attachmentId: row.id,
      spaceId: user.defaultSpaceId,
    });

    // У text/plain сигнатуры нет — ходить в S3 за байтами незачем.
    expect(result).toEqual({ success: true });
    expect(vi.mocked(getObjectPrefix)).not.toHaveBeenCalled();
  });

  it("идемпотентен: повторный confirm на UPLOADED не находит PENDING", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const row = await makeAttachment(list.id, user.id, { status: "UPLOADED" });
    setSessionUser(user.id);

    const result = await confirmUpload({
      attachmentId: row.id,
      spaceId: user.defaultSpaceId,
    });

    expect(result).toEqual({ success: false, error: "attachmentNotFound" });
  });

  it("уведомляет участников после подтверждения", async () => {
    const user = await makeUser();
    const editor = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await shareList(list.id, editor.id);
    const row = await pending(user.id, list.id);
    setSessionUser(user.id);
    const { headObject } = await import("@/lib/s3");
    vi.mocked(headObject).mockResolvedValueOnce({
      contentLength: 100,
      contentType: "image/png",
    });
    const { notifyUsers } = await import("@/lib/notify");

    await confirmUpload({ attachmentId: row.id, spaceId: user.defaultSpaceId });

    expect(vi.mocked(notifyUsers)).not.toHaveBeenCalled();
    await flushAfter();
    expect(vi.mocked(notifyUsers)).toHaveBeenCalledWith(
      [user.id, editor.id],
      undefined,
    );
  });
});

describe("deleteAttachment", () => {
  it("удаляет строку и объект из S3", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const row = await makeAttachment(list.id, user.id, { key: "lists/x/f.png" });
    setSessionUser(user.id);
    const { deleteObject } = await import("@/lib/s3");
    vi.mocked(deleteObject).mockImplementationOnce(async () => {
      // S3 cleanup вызывается после commit: строка уже исчезла для отдельного
      // соединения, поэтому сетевой сбой не способен откатить DB-мутацию.
      expect(
        await adminPrisma.attachment.findUnique({ where: { id: row.id } }),
      ).toBeNull();
    });

    const result = await deleteAttachment({
      attachmentId: row.id,
      spaceId: user.defaultSpaceId,
    });

    expect(result).toEqual({ success: true });
    expect(await prisma.attachment.findUnique({ where: { id: row.id } })).toBeNull();
    await expect(
      adminPrisma.auditEvent.findFirstOrThrow({
        where: { action: "ATTACHMENT_DELETED", targetId: row.id },
      }),
    ).resolves.toMatchObject({
      actorUserId: user.id,
      listId: list.id,
      spaceId: user.defaultSpaceId,
      source: "APPLICATION",
    });
    expect(vi.mocked(deleteObject)).toHaveBeenCalledWith("lists/x/f.png");
  });

  it("любой участник может удалить вложение, не только загрузивший", async () => {
    const owner = await makeUser();
    const editor = await makeUser();
    const list = await makeList(owner.id, owner.defaultSpaceId);
    await shareList(list.id, editor.id);
    // Файл загрузил владелец, удаляет редактор.
    const row = await makeAttachment(list.id, owner.id);
    setSessionUser(editor.id);

    const result = await deleteAttachment({
      attachmentId: row.id,
      spaceId: editor.defaultSpaceId,
    });

    expect(result).toEqual({ success: true });
    expect(await prisma.attachment.findUnique({ where: { id: row.id } })).toBeNull();
  });

  it("не даёт удалить вложение из чужого списка", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const list = await makeList(owner.id, owner.defaultSpaceId);
    const row = await makeAttachment(list.id, owner.id);
    setSessionUser(stranger.id);

    const result = await deleteAttachment({
      attachmentId: row.id,
      spaceId: stranger.defaultSpaceId,
    });

    expect(result).toEqual({ success: false, error: "attachmentNotFound" });
    expect(await prisma.attachment.findUnique({ where: { id: row.id } })).not.toBeNull();
  });

  it("сбой S3 не откатывает удаление строки (best-effort)", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const row = await makeAttachment(list.id, user.id);
    setSessionUser(user.id);
    const { deleteObject } = await import("@/lib/s3");
    vi.mocked(deleteObject).mockRejectedValueOnce(new Error("S3 down"));

    const result = await deleteAttachment({
      attachmentId: row.id,
      spaceId: user.defaultSpaceId,
    });

    // Строка удалена несмотря на сбой очистки S3 — осиротевший файл дешевле битой ссылки.
    expect(result).toEqual({ success: true });
    expect(await prisma.attachment.findUnique({ where: { id: row.id } })).toBeNull();
  });
});

describe("getAttachmentUrl", () => {
  it("выдаёт ссылку на UPLOADED-вложение", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const row = await makeAttachment(list.id, user.id, { status: "UPLOADED" });
    setSessionUser(user.id);

    const result = await getAttachmentUrl({
      attachmentId: row.id,
      spaceId: user.defaultSpaceId,
    });

    expect(result).toMatchObject({ success: true });
    expect(result.url).toBe("https://s3.test/download");
  });

  it("передаёт подписи хранимый тип, а не доверяет клиенту", async () => {
    // По типу из БД решается, объявлять ли charset: без него кириллица TXT
    // при инлайн-просмотре искажается.
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const row = await prisma.attachment.create({
      data: {
        key: `lists/${list.id}/${crypto.randomUUID()}.txt`,
        name: "заметка.txt",
        type: "DOCUMENT",
        contentType: "text/plain",
        size: 100,
        status: "UPLOADED",
        listId: list.id,
        uploadedById: user.id,
      },
    });
    setSessionUser(user.id);

    await getAttachmentUrl({
      attachmentId: row.id,
      spaceId: user.defaultSpaceId,
    });

    const s3 = await import("@/lib/s3");
    expect(vi.mocked(s3.getDownloadUrl)).toHaveBeenCalledWith(
      row.key,
      "заметка.txt",
      "text/plain",
      false,
    );
  });

  it("не выдаёт ссылку на ещё не подтверждённый PENDING", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const row = await makeAttachment(list.id, user.id, { status: "PENDING" });
    setSessionUser(user.id);

    const result = await getAttachmentUrl({
      attachmentId: row.id,
      spaceId: user.defaultSpaceId,
    });

    expect(result).toEqual({ success: false, error: "attachmentNotFound" });
  });

  it("не выдаёт ссылку постороннему", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const list = await makeList(owner.id, owner.defaultSpaceId);
    const row = await makeAttachment(list.id, owner.id, { status: "UPLOADED" });
    setSessionUser(stranger.id);

    const result = await getAttachmentUrl({
      attachmentId: row.id,
      spaceId: stranger.defaultSpaceId,
    });

    expect(result).toEqual({ success: false, error: "attachmentNotFound" });
  });
});
