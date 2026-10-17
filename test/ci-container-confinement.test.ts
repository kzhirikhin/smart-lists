/**
 * @file ci-container-confinement.test.ts
 * @description Статический контракт изоляции контейнеров (допущение A45).
 *
 * Дефолтные seccomp- и AppArmor-профили контейнеров достаются нам даром: их
 * ставит Docker, а не наши файлы. Поэтому единственное, что мы можем с ними
 * сделать, — молча снять одним флагом, и в диффе такая правка выглядит
 * безобидной строкой рядом с healthcheck.
 *
 * Второе утверждение того же допущения: шаги CI-job исполняются прямо на
 * одноразовой VM раннера, а не в контейнере. Именно её одноразовость, а не
 * профиль контейнера, служит границей для недоверенного кода зависимостей.
 * Появление `container:` меняет эту модель целиком и требует пересмотра A45,
 * а не молчаливого прохождения тестов.
 *
 * Третья проверка — про происхождение образов, и она добавлена по факту.
 * В соседнем репозитории `docker-compose.yml` годами тянул `latest` из чужого
 * по нынешним временам GHCR-namespace: аккаунт был переименован, старое имя
 * освободилось, и занять его мог кто угодно. Такой файл выполняет чужой код на
 * машине разработчика при первом же `docker compose up`. Поэтому здесь
 * разрешены официальные образы Docker Hub и одно явное исключение:
 * официальный ZAP GHCR по проверенному digest, только для локального пилота.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = `${repoRoot}.github/workflows`;

const read = (dir: string, name: string) => ({
  name,
  body: readFileSync(`${dir}/${name}`, "utf8"),
});

const workflows = readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => read(workflowsDir, name));

const composeFiles = readdirSync(repoRoot)
  .filter((name) => /^(docker-)?compose.*\.ya?ml$/.test(name))
  .map((name) => read(repoRoot, name));

// Флаги `docker run`, снимающие дефолтные ограничения контейнера. Каждый по
// отдельности возвращает контейнеру часть прав хоста.
const WEAKENING_FLAGS = [
  "--privileged",
  "--security-opt",
  "--cap-add",
  "--userns",
  "--pid=host",
  "--device",
];

// Те же послабления в синтаксисе Compose.
const WEAKENING_COMPOSE_KEYS = [
  "privileged:",
  "cap_add:",
  "security_opt:",
  "userns_mode:",
  "network_mode: host",
  "pid: host",
  "devices:",
];

describe("изоляция контейнеров", () => {
  it("видит и workflow, и compose: иначе проверки ниже пройдут впустую", () => {
    expect(workflows.map((file) => file.name)).toContain("ci.yml");
    expect(composeFiles.map((file) => file.name)).toContain(
      "docker-compose.test.yml",
    );
  });

  it.each(workflows)(
    "$name не ослабляет профиль service-контейнеров",
    ({ body }) => {
      for (const flag of WEAKENING_FLAGS) {
        expect(body).not.toContain(flag);
      }
    },
  );

  it.each(workflows)("$name не выполняет шаги в контейнере", ({ body }) => {
    // Ключ job-уровня идёт с отступом в четыре пробела: `jobs:` → job → `container:`.
    expect(body).not.toMatch(/^ {4}container:/m);
  });

  it.each(composeFiles)("$name не ослабляет профиль контейнеров", ({ body }) => {
    for (const key of WEAKENING_COMPOSE_KEYS) {
      expect(body).not.toContain(key);
    }
  });

  it.each(composeFiles)("$name тянет только официальные образы", ({ name, body }) => {
    const images = [...body.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map(
      (match) => match[1],
    );

    for (const image of images) {
      if (name === "docker-compose.zap.yml" && image === "ghcr.io/zaproxy/zaproxy@sha256:7aaa659b0d43078febd82e29bad112285c370727e86ab8340444220e17d9f0d2") continue;
      // Официальный образ Docker Hub записывается как `name:tag`, без владельца
      // и без хоста реестра. Любой слэш означает чужое пространство имён.
      expect(image).not.toContain("/");
    }
  });
});
