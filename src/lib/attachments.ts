/**
 * @file attachments.ts
 * @description Общие константы и чистые хелперы для фичи вложений.
 *
 * ВАЖНО: этот модуль безопасен для импорта и на сервере, и на клиенте —
 * здесь нет AWS SDK и нет секретов. Клиентский компонент загрузки берёт
 * отсюда лимиты и список форматов для UX-валидации, а серверный код —
 * для проверки факта (defense in depth). Сам S3-клиент с ключами живёт
 * отдельно в `s3.ts` и на клиент не попадает.
 */

/**
 * Категория файла — UI-концерн (иконка + группировка форматов).
 * Строковый литерал, а не Prisma-enum `FileCategory`: чтобы файл можно было
 * импортировать в клиентский бандл без затягивания Prisma runtime.
 * Значения совпадают с enum в схеме — на сервере приводятся к нему как есть.
 */
export type FileCategoryValue = "IMAGE" | "DOCUMENT";

/** Потолок размера одного файла — 10 MB (в байтах). Дублирует S3-policy. */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Квота: максимум файлов на один список. */
export const MAX_FILES_PER_LIST = 5;

/** Квота: максимум файлов на одного пользователя. */
export const MAX_FILES_PER_USER = 20;

/**
 * Возраст, после которого зависшая PENDING-строка считается мусором (минуты).
 * Реальная two-phase-загрузка укладывается в секунды, так что 15 минут —
 * заведомо больше любого живого in-flight и активную загрузку не заденет.
 * Используется ленивой уборкой в `requestUpload` (см. actions/attachments.ts).
 */
export const STALE_MINUTES = 15;

/**
 * Белый список разрешённых MIME-типов.
 * Ключ — реальный `contentType`, значение — категория (для UI) и расширение
 * (для object key в S3). Всё, чего нет в этой таблице, отбивается на загрузке.
 */
export const ALLOWED_TYPES: Record<
  string,
  { category: FileCategoryValue; ext: string }
> = {
  "image/png": { category: "IMAGE", ext: "png" },
  "image/jpeg": { category: "IMAGE", ext: "jpg" },
  "text/plain": { category: "DOCUMENT", ext: "txt" },
  "application/pdf": { category: "DOCUMENT", ext: "pdf" },
};

/**
 * Строка для атрибута `accept` у `<input type="file">`.
 * Ограничивает выбор в системном диалоге (UX, не безопасность).
 */
export const ACCEPT_ATTRIBUTE = Object.keys(ALLOWED_TYPES).join(",");

/**
 * Разрешён ли данный MIME-тип к загрузке.
 *
 * Именно `Object.hasOwn`, а не оператор `in`: `in` видит прототипную цепочку,
 * поэтому `contentType` вида "constructor" или "toString" проходил проверку.
 * Дальше по потоку `getCategory` возвращал для такого типа null, который
 * приведением `as FileCategory` выдавался за валидную категорию.
 */
export function isAllowedType(contentType: string): boolean {
  return Object.hasOwn(ALLOWED_TYPES, contentType);
}

/** Категория файла по MIME-типу (или null, если тип не разрешён). */
export function getCategory(contentType: string): FileCategoryValue | null {
  return ALLOWED_TYPES[contentType]?.category ?? null;
}

/** Расширение файла по MIME-типу (или null, если тип не разрешён). */
export function getExtension(contentType: string): string | null {
  return ALLOWED_TYPES[contentType]?.ext ?? null;
}

/**
 * Content-Type, который S3 должен подставить в ответ на presigned GET.
 *
 * Объект хранится под голым `text/plain`: presigned POST требует ровно
 * разрешённый тип, и charset туда не попадает. Без charset браузер при
 * инлайн-просмотре угадывает кодировку по локали — для русской это
 * windows-1251, и UTF-8 кириллица превращается в «РџСЂРѕ…». Скачивание
 * отдаёт байты как есть, поэтому там дефекта нет.
 *
 * Объявляем UTF-8: это кодировка по умолчанию у современных редакторов.
 * BOM по стандарту WHATWG приоритетнее заголовка, так что UTF-16 из Блокнота
 * и UTF-8 с BOM тоже показываются верно. Инлайн искажается только у
 * однобайтовой кодировки без BOM — принятый компромисс, скачивание остаётся
 * точным. Перекодировать на загрузке нельзя: файл идёт в S3 напрямую.
 *
 * @returns заголовок для `ResponseContentType` или undefined, если хранимого
 *          типа достаточно (у бинарных форматов charset не бывает).
 */
export function getResponseContentType(
  contentType: string,
): string | undefined {
  return contentType === "text/plain"
    ? "text/plain; charset=utf-8"
    : undefined;
}

// ---------------------------------------------------------------------------
// Санитизация имени файла
// ---------------------------------------------------------------------------

/**
 * Имя, которое подставляется, если после очистки не осталось ничего видимого.
 * Расширение не добавляем: реальный тип живёт в `contentType`, а имя — ярлык.
 */
export const FALLBACK_FILE_NAME = "file";

/**
 * Символы, которые вырезаются из имени файла.
 *
 * Имя нигде не участвует в адресации (object key генерирует сервер), поэтому
 * опасность у него ровно одна — обмануть глаз человека:
 *   - `U+0000-U+001F`, `U+007F-U+009F` — управляющие. `U+0000` вдобавок
 *     невозможно записать в `text` PostgreSQL: вставка упала бы 500-й вместо
 *     понятного отказа;
 *   - `U+202A-U+202E`, `U+2066-U+2069`, `U+200E`, `U+200F`, `U+061C` — смена
 *     направления письма. Классическая подмена расширения: имя
 *     `"отчёт" + U+202E + "gnp.exe"` показывается как `отчётexe.png`;
 *   - `U+200B-U+200D`, `U+FEFF` — нулевой ширины, то есть невидимые в UI.
 *
 * Записано escape-последовательностями намеренно: литеральные символы этого
 * класса невидимы в редакторе и переживают копирование незамеченными.
 */
const UNSAFE_NAME_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Приводит присланное клиентом имя файла к безопасному для показа виду.
 *
 * Это не защита от подмены содержимого — за неё отвечает `matchesMagicBytes`.
 * Здесь закрывается только визуальный обман и мусор в UI.
 *
 * @returns очищенное имя либо `FALLBACK_FILE_NAME`, если чистить было нечего.
 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(UNSAFE_NAME_CHARS, "")
    // Схлопываем пробельные последовательности: имя из одних пробелов проходило
    // `min(1)` и рендерилось пустой строкой.
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : FALLBACK_FILE_NAME;
}

// ---------------------------------------------------------------------------
// Проверка содержимого по сигнатуре
// ---------------------------------------------------------------------------

/**
 * Сколько байт от начала объекта читает сервер для проверки сигнатуры.
 * 16 покрывает самую длинную запись `MAGIC_BYTES` (8 байт) с запасом.
 */
export const MAGIC_BYTES_PREFIX_LENGTH = 16;

/**
 * Сигнатуры начала файла по MIME-типу.
 *
 * Зачем: заявленный `Content-Type` — это ярлык, а не факт. Policy presigned
 * POST (`eq $Content-Type`) фиксирует лишь совпадение с разрешённым сервером
 * значением, а `HeadObject` возвращает ровно то, что клиент положил в форму.
 * Первые байты — единственное, что говорит о настоящем содержимом.
 *
 * `text/plain` записи не имеет намеренно: у текста нет сигнатуры, а эвристики
 * вида «нет NUL-байта» ломают легитимные UTF-16 файлы из Windows-блокнота и при
 * этом обходятся дополнением. Ненадёжный контроль хуже честно описанного
 * пробела: он создаёт ложную уверенность. Пробел зафиксирован в `THREAT_MODEL.md`.
 */
const MAGIC_BYTES: Record<string, readonly number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d], // "%PDF-"
};

/**
 * Есть ли для типа проверяемая сигнатура.
 * Позволяет не ходить в S3 за байтами там, где проверять всё равно нечего.
 *
 * `Object.hasOwn`, а не `in`: иначе `contentType` вида "constructor" достал бы
 * значение из прототипа. Тот же дефект уже был у `isAllowedType`.
 */
export function hasMagicBytes(contentType: string): boolean {
  return Object.hasOwn(MAGIC_BYTES, contentType);
}

/**
 * Совпадает ли начало файла с сигнатурой заявленного типа.
 *
 * @param contentType тип, под которым файл сохранён в S3.
 * @param prefix      первые байты объекта (см. `MAGIC_BYTES_PREFIX_LENGTH`).
 * @returns true, если сигнатура совпала или для типа её не существует.
 */
export function matchesMagicBytes(
  contentType: string,
  prefix: Uint8Array,
): boolean {
  if (!hasMagicBytes(contentType)) return true;
  const signature = MAGIC_BYTES[contentType];
  // Файл короче сигнатуры не может ей соответствовать.
  if (prefix.length < signature.length) return false;
  return signature.every((byte, index) => prefix[index] === byte);
}

/**
 * Человекочитаемый размер файла (для UI): 1536 → "1.5 KB".
 * Без локализации — единицы измерения интернациональны.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
