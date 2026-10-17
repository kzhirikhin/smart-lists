import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { scenarios } from "./test/zap/manifest";

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Только контейнер пилота: обычный E2E-конфиг не меняется. */
export default defineConfig({
  ...base,
  testDir: "./test",
  testMatch: [...new Set(scenarios.map((scenario) => `**/${scenario.file}`))],
  grep: new RegExp(`(?:${scenarios.map((scenario) => escape(scenario.title)).join("|")})$`),
  workers: 1,
  retries: 0,
  timeout: 30_000,
  globalTimeout: 540_000,
  outputDir: "/tmp/zap-playwright",
  reporter: [["./test/zap/reporter.ts"]],
  use: {
    ...base.use,
    trace: "off",
    screenshot: "off",
    video: "off",
    serviceWorkers: "block",
    launchOptions: {
      proxy: { server: process.env.ZAP_PILOT_PROBE === "proxy" ? "http://127.0.0.1:1" : "http://127.0.0.1:8090" },
      args: ["--proxy-bypass-list=<-loopback>"],
    },
  },
  webServer: {
    ...base.webServer,
    command: "node node_modules/next/dist/bin/next start -p 3100",
    reuseExistingServer: false,
  },
});
