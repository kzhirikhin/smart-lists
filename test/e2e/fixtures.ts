/**
 * @file fixtures.ts
 * @description Базовые фикстуры E2E: подключение к базе и подстановка сессии.
 *
 * Вход через Google в тестах не выполняется: OAuth уводит на внешний домен,
 * ломается при смене верстки провайдера и требует реальных секретов. Вместо
 * этого тест создаёт строку `Session` (её же создаёт Prisma Adapter при
 * настоящем входе) и кладёт токен в cookie. Приложение не отличает такую
 * сессию от полученной по OAuth — `auth()` читает ровно эту строку.
 *
 * Экспортируется два `test`:
 *   - `test` — авторизованный: фикстура `user` создаёт пользователя, а сессия
 *     подставляется в контекст до первой навигации;
 *   - `anonymousTest` — без сессии, для экрана входа и гостевого режима.
 */

import { randomUUID } from "node:crypto";
import { test as base, type BrowserContext } from "@playwright/test";

import type { PrismaClient } from "@/generated/prisma/client";
import { createPrismaClient } from "@/lib/prisma-client";

import { E2E_BASE_URL, E2E_DATABASE_URL, SESSION_COOKIE } from "./env";
import { makeUser, type E2EUser } from "./factories";
import { scenarioFor } from "../zap/manifest";
import { instrumentContexts } from "../zap/context";

type WorkerFixtures = {
  /** Prisma-клиент против базы E2E. Один на воркер, а не на тест. */
  db: PrismaClient;
};

type TestFixtures = {
  /** Пользователь этого теста: у каждого свой, поэтому тесты не мешают друг другу. */
  user: E2EUser;
};

type PilotFixtures = {
  zapPilot: void;
};

/** Прогон без сессии: экран входа, гостевой режим, редиректы неавторизованного. */
export const anonymousTest = base.extend<PilotFixtures, WorkerFixtures>({
  zapPilot: [async ({ browser }, use, testInfo) => {
    if (process.env.ZAP_PILOT !== "1") return use();
    const scenario = scenarioFor(testInfo.file, testInfo.title);
    if (!scenario) throw new Error("Сценарий отсутствует в manifest ZAP");
    const restore = instrumentContexts(browser, scenario.id, process.env.ZAP_PILOT_PROBE === "session");
    try { await use(); } finally { restore(); }
  }, { auto: true }],
  db: [
    // Playwright требует именно деструктуризацию в первом аргументе: по её
    // ключам он определяет зависимости фикстуры. Здесь зависимостей нет.
    async ({}, use) => {
      const db = createPrismaClient(E2E_DATABASE_URL);
      await use(db);
      await db.$disconnect();
    },
    { scope: "worker" },
  ],
});

/**
 * Кладёт в контекст валидную сессию пользователя.
 *
 * Отдельная функция, а не только фикстура: тестам совместного доступа нужен
 * второй контекст со вторым пользователем в том же прогоне.
 */
export async function signInAs(
  context: BrowserContext,
  db: PrismaClient,
  user: E2EUser,
): Promise<void> {
  const sessionToken = randomUUID();
  await db.session.create({
    data: {
      sessionToken,
      userId: user.id,
      expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: sessionToken,
      url: E2E_BASE_URL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

/** Прогон под авторизованным пользователем. */
export const test = anonymousTest.extend<TestFixtures>({
  user: async ({ db }, use) => {
    await use(await makeUser(db));
  },

  // Переопределяем context, а не page: cookie должна лежать в контексте до
  // того, как page сделает первый запрос.
  context: async ({ context, db, user }, use) => {
    await signInAs(context, db, user);
    await use(context);
  },
});

export { expect } from "@playwright/test";
