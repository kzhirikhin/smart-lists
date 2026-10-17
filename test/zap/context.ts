import type { Browser } from "@playwright/test";

/**
 * Только opt-in пилот: метки всех контекстов, включая browser.newContext в sharing.
 * Метка — технический ID сценария, не идентификатор пользователя или сессии.
 */
export function instrumentContexts(browser: Browser, scenarioId: string, loseSession: boolean) {
  const original = browser.newContext;
  let index = 0;
  browser.newContext = async function (options = {}) {
    const context = await original.call(browser, {
      ...options,
      extraHTTPHeaders: {
        ...options.extraHTTPHeaders,
        "X-Zap-Pilot-Test": scenarioId,
        "X-Zap-Pilot-Context": String(++index),
      },
    });
    if (loseSession) {
      const addCookies = context.addCookies.bind(context);
      context.addCookies = (cookies) => addCookies(cookies.filter((cookie) => cookie.name !== "authjs.session-token"));
    }
    // Внешние шрифты/флаги/Pusher не часть проверяемого потока. Сеть Docker
    // ограничивает также приложение и ZAP, route уменьшает ожидания браузера.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return url.origin === "http://localhost:3100" ? route.continue() : route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    return context;
  };
  return () => { browser.newContext = original; };
}
