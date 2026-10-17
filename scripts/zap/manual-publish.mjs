import { readFile, writeFile, appendFile, rm, stat, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "test-results", "zap-manual-ci");
const phases = ["phase-a", "phase-b-active", "phase-b-passive"];
const read = async name => {
  const file = path.join(output, name);
  if ((await stat(file)).size > 16_000_000) throw new Error();
  return JSON.parse(await readFile(file, "utf8"));
};
await mkdir(output, { recursive: true });
let summary;
try {
  const { renderManual } = await import("../../test/zap/manual-report.ts");
  const { renderReport, reportSchema } = await import("../../test/zap/report.ts");
  const run = await read("run.json");
  const rendered = renderManual(run);
  for (const phase of phases) {
    let report;
    try { report = reportSchema.parse(await read(`${phase}.json`)); }
    catch { if (run.status === "completed") throw new Error(); }
    if (report) {
      if ((run.status === "completed" && report.run.status !== "completed") ||
        (run.revision && run.revision !== "unknown" && report.run.revision !== run.revision)) throw new Error();
      const files = renderReport(report);
      await writeFile(path.join(output, `${phase}.json`), files.json);
      await writeFile(path.join(output, `${phase}.html`), files.html);
    } else for (const ext of ["json", "html"]) await rm(path.join(output, `${phase}.${ext}`), { force: true });
  }
  await writeFile(path.join(output, "run.json"), rendered.json);
  await writeFile(path.join(output, "report.html"), rendered.html);
  summary = rendered.summary;
} catch {
  // Никакого exception/stdout/сырых файлов в summary даже без npm dependencies.
  for (const file of ["report.html", ...phases.flatMap(phase => [`${phase}.json`, `${phase}.html`])]) await rm(path.join(output, file), { force: true });
  await writeFile(path.join(output, "run.json"), '{"status":"error","reportsAvailable":false}\n');
  summary = "# Ручной ZAP\n\nСтатус: **error**. Детальный отчёт недоступен.\n";
}
await writeFile(path.join(output, "summary.md"), summary);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
