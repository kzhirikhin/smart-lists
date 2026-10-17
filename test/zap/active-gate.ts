import { createServer, request, type Server } from "node:http";
import { activePolicy, admitMutation, assertActiveTarget, type ActiveTarget } from "./active-policy";

/** Дополнительный reverse proxy только внутри internal namespace.
 * Бюджет и allowlist проверяются ДО передачи запроса приложению, а не polling
 * после атаки. Сессия/Origin берутся из захваченного запроса, не из payload ZAP.
 * Это профиль прямого Action-input; он не проверяет browser CORS/Origin-защиту. */
export function createActiveGate(limit: number = activePolicy.maxRequests, training = false) {
  if (!Number.isInteger(limit) || limit < 1 || limit > activePolicy.maxRequests) throw new Error("active-budget");
  let target: ActiveTarget | undefined;
  const stats = { requests: 0, rejected: 0, exhausted: false, redirect: false, mutations: 0, successfulMutations: 0, seedStatus: 0, seedSuccess: false };
  let open = true;
  const server: Server = createServer(async (incoming, outgoing) => {
    const reject = (code: number) => { stats.rejected++; outgoing.writeHead(code); outgoing.end("ZAP gate refused"); };
    if (!open || !target) return reject(403);
    if (stats.requests >= limit) { stats.exhausted = true; return reject(429); }
    // Считаем также отклонённые попытки: бесконечный поток 403 не бесплатен.
    stats.requests++;
    const seed = target;
    let body = "";
    try {
      for await (const chunk of incoming) {
        body += chunk.toString("utf8");
        if (Buffer.byteLength(body) > activePolicy.maxBodyBytes) return reject(413);
      }
      const check = admitMutation(seed, incoming.method ?? "", incoming.url ?? "", body, String(incoming.headers["content-type"] ?? ""));
      if (!check.allowed) return reject(403);
      if (check.mutated) stats.mutations++;
      const headers: Record<string, string> = { ...seed.headers, host: training ? "localhost:3101" : "localhost:3100", origin: activePolicy.upstream, connection: "close", "accept-encoding": "identity" };
      for (const name of ["content-length", "transfer-encoding"]) delete headers[name];
      headers["content-length"] = String(Buffer.byteLength(body));
      const upstream = request({ hostname: "127.0.0.1", port: training ? 3101 : 3100, path: incoming.url, method: incoming.method, headers, timeout: 10_000 }, response => {
        // Не отдаём Location сканеру: ни logout, ни внешний redirect не следуют.
        if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) {
          stats.redirect = true; response.resume(); return reject(502);
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2_000_000) response.destroy(); else chunks.push(chunk); });
        response.on("end", () => {
          const result = Buffer.concat(chunks);
          if (!check.mutated) { stats.seedStatus = response.statusCode ?? 0; stats.seedSuccess = stats.seedStatus === 200 && (seed.method === "GET" || /"success":true/.test(result.toString("utf8"))); }
          if (check.mutated && (response.statusCode ?? 500) === 200 && (seed.method === "GET" || /"success":true/.test(result.toString("utf8")))) stats.successfulMutations++;
          const safeHeaders = { ...response.headers };
          delete safeHeaders["transfer-encoding"]; delete safeHeaders["connection"]; delete safeHeaders["content-length"];
          outgoing.writeHead(response.statusCode ?? 502, safeHeaders); outgoing.end(result);
        });
        response.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      upstream.end(body);
    } catch { if (!outgoing.headersSent) reject(400); }
  });
  return {
    stats,
    select(value: ActiveTarget) { assertActiveTarget(value); target = value; stats.seedStatus = 0; stats.seedSuccess = false; },
    closeGate() { open = false; },
    async listen(port = 3102) {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("active-infrastructure");
      return address.port;
    },
    async close() { open = false; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
