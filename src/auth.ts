/**
 * @file auth.ts
 * @description Конфигурация аутентификации на основе библиотеки Auth.js (NextAuth v5).
 *
 * Этот файл — центральное место для всей логики входа/выхода и сессий.
 * Он экспортирует четыре именованных значения, которые используются в разных частях приложения:
 *
 * - `handlers` — объект { GET, POST }, подключаемый в API-роуте `/api/auth/[...nextauth]`.
 *   Обрабатывает все OAuth-колбэки и управление сессиями (cookies и т.д.).
 *
 * - `signIn(provider)` — Server Action/функция для запуска процесса входа.
 *   Принимает название провайдера: `signIn("google")`.
 *
 * - `signOut()` — Server Action/функция для выхода из системы и очистки сессии.
 *
 * - `auth()` — асинхронная функция для получения текущей сессии.
 *   Используется в Server Components и Server Actions.
 *   Возвращает `Session | null`.
 *
 * Провайдер: Google OAuth 2.0.
 * Учётные данные (CLIENT_ID, CLIENT_SECRET) берутся из окружения: локально —
 * из корневого `.env`, в Preview и Production — из переменных Vercel, причём
 * OAuth-клиент и `AUTH_SECRET` у этих двух сред разные.
 *
 * Адаптер: PrismaAdapter — автоматически создаёт/обновляет записи
 * в таблицах `User`, `Account`, `Session`, `VerificationToken` в PostgreSQL.
 */

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import prisma from "@/lib/db";
import { logger, hashId } from "@/lib/logger";
import { deniedSignInLogContext } from "@/lib/auth-errors";
import { ensureSpaceState } from "@/lib/spaces";
import { isEmailAllowed, revokeUserSessions } from "@/lib/allowed-email";

export const { handlers, signIn, signOut, auth } = NextAuth({
  /**
   * Связываем Auth.js с базой данных через Prisma.
   * Адаптер автоматически управляет сессиями и пользователями в БД —
   * не нужно писать SQL-запросы вручную.
   */
  adapter: PrismaAdapter(prisma),

  /**
   * Список провайдеров (способов входа).
   * Здесь используется только Google OAuth.
   * Можно добавить GitHub, Discord, email-ссылку и т.д.
   */
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],

  pages: {
    error: "/auth-error",
  },

  events: {
    async createUser({ user }) {
      if (!user.id) return;
      await ensureSpaceState(user.id);
      logger.info({ uid: hashId(user.id), action: "space.default.created" }, "Создано основное пространство");
    },
    signOut(event) {
      if ("session" in event && event.session?.userId) {
        logger.info({ uid: hashId(event.session.userId), action: "signOut" }, "Выход из системы");
      }
    },
  },

  callbacks: {
    /**
     * Проверяет, разрешён ли вход для данного пользователя.
     * Email должен присутствовать в таблице `AllowedEmail`.
     * Управление списком — напрямую в БД, без деплоя.
     */
    async signIn({ user }) {
      const email = user.email ?? "";
      if (!(await isEmailAllowed(email))) {
        logger.warn(
          deniedSignInLogContext(email),
          "Попытка входа с неразрешённого email",
        );
        return false;
      }
      logger.info({ action: "signIn", uid: hashId(user.id ?? "") }, "Успешный вход");
      return true;
    },

    /**
     * Коллбэк `session` вызывается каждый раз при чтении сессии
     * (например, при вызове `auth()` или `useSession()`).
     *
     * Делает две вещи.
     *
     * Первая — переносит `user.id` из БД в объект сессии: по умолчанию
     * `session.user` содержит только name, email и image, а Server Actions
     * сравнивают именно id (`session.user.id === list.ownerId`).
     *
     * Вторая — сверяет пользователя с whitelist. Проверки в `signIn` мало:
     * она срабатывает один раз при входе, и удаление из `AllowedEmail` не
     * влияло на уже выданную сессию. Здесь же находится единственное место,
     * через которое проходят все три десятка вызовов `auth()`, — поэтому
     * проверка стоит тут, а не в каждом Action.
     *
     * Сессия без `user` означает для приложения то же, что её отсутствие: все
     * защиты написаны как `if (!session?.user?.id)`.
     *
     * @param session - Текущий объект сессии (без id)
     * @param user - Запись пользователя из базы данных (с id)
     * @returns Сессия с id либо сессия без пользователя, если доступ отозван
     */
    async session({ session, user }) {
      if (!(await isEmailAllowed(user.email))) {
        const revoked = await revokeUserSessions(user.id);
        logger.warn(
          { uid: hashId(user.id), action: "session.revoked", revoked },
          "Сессия отозвана: email отсутствует в whitelist",
        );
        return { ...session, user: undefined };
      }

      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
});
