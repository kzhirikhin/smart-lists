import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { scenarios } from "./manifest";

it("manifest однозначен и ссылается на существующие сценарии, без обещания полноты", () => {
  expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length);
  expect(new Set(scenarios.map((scenario) => `${scenario.file}:${scenario.title}`)).size).toBe(scenarios.length);
  for (const scenario of scenarios) {
    const source = readFileSync(new URL(`../${scenario.file}`, import.meta.url), "utf8");
    if (scenario.file !== "zap/locales.e2e.ts") expect(source).toContain(JSON.stringify(scenario.title));
    else expect(source).toContain('for (const locale of ["en", "ru", "vi", "ja"])');
  }
});
