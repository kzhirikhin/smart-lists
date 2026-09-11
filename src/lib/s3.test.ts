/**
 * @file s3.test.ts
 * @description Контракт готовности S3-конфигурации.
 *
 * Зачем: `isS3Configured()` — единственное, что отделяет «вложения выключены»
 * от «вложения падают». Интеграционные тесты её мокают, поэтому настоящая
 * логика не проверялась нигде, а в ней с переходом на федерацию появилась
 * развилка: годится либо роль, либо пара ключей.
 *
 * Цена ошибки несимметрична. Лишнее требование выключило бы вложения на
 * рабочей конфигурации — сейчас это ровно тот случай, когда локально нет ни
 * роли, ни ключей и выключение правильно. Недостающее — пропустило бы запрос
 * к S3 без учётных данных, то есть отказ в момент загрузки файла вместо
 * честного «не настроено».
 *
 * Модуль создаёт клиента на импорте, поэтому каждый случай проверяется свежим
 * импортом с подготовленным окружением.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE = {
  S3_BUCKET_NAME: "smart-lists-attachments-dev",
  S3_REGION: "ap-northeast-1",
};

const KEYS = {
  S3_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE12",
  S3_SECRET_ACCESS_KEY: "secret-value",
};

const ROLE = "arn:aws:iam::123456789012:role/smart-lists-vercel-preview";

const savedEnv = { ...process.env };

/** Подменяет окружение целиком: остатки прошлого случая исказили бы вывод. */
async function loadWith(env: Record<string, string>) {
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("S3_")) delete process.env[key];
  }
  Object.assign(process.env, env);
  return import("./s3");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("готовность конфигурации S3", () => {
  it("статические ключи вместе с бакетом и регионом — настроено", async () => {
    const { isS3Configured } = await loadWith({ ...BASE, ...KEYS });
    expect(isS3Configured()).toBe(true);
  });

  it("роль вместо ключей — тоже настроено", async () => {
    // Главная регрессия перехода на федерацию: требование ключей выключило бы
    // вложения в обеих средах Vercel, где ключей больше не существует.
    const { isS3Configured } = await loadWith({ ...BASE, S3_ROLE_ARN: ROLE });
    expect(isS3Configured()).toBe(true);
  });

  it("ни роли, ни ключей — не настроено, и это состояние локальной среды", async () => {
    const { isS3Configured } = await loadWith({ ...BASE });
    expect(isS3Configured()).toBe(false);
  });

  it("без имени бакета — не настроено даже при живых ключах", async () => {
    const { isS3Configured } = await loadWith({
      S3_REGION: BASE.S3_REGION,
      ...KEYS,
    });
    expect(isS3Configured()).toBe(false);
  });

  it("без региона падает импорт: до проверки конфигурации дело не доходит", async () => {
    // AWS SDK требует регион при создании клиента, а клиент создаётся на
    // импорте модуля. Следствие, которое стоит знать: ветка `!REGION` внутри
    // `isS3Configured` сегодня недостижима — модуль не загрузится раньше.
    // Убирать её не за чем, она станет рабочей, если клиент когда-нибудь
    // начнут создавать лениво, но полагаться на неё как на действующий
    // контроль нельзя.
    await expect(
      loadWith({ S3_BUCKET_NAME: BASE.S3_BUCKET_NAME, ...KEYS }),
    ).rejects.toThrow(/Region is missing/);
  });

  it("неверный ARN роняет сам импорт модуля, а не первый запрос", async () => {
    // Проверяется не чистая функция (у неё свой тест), а то, что отказ
    // действительно подключён: клиент создаётся на импорте, поэтому опечатка
    // в ARN обязана остановить запуск, а не всплыть при загрузке файла.
    await expect(
      loadWith({ ...BASE, ...KEYS, S3_ROLE_ARN: "arn:aws:iam::x:role/y" }),
    ).rejects.toThrow(/S3_ROLE_ARN/);
  });
});
