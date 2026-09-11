/**
 * @file secret-classification.test.ts
 * @description Контракт разделения GitHub secrets и variables.
 *
 * Зачем: репозиторий публичный, а `vars.*` в логах **не маскируются** — в
 * отличие от `secrets.*`. Поэтому вопрос «секрет или переменная» здесь решается
 * не тем, является ли значение credential, а тем, готовы ли мы видеть его в
 * открытом логе каждого прогона.
 *
 * Опасна именно уборка: перенос выглядит наведением порядка — «это же не
 * секрет, это хостнейм» — и молча снимает маскирование с боевого адреса или
 * строки подключения. Отказа при этом не происходит, workflow остаётся
 * зелёным, а значение просто начинает печататься. Поймать такое можно только
 * до слияния, поэтому решение закреплено тестом, а не комментарием.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workflowsDir = fileURLToPath(
  new URL("../.github/workflows", import.meta.url),
);

// Набор берётся обходом каталога, а не списком в тесте: новый workflow обязан
// попадать под проверку сам, без правки этого файла.
const workflows = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({
    name,
    body: readFileSync(`${workflowsDir}/${name}`, "utf8"),
  }));

/**
 * Значения, которые обязаны оставаться в secrets. Список ручной намеренно: он
 * и есть записанное решение, а не утверждение о полноте. Причина у каждого
 * своя, и все три — про разведку, а не про прямой вред от раскрытия.
 */
const SECRET_ONLY = [
  // Credential. Обсуждению не подлежит.
  "DIRECT_URL",
  // Точный хост боевой базы. По A42 endpoint Neon достижим откуда угодно, и
  // единственный барьер до аутентификации — знание credential; публиковать
  // адрес значит снижать планку разведки бесплатно.
  "EXPECTED_DATABASE_HOST",
  // Имя приватного бакета с дампами БД.
  "BACKUP_S3_BUCKET",
  // Содержит ID аккаунта AWS. Роль по имени взять нельзя — доступ определяет
  // trust policy, — но операционного смысла публиковать номер нет.
  "BACKUP_AWS_ROLE_ARN",
];

const referencesOf = (body: string, kind: "secrets" | "vars") =>
  new Set(
    [...body.matchAll(new RegExp(`${kind}\\.([A-Z0-9_]+)`, "g"))].map(
      (match) => match[1],
    ),
  );

describe("разделение secrets и variables", () => {
  it("видит workflow-файлы: иначе проверки ниже пройдут впустую", () => {
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows.map((file) => file.name)).toContain("backup.yml");
  });

  it.each(SECRET_ONLY)("%s нигде не читается через vars", (name) => {
    for (const workflow of workflows) {
      expect(
        referencesOf(workflow.body, "vars").has(name),
        `${workflow.name} читает ${name} как variable`,
      ).toBe(false);
    }
  });

  it("каждое имя из списка действительно используется как secret", () => {
    // Иначе список тихо превратится в набор имён, которых давно нет, и
    // перестанет что-либо защищать.
    const used = new Set(
      workflows.flatMap((workflow) => [...referencesOf(workflow.body, "secrets")]),
    );
    for (const name of SECRET_ONLY) {
      expect(used, `${name} больше не используется как secret`).toContain(name);
    }
  });

  it("ни одно имя не значится одновременно секретом и переменной", () => {
    // Проверка не зависит от списка выше: она ловит непоследовательную
    // классификацию любого значения, включая появившиеся позже.
    const secrets = new Set(
      workflows.flatMap((workflow) => [...referencesOf(workflow.body, "secrets")]),
    );
    const vars = new Set(
      workflows.flatMap((workflow) => [...referencesOf(workflow.body, "vars")]),
    );
    const both = [...secrets].filter((name) => vars.has(name));
    expect(both).toEqual([]);
  });

  // Строка подключения роли бэкапа была repository-секретом, то есть читалась
  // любым workflow с любой ветки. С 2026-09-06 она лежит в Environment
  // `Backup`, и достаётся только job, объявившей его. Регистр имени входит в
  // OIDC-claim `sub`, на который смотрит trust policy роли AWS: `backup`
  // вместо `Backup` не сломает CI видимым образом — job просто не получит
  // credentials AWS. Repository-секрета с этим именем больше нет, поэтому
  // потеря строки означала бы и потерю доступа к базе, но выяснилось бы это
  // только ночью, на расписании (A83).
  it("job бэкапа объявляет Environment с точным регистром имени", () => {
    const backup = workflows.find((workflow) => workflow.name === "backup.yml");
    expect(backup, "backup.yml не найден").toBeDefined();
    expect(backup!.body).toMatch(/^ {4}environment: Backup$/m);
    expect(backup!.body).toContain("secrets.DIRECT_URL");
  });
});
