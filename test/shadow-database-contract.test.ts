/**
 * @file shadow-database-contract.test.ts
 * @description Контракт адреса shadow-базы Prisma.
 *
 * Зачем отдельный тест: `prisma migrate dev` стирает базу, указанную в
 * `SHADOW_DATABASE_URL`, перед каждым использованием. Ошибка в этом значении
 * не выглядит ошибкой — команда отрабатывает успешно, просто очищает не ту
 * базу. Единственный момент, когда это можно поймать, — до передачи адреса
 * Prisma, поэтому guard живёт в `prisma.config.ts`, а здесь закрепляются его
 * границы.
 */

import { describe, expect, it } from "vitest";

import { resolveShadowDatabaseUrl } from "../prisma.config";

const LOCAL = "postgresql://postgres:postgres@localhost:5433/smartlists_shadow";
// Хост намеренно вымышленный: настоящий адрес боевой или dev-базы в публичном
// репозитории — бесплатная подсказка для разведки, см. A79. Тесту он ничего не
// добавляет, важно лишь то, что адрес не петлевой.
const REMOTE = "postgresql://user:pass@db.example.invalid/neondb";

describe("адрес shadow-базы", () => {
  it("пропускает локальный адрес", () => {
    expect(resolveShadowDatabaseUrl(LOCAL, REMOTE)).toBe(LOCAL);
  });

  it.each(["127.0.0.1", "localhost", "[::1]"])(
    "принимает петлевой хост %s",
    (host) => {
      const url = `postgresql://postgres:postgres@${host}:5433/smartlists_shadow`;
      expect(resolveShadowDatabaseUrl(url, REMOTE)).toBe(url);
    },
  );

  it("отсутствующее значение оставляет поведение Prisma по умолчанию", () => {
    expect(resolveShadowDatabaseUrl(undefined, REMOTE)).toBeUndefined();
    expect(resolveShadowDatabaseUrl("", REMOTE)).toBeUndefined();
  });

  it("отвергает удалённый хост: его база была бы стёрта", () => {
    expect(() => resolveShadowDatabaseUrl(REMOTE, "")).toThrow(
      /локальную базу/,
    );
  });

  it("отвергает совпадение с рабочим адресом", () => {
    expect(() => resolveShadowDatabaseUrl(LOCAL, LOCAL)).toThrow(
      /совпадает с рабочим/,
    );
  });

  it("отвергает значение, которое не является URL", () => {
    expect(() => resolveShadowDatabaseUrl("smartlists_shadow", REMOTE)).toThrow(
      /корректным URL/,
    );
  });
});
