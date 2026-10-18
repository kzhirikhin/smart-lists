import { expect, it, vi } from "vitest";
import { zapApi, ZapApiError, startSeededScan, nativeScanFinished, resetExcludedParams } from "./active-api";

it("POST API использует точный Content-Type без charset, секретные параметры не в URL", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ Result: "OK" }));
  await zapApi("core", "action", "sendRequest", { request: "ZAP_PRIVATE_TOKEN" }, transport);
  const [url, init] = transport.mock.calls[0];
  expect(String(url)).toBe("http://127.0.0.1:8090/JSON/core/action/sendRequest/");
  expect(init?.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
  expect(String(init?.body)).toBe("request=ZAP_PRIVATE_TOKEN");
  expect(init?.method).toBe("POST");
});

it("процент не заменяет native FINISHED: ещё не начавшийся scan остаётся ожидающим", () => {
  expect(nativeScanFinished([{ id: "1", state: "NOT_STARTED", progress: "100" }], "1")).toBe(false);
  expect(nativeScanFinished([{ id: "1", state: "RUNNING", progress: "100" }], "1")).toBe(false);
  expect(nativeScanFinished([{ id: "1", state: "FINISHED" }], "1")).toBe(true);
  expect(nativeScanFinished([], "1")).toBe(false);
  expect(() => nativeScanFinished([{ id: "1", state: "unknown" }], "1")).toThrow();
});

it("ожидает регистрацию seed в Sites tree, но не повторяет прочие ошибки", async () => {
  const api = vi.fn<typeof zapApi>().mockRejectedValueOnce(new ZapApiError("url_not_found")).mockResolvedValue({ scan: "0" });
  const wait = vi.fn().mockResolvedValue(undefined);
  expect(await startSeededScan({ url: "http://localhost:3102/en" }, api, wait)).toEqual({ scan: "0" });
  expect(api).toHaveBeenCalledTimes(2);
  expect(wait).toHaveBeenCalledWith(100);
  api.mockReset().mockRejectedValue(new ZapApiError("illegal_parameter"));
  await expect(startSeededScan({}, api, wait)).rejects.toThrow("active-infrastructure");
  expect(api).toHaveBeenCalledTimes(1);
});

it("отказ ZAP API не превращается в успешную настройку или произвольное исключение", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: "content_type_not_supported", message: "ZAP_PRIVATE_NOTE" }));
  await expect(zapApi("ascan", "action", "addScanPolicy", {}, transport)).rejects.toThrow(/^active-infrastructure$/);
  await expect(zapApi("http://outside", "action", "scan", {}, transport)).rejects.toThrow(/^active-infrastructure$/);
});

it("смена Action удаляет старые исключения в обратном порядке и отказывает на неизвестной форме", async () => {
  const api = vi.fn<typeof zapApi>().mockResolvedValueOnce({ excludedParams: [{ name: "1_title" }, { name: "1_itemName" }] }).mockResolvedValue({ Result: "OK" });
  await resetExcludedParams(api);
  expect(api.mock.calls).toEqual([["ascan", "view", "excludedParams"], ["ascan", "action", "removeExcludedParam", { idx: "1" }], ["ascan", "action", "removeExcludedParam", { idx: "0" }]]);
  api.mockReset().mockResolvedValue({ excludedParams: "unknown" });
  await expect(resetExcludedParams(api)).rejects.toThrow("active-infrastructure");
  expect(api).toHaveBeenCalledTimes(1);
});
