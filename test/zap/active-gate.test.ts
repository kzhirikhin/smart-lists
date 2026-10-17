import { expect, it } from "vitest";
import { createActiveGate } from "./active-gate";

it("бюджет и неизвестный путь блокируются до upstream, закрытый gate не открывается новым select", async () => {
  const gate = createActiveGate(1);
  const port = await gate.listen(0);
  // Не направляем тест в настоящий localhost приложения: неверный путь
  // должен быть отклонён до любого upstream connect.
  gate.select({ role: "anonymous", operation: "none", path: "/en?zap=baseline", method: "GET", field: "zap", headers: {}, body: "" });
  try {
    expect((await fetch(`http://127.0.0.1:${port}/api/auth/signout`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/en?zap=attack`)).status).toBe(429);
    expect(gate.stats.requests).toBe(1);
    expect(gate.stats.exhausted).toBe(true);
    gate.closeGate();
    gate.select({ role: "anonymous", operation: "none", path: "/en?zap=baseline", method: "GET", field: "zap", headers: {}, body: "" });
    expect((await fetch(`http://127.0.0.1:${port}/en?zap=attack`)).status).toBe(403);
  } finally { await gate.close(); }
  expect(() => createActiveGate(601)).toThrow();
  expect(() => createActiveGate(0)).toThrow();
});
