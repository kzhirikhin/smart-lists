/**
 * @file s3.ts
 * @description Серверный S3-клиент и хелперы для работы с вложениями.
 *
 * ВНИМАНИЕ: модуль работает с учётными данными AWS и НЕ должен импортироваться
 * в клиентские компоненты (`"use client"`). Использовать только из Server Actions.
 *
 * Архитектурный принцип фичи — клиент грузит байты напрямую в S3 по presigned
 * POST, минуя serverless-функцию. Здесь же — генерация presigned URL, проверка
 * факта загрузки (HeadObject) и удаление объектов.
 *
 * Все хелперы адресуют объекты по object key (`lists/{listId}/{uuid}.ext`),
 * а не по полному URL: key стабилен, URL завязан на bucket/регион и протухает.
 */

import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import {
  createPresignedPost,
  type PresignedPost,
} from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { getExtension } from "@/lib/attachments";
import { logger } from "@/lib/logger";
import { resolveS3Credentials } from "@/lib/s3-credentials";

// ---------------------------------------------------------------------------
// Конфигурация из env
// ---------------------------------------------------------------------------

/**
 * Имя бакета. Читаем один раз при загрузке модуля.
 * Если переменные не заданы — клиент всё равно создаётся, но запросы упадут;
 * каждый Server Action логирует ошибку и возвращает понятный результат.
 */
const BUCKET = process.env.S3_BUCKET_NAME ?? "";
const REGION = process.env.S3_REGION ?? "";

/** Срок жизни presigned-ссылок (секунды). Коротко — это разовый доступ. */
const PRESIGN_TTL = 300; // 5 минут

/**
 * Единственный экземпляр S3Client.
 * Учётные данные передаём явно (а не через авто-обнаружение SDK) — это
 * развязывает нас от зарезервированных `AWS_*`-имён на платформах вроде Vercel.
 * По той же причине роль читается из `S3_ROLE_ARN`, а не из документированного
 * Vercel `AWS_ROLE_ARN`: имя вида `AWS_*` платформа вправе переопределить, и
 * `AWS_REGION` она действительно выставляет сама, по региону исполнения.
 */
const s3Client = new S3Client({
  region: REGION,
  credentials: resolveS3Credentials(process.env),
});

/**
 * Достаточно ли конфигурации, чтобы обращаться к S3.
 *
 * Проверяются именно те переменные, которые выбрал `resolveS3Credentials`:
 * при федерации статических ключей нет и требовать их нельзя, иначе вложения
 * выключатся на рабочей конфигурации.
 */
export function isS3Configured(): boolean {
  if (!BUCKET || !REGION) return false;
  if (process.env.S3_ROLE_ARN) return true;
  return Boolean(
    process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY,
  );
}

// ---------------------------------------------------------------------------
// Генерация object key
// ---------------------------------------------------------------------------

/**
 * Строит object key по схеме `lists/{listId}/{uuid}.ext`.
 * Имя файла генерируем сами (UUID) — это исключает коллизии, юникод-сюрпризы
 * и path-traversal из пользовательского имени.
 *
 * @returns key или null, если MIME-тип не разрешён (нет расширения).
 */
export function buildAttachmentKey(
  listId: string,
  contentType: string,
): string | null {
  const ext = getExtension(contentType);
  if (!ext) return null;
  return `lists/${listId}/${randomUUID()}.${ext}`;
}

// ---------------------------------------------------------------------------
// Presigned POST (загрузка: клиент → S3 напрямую)
// ---------------------------------------------------------------------------

/**
 * Генерирует presigned POST для прямой загрузки файла в S3.
 *
 * В policy зашиты условия, которые S3 проверяет ДО сохранения:
 *   - `content-length-range` — потолок размера (файл вне диапазона → 400);
 *   - `eq $Content-Type` — ровно тот тип, что мы разрешили.
 *
 * Именно POST (а не PUT): только он умеет ограничить размер на стороне S3.
 *
 * @returns `{ url, fields }` — клиент шлёт multipart/form-data на `url`
 *          с этими `fields` + самим файлом в поле `file` (последним).
 */
export function createUploadPost(params: {
  key: string;
  contentType: string;
  maxSize: number;
}): Promise<PresignedPost> {
  return createPresignedPost(s3Client, {
    Bucket: BUCKET,
    Key: params.key,
    Conditions: [
      ["content-length-range", 1, params.maxSize],
      ["eq", "$Content-Type", params.contentType],
    ],
    Fields: {
      "Content-Type": params.contentType,
    },
    Expires: PRESIGN_TTL,
  });
}

// ---------------------------------------------------------------------------
// HeadObject (подтверждение: проверяем факт + реальный размер)
// ---------------------------------------------------------------------------

/** Метаданные объекта из HeadObject. */
export interface ObjectHead {
  contentLength: number;
  contentType: string;
}

/**
 * Достаёт из ошибки AWS SDK то, что можно безопасно залогировать.
 *
 * Нужно потому, что «объекта нет» и «нет прав / не тот бакет / не тот регион»
 * снаружи выглядят одинаково — как null. Без кода ошибки отказ загрузки
 * неотличим от неверной конфигурации, и в логе остаётся пустое место.
 * Ни ключей, ни подписей в этих полях нет.
 */
function describeS3Error(error: unknown): {
  errorName: string;
  httpStatus?: number;
} {
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      name?: unknown;
      $metadata?: { httpStatusCode?: unknown };
    };
    return {
      errorName: typeof candidate.name === "string" ? candidate.name : "Unknown",
      httpStatus:
        typeof candidate.$metadata?.httpStatusCode === "number"
          ? candidate.$metadata.httpStatusCode
          : undefined,
    };
  }
  return { errorName: "Unknown" };
}

/**
 * Запрашивает метаданные объекта (HeadObject).
 * Используется на confirm: подтверждение клиента — это его слово, а HeadObject
 * даёт факт наличия и честный размер.
 *
 * @returns метаданные или null, если объекта нет / запрос упал.
 */
export async function headObject(key: string): Promise<ObjectHead | null> {
  try {
    const res = await s3Client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    return {
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType ?? "",
    };
  } catch (error) {
    // Для вызывающего это «не залилось», но 404 и 403 означают совершенно
    // разное: первое — сорванную загрузку, второе — сломанную конфигурацию.
    // Молчаливый null делал эти случаи неразличимыми в логе.
    logger.warn(
      { ...describeS3Error(error), key, action: "headObject" },
      "HeadObject не вернул метаданные объекта",
    );
    return null;
  }
}

/**
 * Читает первые `length` байт объекта (Range-запрос) — для проверки сигнатуры.
 *
 * Отдельный вызов, а не расширение `headObject`: HeadObject тела не возвращает
 * в принципе. Запрашиваем именно диапазон, а не объект целиком — платить
 * трафиком за 10 MB ради 16 байт незачем.
 *
 * @returns префикс или null, если объекта нет либо запрос упал. Для
 *          вызывающего null означает «проверить не удалось», то есть отказ.
 */
export async function getObjectPrefix(
  key: string,
  length: number,
): Promise<Uint8Array | null> {
  try {
    const res = await s3Client.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Range: `bytes=0-${length - 1}`,
      }),
    );
    if (!res.Body) return null;
    return await res.Body.transformToByteArray();
  } catch (error) {
    // Нет объекта, пустой объект (416 на Range), нет права s3:GetObject или
    // сетевая ошибка. Отличать их обязательно: отказ по содержимому и отказ
    // по правам приводят к одному и тому же ответу пользователю.
    logger.warn(
      { ...describeS3Error(error), key, action: "getObjectPrefix" },
      "Не удалось прочитать префикс объекта для проверки сигнатуры",
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Presigned GET (скачивание/просмотр)
// ---------------------------------------------------------------------------

/**
 * Генерирует presigned GET URL с коротким TTL.
 * Bucket приватный — прямых публичных ссылок нет, отдаём только так.
 *
 * @param key      object key в S3.
 * @param fileName оригинальное имя — для заголовка Content-Disposition.
 * @param download true → форсировать скачивание (attachment), false → инлайн-просмотр.
 */
export function getDownloadUrl(
  key: string,
  fileName: string,
  download = false,
): Promise<string> {
  // encodeURIComponent защищает заголовок от спецсимволов и юникода в имени
  // (в том числе от CR/LF), но оставляет `!'()*`, которых нет в `attr-char`
  // RFC 5987. Апостроф особенно неудачен: на нём парсер режет charset и
  // language, так что `it's.txt` давал формально невалидный заголовок.
  const encodedName = encodeURIComponent(fileName).replace(
    /['()*!]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const disposition = `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodedName}`;
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentDisposition: disposition,
  });
  return getSignedUrl(s3Client, command, { expiresIn: PRESIGN_TTL });
}

// ---------------------------------------------------------------------------
// Удаление объектов
// ---------------------------------------------------------------------------

/**
 * Удаляет один объект из S3.
 * Бросает при ошибке — вызывающий решает, делать ли это best-effort.
 */
export async function deleteObject(key: string): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/**
 * Батч-удаление объектов (до 1000 ключей за вызов — лимит S3 DeleteObjects).
 * Используется при удалении списка: ключи читаются до каскада, затем сносятся.
 * Пустой массив — no-op (S3 не принимает пустой Delete).
 */
export async function deleteObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const result = await s3Client.send(
    new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    }),
  );
  // DeleteObjects может вернуть HTTP 200 и отдельные ошибки по ключам.
  // Считаем batch неуспешным, чтобы вызывающий не удалил метаданные БД.
  if (result.Errors && result.Errors.length > 0) {
    throw new Error(
      `S3 не удалил часть объектов (ошибок: ${result.Errors.length}).`,
    );
  }
}
