/**
 * @file attachments.test.ts
 * @description Тесты белого списка типов и форматирования размера.
 *
 * Белый список — ранний отсев на входе загрузки. Значения категорий должны
 * совпадать с Prisma-enum `FileCategory`, а расширения попадают в object key
 * S3, поэтому таблица зафиксирована тестом целиком.
 */

import { describe, expect, it } from "vitest";

import {
  ACCEPT_ATTRIBUTE,
  ALLOWED_TYPES,
  FALLBACK_FILE_NAME,
  formatFileSize,
  getCategory,
  getExtension,
  getResponseContentType,
  hasMagicBytes,
  isAllowedType,
  matchesMagicBytes,
  MAX_FILE_SIZE,
  sanitizeFileName,
} from "@/lib/attachments";

describe("белый список типов", () => {
  it("содержит ровно четыре согласованных формата", () => {
    expect(Object.keys(ALLOWED_TYPES).sort()).toEqual([
      "application/pdf",
      "image/jpeg",
      "image/png",
      "text/plain",
    ]);
  });

  it("использует только категории, существующие в Prisma-enum", () => {
    for (const { category } of Object.values(ALLOWED_TYPES)) {
      expect(["IMAGE", "DOCUMENT"]).toContain(category);
    }
  });

  it("перечисляет все разрешённые типы в accept-атрибуте", () => {
    for (const type of Object.keys(ALLOWED_TYPES)) {
      expect(ACCEPT_ATTRIBUTE).toContain(type);
    }
  });
});

describe("isAllowedType", () => {
  it("пропускает разрешённый тип", () => {
    expect(isAllowedType("image/png")).toBe(true);
  });

  it("отбивает неразрешённый тип", () => {
    expect(isAllowedType("application/zip")).toBe(false);
  });

  it("отбивает пустую строку", () => {
    expect(isAllowedType("")).toBe(false);
  });

  it("не пропускает унаследованные от Object свойства", () => {
    // `contentType in ALLOWED_TYPES` видит прототипную цепочку, поэтому
    // "constructor" и "toString" — реальные кандидаты на ложное срабатывание.
    expect(isAllowedType("constructor")).toBe(false);
    expect(isAllowedType("toString")).toBe(false);
  });
});

describe("getCategory и getExtension", () => {
  it("определяют категорию изображения", () => {
    expect(getCategory("image/png")).toBe("IMAGE");
    expect(getCategory("image/jpeg")).toBe("IMAGE");
  });

  it("определяют категорию документа", () => {
    expect(getCategory("text/plain")).toBe("DOCUMENT");
    expect(getCategory("application/pdf")).toBe("DOCUMENT");
  });

  it("возвращают расширение для object key", () => {
    expect(getExtension("image/jpeg")).toBe("jpg");
    expect(getExtension("application/pdf")).toBe("pdf");
  });

  it("возвращают null для неразрешённого типа", () => {
    expect(getCategory("application/zip")).toBeNull();
    expect(getExtension("application/zip")).toBeNull();
  });

  it("возвращают null для унаследованных свойств, а не функцию прототипа", () => {
    expect(getCategory("toString")).toBeNull();
    expect(getExtension("toString")).toBeNull();
  });
});

describe("getResponseContentType", () => {
  it("объявляет UTF-8 для текста, иначе браузер угадывает кодировку по локали", () => {
    expect(getResponseContentType("text/plain")).toBe(
      "text/plain; charset=utf-8",
    );
  });

  it("не трогает бинарные форматы: у них charset не бывает", () => {
    expect(getResponseContentType("image/png")).toBeUndefined();
    expect(getResponseContentType("image/jpeg")).toBeUndefined();
    expect(getResponseContentType("application/pdf")).toBeUndefined();
  });
});

describe("sanitizeFileName", () => {
  it("оставляет обычное имя нетронутым", () => {
    expect(sanitizeFileName("Отчёт за июль.pdf")).toBe("Отчёт за июль.pdf");
  });

  it("вырезает bidi-подмену расширения", () => {
    // Классический трюк: RIGHT-TO-LEFT OVERRIDE разворачивает хвост имени,
    // и "gnp.exe" показывается пользователю как "exe.png".
    expect(sanitizeFileName("отчёт\u202Egnp.exe")).toBe("отчётgnp.exe");
  });

  it("вырезает изоляты направления и невидимые символы", () => {
    expect(sanitizeFileName("a\u2066b\u2069c\u200Bd\uFEFFe.txt")).toBe(
      "abcde.txt",
    );
  });

  it("вырезает управляющие символы, включая NUL и перевод строки", () => {
    // NUL невозможно записать в text PostgreSQL — без очистки вставка падала.
    // CR и LF — тоже C0, поэтому удаляются, а не схлопываются в пробел:
    // подставлять разделитель там, где его не было, незачем.
    expect(sanitizeFileName("a\u0000bc.txt")).toBe("abc.txt");
    expect(sanitizeFileName("a\r\nb.txt")).toBe("ab.txt");
  });

  it("схлопывает пробелы и обрезает края", () => {
    expect(sanitizeFileName("  файл    копия.png  ")).toBe("файл копия.png");
  });

  it("подставляет запасное имя, когда чистить было нечего", () => {
    // Строка из одних управляющих символов проходила min(1) и рендерилась пустой.
    expect(sanitizeFileName("\u202E\u200B")).toBe(FALLBACK_FILE_NAME);
    expect(sanitizeFileName("   ")).toBe(FALLBACK_FILE_NAME);
  });
});

describe("проверка сигнатуры содержимого", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  /** Начало PE-заголовка Windows — то, что пытаются выдать за картинку. */
  const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

  it("знает сигнатуры трёх бинарных форматов", () => {
    expect(hasMagicBytes("image/png")).toBe(true);
    expect(hasMagicBytes("image/jpeg")).toBe(true);
    expect(hasMagicBytes("application/pdf")).toBe(true);
  });

  it("не знает сигнатуры для text/plain — у текста её нет", () => {
    expect(hasMagicBytes("text/plain")).toBe(false);
  });

  it("не достаёт сигнатуру из прототипа Object", () => {
    expect(hasMagicBytes("constructor")).toBe(false);
    expect(hasMagicBytes("toString")).toBe(false);
  });

  it("принимает совпавшие сигнатуры", () => {
    expect(matchesMagicBytes("image/png", PNG)).toBe(true);
    expect(matchesMagicBytes("image/jpeg", JPEG)).toBe(true);
    expect(matchesMagicBytes("application/pdf", PDF)).toBe(true);
  });

  it("отбивает исполняемый файл, выданный за изображение", () => {
    expect(matchesMagicBytes("image/png", EXE)).toBe(false);
    expect(matchesMagicBytes("image/jpeg", EXE)).toBe(false);
    expect(matchesMagicBytes("application/pdf", EXE)).toBe(false);
  });

  it("отбивает подмену одного разрешённого формата другим", () => {
    expect(matchesMagicBytes("image/png", JPEG)).toBe(false);
    expect(matchesMagicBytes("application/pdf", PNG)).toBe(false);
  });

  it("отбивает файл короче сигнатуры", () => {
    expect(matchesMagicBytes("image/png", PNG.slice(0, 4))).toBe(false);
  });

  it("пропускает тип без сигнатуры, что бы ни лежало в байтах", () => {
    // Осознанный пробел: у text/plain сигнатуры нет, проверять нечем.
    expect(matchesMagicBytes("text/plain", EXE)).toBe(true);
  });
});

describe("formatFileSize", () => {
  it("показывает байты без дробной части", () => {
    expect(formatFileSize(512)).toBe("512 B");
  });

  it("переключается на килобайты на границе", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
  });

  it("округляет килобайты до одного знака", () => {
    expect(formatFileSize(1536)).toBe("1.5 KB");
  });

  it("переключается на мегабайты на границе", () => {
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
  });

  it("показывает предельный размер файла", () => {
    expect(formatFileSize(MAX_FILE_SIZE)).toBe("10.0 MB");
  });

  it("не падает на нуле", () => {
    expect(formatFileSize(0)).toBe("0 B");
  });
});
