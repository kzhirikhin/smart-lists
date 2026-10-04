/**
 * @file workflow-action-pins.test.ts
 * @description Статический контракт закрепления GitHub Actions по SHA.
 *
 * Тег в реестре Actions — это имя, которое владелец репозитория может
 * переставить на другое содержимое в любой момент. `@v7` завтра означает не то,
 * что сегодня, и об этом не будет ни строки в диффе: строка `uses:` не менялась.
 * Скомпрометированный action исполняется в workflow с его правами, а в
 * `production-migration` рядом с боевым `DIRECT_URL`.
 *
 * Почему тест, а не договорённость. На 2026-08-28 все `uses:` закреплены по
 * полному SHA — то есть контроль уже действует, и защищать надо не его
 * появление, а его сохранение. Ровно этот класс ошибки описан в шапке
 * `dependency-install-hooks.test.ts`: контроль был настоящий, документ утверждал
 * его повсеместность, а один файл выпал из виду и полсуток был незащищён. Разница
 * между «сегодня верно» и «не может стать неверным» — это наличие проверки.
 *
 * Форма та же, что у A51: смотрим на все workflow сразу. Новый job со строкой
 * `uses: actions/cache@v4` должен ронять PR, а не проходить незамеченным.
 *
 * Комментарий версии рядом с SHA (`# v7.0.1`) обязателен отдельно: Dependabot
 * двигает пин вместе с ним, и без него человек не может прочитать, какая версия
 * закреплена, не сходив в реестр.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = `${repoRoot}.github/workflows`;

const workflows = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => ({
    name,
    body: readFileSync(`${workflowsDir}/${name}`, "utf8"),
  }));

// Значение `uses:` целиком, вместе с остатком строки: комментарий версии
// проверяется той же проверкой, что и сам пин.
const USES = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm;

// Локальные действия из этого же репозитория подменить переносом тега нельзя:
// они приезжают тем же checkout, что и код. Сейчас таких нет, но исключение
// описано заранее, чтобы появление первого не выглядело нарушением контракта.
const isLocal = (ref: string) => ref.startsWith("./") || ref.startsWith("../");

const actionRefs = workflows.flatMap(({ name, body }) =>
  [...body.matchAll(USES)].map((match) => ({
    file: name,
    ref: match[1],
    rest: match[2],
  })),
);

// Берём все вызовы из файлов, чтобы новый шаг с AWS Action тоже попадал в gate.
const awsCredentialSteps = workflows.flatMap(({ name, body }) =>
  body
    .split(/(?=^[ \t]*-[ \t]+(?:name|uses):)/m)
    .filter((step) =>
      /^[ \t]*(?:-[ \t]*)?uses:[ \t]*aws-actions\/configure-aws-credentials@/m.test(step),
    )
    .map((step) => ({ file: name, step })),
);

describe("AWS credentials используют явные настройки workflow", () => {
  it("находит action бэкапа", () => {
    expect(awsCredentialSteps.map(({ file }) => file)).toContain("backup.yml");
  });

  it.each(awsCredentialSteps)("$file: окружение не подменяет inputs", ({ step }) => {
    expect(step).toMatch(/^[ \t]+translate-env-variables:[ \t]*false[ \t]*(?:#.*)?$/m);
  });
});

describe("GitHub Actions закреплены по SHA", () => {
  // Проверки ниже проходят и на пустом списке, поэтому сначала требуем, чтобы
  // выражение действительно что-то нашло. Иначе сломанный regexp сделал бы
  // контракт зелёным и пустым.
  it("находит вызовы actions: иначе проверки ниже пройдут впустую", () => {
    expect(workflows.length).toBeGreaterThan(0);
    expect(actionRefs.length).toBeGreaterThanOrEqual(5);
    expect(actionRefs.map((entry) => entry.file)).toContain("ci.yml");
  });

  it.each(actionRefs)(
    "$file: $ref закреплён полным SHA",
    ({ ref }) => {
      if (isLocal(ref)) return;

      // Ровно 40 hex после `@`: `@v7`, `@main` и укороченный SHA не проходят.
      expect(ref).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
    },
  );

  it.each(actionRefs)(
    "$file: $ref сопровождается комментарием версии",
    ({ ref, rest }) => {
      if (isLocal(ref)) return;

      expect(rest).toMatch(/#\s*v?\d/);
    },
  );
});
