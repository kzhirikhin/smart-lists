import { boundedJson } from "./report";

export const apiCodes = ["missing_parameter", "bad_parameter", "bad_action", "url_not_in_scope", "url_not_found", "bad_type", "bad_other", "does_not_exist", "already_exists", "illegal_parameter", "content_type_not_supported", "unknown"] as const;
export class ZapApiError extends Error {
  code: typeof apiCodes[number];
  constructor(code: unknown) { super("active-infrastructure"); this.code = apiCodes.find(candidate => candidate === code) ?? "unknown"; }
}

/** ZAP не принимает автоматически добавленный fetch charset=UTF-8 для POST
 * API. Тело URL-encoded остаётся внутри loopback, не в URL или логах. */
export async function zapApi(component: string, kind: "action" | "view", operation: string, params: Record<string, string> = {}, transport: typeof fetch = fetch) {
  if (!/^[a-z]+$/.test(component) || !/^[a-zA-Z]+$/.test(operation)) throw new Error("active-infrastructure");
  const url = new URL(`http://127.0.0.1:8090/JSON/${component}/${kind}/${operation}/`);
  const response = await transport(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(operation === "scan" ? 60_000 : 10_000) });
  const data = await boundedJson(response) as Record<string, unknown>;
  if (data.code) throw new ZapApiError(data.code);
  return data;
}

/** Core sendRequest добавляет узел в Sites tree через EDT асинхронно.
 * Повторяем только URL_NOT_FOUND до начала scan, не другие ошибки. */
export async function startSeededScan(params: Record<string, string>, api: typeof zapApi = zapApi, wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await api("ascan", "action", "scan", params); }
    catch (error) {
      if (!(error instanceof ZapApiError) || error.code !== "url_not_found" || attempt >= 50) throw error;
      await wait(100);
    }
  }
}

export function nativeScanFinished(raw: unknown, scanId: string) {
  if (!Array.isArray(raw)) throw new Error("active-infrastructure");
  const scan = raw.find(item => item && typeof item === "object" && item.id === scanId);
  if (!scan) return false;
  if (!["NOT_STARTED", "RUNNING", "PAUSED", "FINISHED"].includes(scan.state)) throw new Error("active-infrastructure");
  return scan.state === "FINISHED";
}

/** Исключения ZAP глобальны: поля предыдущего Action не должны отключать
 * изменяемое поле следующего. Индексы удаляем с конца, затем задаём новый набор. */
export async function resetExcludedParams(api: typeof zapApi = zapApi) {
  const raw = (await api("ascan", "view", "excludedParams")).excludedParams;
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("active-infrastructure");
  for (let idx = raw.length - 1; idx >= 0; idx--) await api("ascan", "action", "removeExcludedParam", { idx: String(idx) });
}

/** Chromium может освободить RSC-ответ после навигации. Подтверждаем
 * HTTP 200 и запись в БД без зависимости от lifetime response body. Повторяются только
 * чтения фикстуры; саму мутацию/атаку функция никогда не переотправляет. */
export async function confirmBrowserMutation(response: { status(): number } | null,
  persisted: () => Promise<boolean>, wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))) {
  if (!response || response.status() !== 200) throw new Error("active-coverage");
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await persisted()) return;
    await wait(100);
  }
  throw new Error("active-coverage");
}
