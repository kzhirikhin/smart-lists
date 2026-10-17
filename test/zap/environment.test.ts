import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

it("локальный Compose не публикует порты, mount, env_file или привилегии хоста", () => {
  const compose = read("docker-compose.zap.yml");
  expect(compose).toContain("internal: true");
  expect(compose).toContain("network_mode: service:postgres");
  expect(compose).toContain("smartlists_zap_test");
  expect(compose).not.toMatch(/^\s*(ports|volumes|env_file|privileged|cap_add|devices):/m);
  expect(compose).not.toContain("host.docker.internal");
});

it("сборка отключает install-хуки и имеет ограниченный build context", () => {
  const dockerfile = read("docker/zap/Dockerfile");
  expect(dockerfile).toContain("npm ci --ignore-scripts");
  expect(dockerfile).toContain("npx prisma generate");
  // Файл генерирует Next build; чистый GitHub checkout его не содержит.
  expect(dockerfile).not.toMatch(/^COPY.*\bnext-env\.d\.ts\b/m);
  expect(dockerfile).not.toMatch(/COPY\s+\.\s/);
  expect(read("docker/zap/Dockerfile.dockerignore")).toMatch(/^\*\*$/m);
  expect(read("docker/zap/Dockerfile.dockerignore")).not.toContain("!.env");
});
