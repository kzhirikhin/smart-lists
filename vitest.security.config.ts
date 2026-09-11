/**
 * @file vitest.security.config.ts
 * @description Быстрые security-контракты без PostgreSQL и внешних сервисов.
 *
 * Набор намеренно пересекается с обычными unit-тестами. На первом этапе это
 * отдельный наблюдаемый gate, а не оптимизация времени CI: полный npm test
 * остаётся неизменным, пока независимый security-прогон не докажет стабильность.
 */

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStub = fileURLToPath(
  new URL("./test/stubs/server-only.ts", import.meta.url),
);

export const staticSecuritySuites = [
  { path: "src/components/lists/SafeMarkdown.test.ts", controls: ["A3"] },
  { path: "src/lib/attachments.test.ts", controls: ["A1", "A40", "A41"] },
  { path: "src/lib/auth-errors.test.ts", controls: ["privacy-logs"] },
  { path: "src/lib/insights-service-url.test.ts", controls: ["A68"] },
  { path: "src/lib/notify.test.ts", controls: ["realtime-boundary"] },
  { path: "src/lib/prisma-client.test.ts", controls: ["transport-tls"] },
  { path: "src/lib/pusher-auth.test.ts", controls: ["realtime-auth"] },
  { path: "src/lib/s3-credentials.test.ts", controls: ["A80"] },
  { path: "src/lib/s3.test.ts", controls: ["A80", "attachments-availability"] },
  { path: "src/lib/spaces.test.ts", controls: ["tenant-scope"] },
  { path: "src/lib/uuid.test.ts", controls: ["privacy-logs"] },
  { path: "src/lib/validations.test.ts", controls: ["input-boundary"] },
  { path: "test/action-auth-boundary.test.ts", controls: ["A74"] },
  { path: "test/audit-retention.test.ts", controls: ["A53"] },
  { path: "test/ci-container-confinement.test.ts", controls: ["A45", "A46"] },
  { path: "test/ci-docs-fast-path.test.ts", controls: ["A55"] },
  { path: "test/database-audit-workflow.test.ts", controls: ["database-audit"] },
  { path: "test/database-release-workflow.test.ts", controls: ["A13", "A31"] },
  { path: "test/dependency-install-hooks.test.ts", controls: ["A51"] },
  { path: "test/eslint-xss-guard.test.ts", controls: ["A3"] },
  { path: "test/mutation-budget-coverage.test.ts", controls: ["A29"] },
  { path: "test/next-config.test.ts", controls: ["security-headers"] },
  { path: "test/outbound-requests.test.ts", controls: ["A68", "A69"] },
  { path: "test/preview-rls-workflow.test.ts", controls: ["tenant-rls-release"] },
  { path: "test/prototype-pollution-guard.test.ts", controls: ["A75"] },
  { path: "test/preview-sync-workflow.test.ts", controls: ["A49"] },
  {
    path: "test/production-rls-workflow.test.ts",
    controls: ["tenant-rls-release"],
  },
  {
    path: "test/release-database-target.test.ts",
    controls: ["A31", "transport-tls"],
  },
  { path: "test/scoped-db-import-boundary.test.ts", controls: ["tenant-scope"] },
  { path: "test/secret-classification.test.ts", controls: ["A79"] },
  { path: "test/secret-registry.test.ts", controls: ["A79", "secret-inventory"] },
  { path: "test/security-static-suite.test.ts", controls: ["security-ci"] },
  {
    path: "test/shadow-database-contract.test.ts",
    controls: ["A31", "database-destruction"],
  },
  {
    path: "test/tenant-enforcement-contract.test.ts",
    controls: ["tenant-rls-release"],
  },
  { path: "test/tls-contract.test.ts", controls: ["transport-tls"] },
  { path: "test/vercel-build-cutover.test.ts", controls: ["A31", "A32"] },
  { path: "test/workflow-action-pins.test.ts", controls: ["A60"] },
] as const;

export const staticSecurityTestPaths = staticSecuritySuites.map(
  ({ path }) => path,
);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: srcPath + "/$1" },
      { find: /^server-only$/, replacement: serverOnlyStub },
    ],
  },
  test: {
    environment: "node",
    include: staticSecurityTestPaths,
  },
});
