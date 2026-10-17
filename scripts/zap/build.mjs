import { spawnSync } from "node:child_process";
import { appEnv } from "../../test/e2e/env.ts";

// Сборка выполняется до отключения внешней сети; env только тестовые, .env
// и локальные credentials не попадают в build context.
const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
  env: { ...process.env, ...appEnv, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "inherit",
});
process.exit(result.status ?? 1);
