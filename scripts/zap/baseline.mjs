import { readFile, writeFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { reportSchema } from "../../test/zap/report.ts";

// Только явное локальное принятие уже очищенного completed-отчёта. CI не
// получает доверенную историю из произвольного PR-артефакта этим способом.
const root = fileURLToPath(new URL("../../", import.meta.url));
const argument = process.argv[2];
try {
  if (!argument || process.argv.length !== 3) throw new Error();
  const input = await realpath(path.resolve(root, argument));
  const allowed = await realpath(path.join(root, "test-results", "zap-pilot"));
  if (!input.startsWith(allowed + path.sep) || path.basename(input) !== "report.json" || (await stat(input)).size > 16_000_000) throw new Error();
  const report = reportSchema.parse(JSON.parse(await readFile(input, "utf8")));
  if (report.run.status !== "completed") throw new Error();
  await writeFile(path.join(root, "config/zap/baseline.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log("Локальная точка сравнения обновлена. Проверьте diff перед commit.");
} catch {
  console.error("Точка сравнения не изменена: нужен валидный completed report.json из test-results/zap-pilot.");
  process.exitCode = 2;
}
