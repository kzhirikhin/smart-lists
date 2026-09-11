/**
 * @file s3-credentials.test.ts
 * @description Границы выбора учётных данных S3.
 *
 * Проверяется не «работает ли федерация» — это доказывается только деплоем, —
 * а решения, которые нельзя увидеть по логам: что роль выигрывает у ключей и
 * что кривой ARN валит запуск вместо тихого отката на долгоживущий ключ.
 */

import { describe, expect, it } from "vitest";

import { resolveS3Credentials } from "./s3-credentials";

const KEYS = {
  S3_ACCESS_KEY_ID: "AKIAEXAMPLEEXAMPLE12",
  S3_SECRET_ACCESS_KEY: "secret-value",
};

const ROLE = "arn:aws:iam::123456789012:role/smart-lists-vercel-production";

describe("выбор учётных данных S3", () => {
  it("без роли отдаёт статические ключи", () => {
    const credentials = resolveS3Credentials({ ...KEYS });
    expect(credentials).toEqual({
      accessKeyId: KEYS.S3_ACCESS_KEY_ID,
      secretAccessKey: KEYS.S3_SECRET_ACCESS_KEY,
    });
  });

  it("отсутствующие ключи не роняют импорт: клиент создаётся, запросы упадут", () => {
    expect(resolveS3Credentials({})).toEqual({
      accessKeyId: "",
      secretAccessKey: "",
    });
  });

  it("с ролью отдаёт провайдер, а не пару ключей", () => {
    const credentials = resolveS3Credentials({ S3_ROLE_ARN: ROLE });
    expect(typeof credentials).toBe("function");
  });

  it("роль выигрывает у ключей, заданных одновременно", () => {
    // Это и есть механизм выката: обе конфигурации сосуществуют, а деплой
    // проверяет именно федерацию. Обратный приоритет означал бы, что испытать
    // её можно только удалив ключи, то есть лишившись отката.
    const credentials = resolveS3Credentials({ ...KEYS, S3_ROLE_ARN: ROLE });
    expect(typeof credentials).toBe("function");
  });

  it.each([
    ["мусор", "not-an-arn"],
    ["ARN пользователя, а не роли", "arn:aws:iam::123456789012:user/K"],
    ["ARN без аккаунта", "arn:aws:iam:::role/some-role"],
    ["короткий номер аккаунта", "arn:aws:iam::12345:role/some-role"],
    ["пробел вместо значения", "   "],
  ])("отвергает %s", (_label, value) => {
    expect(() => resolveS3Credentials({ S3_ROLE_ARN: value })).toThrow(
      /S3_ROLE_ARN/,
    );
  });

  it("не подменяет отказ тихим возвратом к ключам", () => {
    // Худший исход опечатки — работающее приложение, про которое считают, что
    // оно уже ушло с долгоживущих ключей.
    expect(() =>
      resolveS3Credentials({ ...KEYS, S3_ROLE_ARN: "arn:aws:iam::x:role/y" }),
    ).toThrow();
  });
});
