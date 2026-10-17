import { writeFileSync } from "node:fs";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { scenarioFor } from "./manifest";

/** Ни сообщения ошибок, ни вложения Playwright не попадают в отчёт пилота. */
export default class PilotReporter implements Reporter {
  private results: { id: string; status: string; durationMs: number }[] = [];
  onTestEnd(test: TestCase, result: TestResult) {
    this.results.push({
      id: scenarioFor(test.location.file, test.title)?.id ?? "unmapped",
      status: result.status,
      durationMs: result.duration,
    });
    writeFileSync("/tmp/zap-tests.json", JSON.stringify(this.results));
  }
  onEnd() {
    writeFileSync("/tmp/zap-tests.json", JSON.stringify(this.results));
  }
}
