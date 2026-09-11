import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PROFILE_TABLES } from "../scripts/database-role-contract.mjs";

const readRepoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const workflow = readRepoFile(".github/workflows/configure-preview-rls.yml");
const previewSync = readRepoFile(".github/workflows/sync-preview.yml");
const configurator = readRepoFile(
  "scripts/configure-tenant-enforcement.mjs",
);

describe("Preview tenant RLS workflow", () => {
  it("работает только из main и только с жёстко заданным Preview Environment", () => {
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("environment: preview");
    expect(workflow).not.toContain("environment: ${{");
    expect(workflow).not.toContain("Production");
    expect(workflow).toContain("permissions:\n  contents: read");
  });

  it("не принимает произвольную таблицу или операцию", () => {
    expect(workflow).toContain("- enable-usage-canary");
    expect(workflow).toContain("- rollback-usage-canary");
    expect(workflow).toContain("- enable-list-item");
    expect(workflow).toContain("- rollback-list-item");
    expect(workflow).toContain("- enable-space-groups");
    expect(workflow).toContain("- rollback-space-groups");
    expect(workflow).toContain("- enable-tenant-full");
    expect(workflow).toContain("- rollback-tenant-full");
    expect(workflow).not.toContain("--group=");
    expect(configurator).not.toContain("--table=");
    expect(configurator).not.toContain("FORCE ROW LEVEL SECURITY");
  });

  it("сериализуется с Preview migration и не отменяет начатое изменение", () => {
    expect(workflow).toContain("group: preview-database-change");
    expect(previewSync).toContain("group: preview-database-change");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toMatch(/^ {4}timeout-minutes: \d+$/m);
  });

  it("не выдаёт DB secret установке и проверяет target до apply", () => {
    const installStep = workflow.slice(
      workflow.indexOf("- name: Install dependencies"),
      workflow.indexOf("- name: Verify Preview database target"),
    );
    expect(installStep).toContain("npm ci --ignore-scripts");
    expect(installStep).not.toContain("DIRECT_URL");
    expect(workflow.indexOf("node scripts/verify-release-database.mjs"))
      .toBeLessThan(
        workflow.indexOf("npm run db:configure-tenant-enforcement"),
      );
    expect(workflow).toContain("--apply");
    expect(workflow).toContain(
      "EXPECTED_DATABASE_HOST: ${{ secrets.EXPECTED_DATABASE_HOST }}",
    );
  });

  it("configurator меняет RLS и guard одной транзакцией и проверяет commit", () => {
    expect(configurator).toContain('await client.query(apply ? "BEGIN"');
    expect(configurator).toContain('await client.query("COMMIT")');
    expect(configurator).toContain('await client.query("ROLLBACK")');
    expect(configurator).toContain("Post-change enforcement profile");
    expect(configurator).toContain("Committed enforcement profile");
    // Ступени rollout проверяются по самой модели, а не по тексту файла:
    // модель переехала в общий контракт, и защищать надо порядок ступеней,
    // а не место их объявления.
    expect(Object.keys(PROFILE_TABLES)).toEqual([
      "disabled",
      "usage-canary",
      "list-item",
      "space-groups",
      "tenant-full",
    ]);
    expect(PROFILE_TABLES["list-item"]).toEqual([
      "UserDailyUsage",
      "List",
      "Item",
    ]);
    expect(configurator).toContain("ROUTINE_CONTRACTS");
    expect(configurator).toContain("POLICY_PREDICATES");
  });
});
