/**
 * @file messages.test.ts
 * @description Проверка согласованности файлов перевода.
 *
 * Правило проекта — новый пользовательский текст получает ключ сразу во всех
 * поддерживаемых локалях. Забытый ключ не ломает ни сборку, ни типы: next-intl
 * обнаружит пропажу только в рантайме и только на той локали, которую никто
 * не открыл при проверке. Здесь это ловится статически.
 *
 * `ru` взят эталоном как язык оригинала: с него делаются остальные переводы.
 *
 * Набор локалей берётся из `routing.locales` и сверяется с каталогом
 * `messages/`, а не перечисляется здесь списком. Перечень, который ведётся
 * руками, остаётся зелёным для всякой локали, в него не попавшей: пятый язык
 * молча выпал бы из всех проверок этого файла, включая обязательное
 * уведомление о передаче данных.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { routing } from "@/i18n/routing";

type MessageTree = { [key: string]: string | MessageTree };

const MESSAGES_DIR = fileURLToPath(new URL("../messages", import.meta.url));

const localeNames: string[] = [...routing.locales];
const locales: Record<string, MessageTree> = Object.fromEntries(
  localeNames.map((locale) => [
    locale,
    JSON.parse(
      readFileSync(path.join(MESSAGES_DIR, `${locale}.json`), "utf8"),
    ) as MessageTree,
  ]),
);
const REFERENCE = "ru";
const translations = localeNames.filter((l) => l !== REFERENCE);

/** Разворачивает вложенный объект в плоский список путей вида "a.b.c". */
function flatten(tree: MessageTree, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();

  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      result.set(path, value);
    } else {
      for (const [nested, nestedValue] of flatten(value, path)) {
        result.set(nested, nestedValue);
      }
    }
  }

  return result;
}

/**
 * Имена ICU-аргументов верхнего уровня: "Привет, {name}" → ["name"].
 *
 * Учитывается вложенность, иначе ветки плюрализации попадают в результат как
 * аргументы: в "{count, plural, one {список} other {списков}}" фигурные скобки
 * есть у веток, но аргумент здесь один.
 */
function placeholders(message: string): string[] {
  const names = new Set<string>();
  let depth = 0;

  for (let i = 0; i < message.length; i++) {
    if (message[i] === "{") {
      if (depth === 0) {
        const match = /^\{\s*(\w+)/.exec(message.slice(i));
        if (match) names.add(match[1]);
      }
      depth++;
    } else if (message[i] === "}") {
      depth--;
    }
  }

  return [...names].sort();
}

/** Сбалансированы ли фигурные скобки — незакрытая ломает разбор сообщения. */
function isBalanced(message: string): boolean {
  let depth = 0;

  for (const char of message) {
    if (char === "{") depth++;
    else if (char === "}") depth--;
    if (depth < 0) return false;
  }

  return depth === 0;
}

const flat = Object.fromEntries(
  Object.entries(locales).map(([locale, tree]) => [locale, flatten(tree)]),
) as Record<string, Map<string, string>>;

describe("источник набора локалей", () => {
  // Без этих двух проверок обход по `routing.locales` может стать пустым или
  // неполным и тогда все остальные тесты файла пройдут, ничего не проверив.
  it("эталон и хотя бы один перевод присутствуют", () => {
    expect(localeNames).toContain(REFERENCE);
    expect(translations.length).toBeGreaterThan(0);
  });

  it("каталог messages совпадает с routing.locales", () => {
    const files = readdirSync(MESSAGES_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.basename(name, ".json"))
      .sort();

    expect(files).toEqual([...localeNames].sort());
  });
});

describe("наборы ключей", () => {
  it.each(translations)("в %s нет ключей, отсутствующих в ru", (locale) => {
    const extra = [...flat[locale].keys()].filter((key) => !flat[REFERENCE].has(key));

    expect(extra).toEqual([]);
  });

  it.each(translations)("в %s есть все ключи из ru", (locale) => {
    const missing = [...flat[REFERENCE].keys()].filter((key) => !flat[locale].has(key));

    expect(missing).toEqual([]);
  });
});

describe("значения", () => {
  it.each(localeNames)("в %s нет пустых строк", (locale) => {
    const empty = [...flat[locale].entries()]
      .filter(([, value]) => value.trim() === "")
      .map(([key]) => key);

    expect(empty).toEqual([]);
  });

  it.each(translations)("в %s нет плейсхолдеров, которых нет в ru", (locale) => {
    // Односторонняя проверка. Лишний аргумент — гарантированная ошибка в
    // рантайме: значения для него никто не передаёт. Обратное допустимо:
    // во вьетнамском и японском нет числовых форм, поэтому {count} там
    // осознанно не используется.
    const unknown: string[] = [];

    for (const [key, translated] of flat[locale]) {
      const reference = flat[REFERENCE].get(key);
      if (reference === undefined) continue;

      const allowed = placeholders(reference);
      const extra = placeholders(translated).filter((name) => !allowed.includes(name));
      if (extra.length > 0) {
        unknown.push(`${key}: ${locale} использует {${extra}}, в ru их нет`);
      }
    }

    expect(unknown).toEqual([]);
  });

  it.each(localeNames)("в %s сбалансированы фигурные скобки", (locale) => {
    const broken = [...flat[locale].entries()]
      .filter(([, value]) => !isBalanced(value))
      .map(([key]) => key);

    expect(broken).toEqual([]);
  });
});

describe("структура", () => {
  it.each(translations)("в %s ключ остаётся строкой там же, где в ru", (locale) => {
    // Расхождение вида «в ru строка, в переводе вложенный объект» даёт
    // одинаковый набор путей, но ломает обращение к ключу в рантайме.
    const conflicts = [...flat[REFERENCE].keys()].filter((key) => {
      const value = flat[locale].get(key);
      return value !== undefined && typeof value !== "string";
    });

    expect(conflicts).toEqual([]);
  });

  it("эталонная локаль не пуста", () => {
    expect(flat[REFERENCE].size).toBeGreaterThan(0);
  });
});

/** Уведомление обязано называть фактического получателя пользовательских данных. */
describe("уведомление AI о передаче данных", () => {
  it.each(localeNames)("в %s указан Vertex AI, а не прежний провайдер", (locale) => {
    const notice = flat[locale].get("AiInsight.privacyNotice");
    expect(notice).toContain("Vertex AI");
    expect(notice).not.toContain("Anthropic");
  });
});
