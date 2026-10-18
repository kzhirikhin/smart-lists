import { defineConfig } from "@playwright/test";
import base from "./playwright.zap.config";

/** Фаза A уже создала схему и проверила сценарии. Повторный globalSetup
 * очистил бы её данные; для фазы B создаются отдельные пользователи. */
export default defineConfig({
  ...base, testMatch: ["**/zap/active.e2e.ts"], grep: /.*/,
  globalSetup: undefined, timeout: 32 * 60_000, globalTimeout: 34 * 60_000,
  use: { ...base.use, actionTimeout: 10_000, navigationTimeout: 20_000 },
  reporter: [["list"]], outputDir: "/tmp/zap-active-playwright",
});
