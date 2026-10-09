/** Геометрия реальной панели с подставленным ответом Action, без вызова внешнего AI. */
import { expect, test } from "./fixtures";
import { makeList } from "./factories";
import { listCard, openSpace } from "./helpers";

for (const width of [320, 1280]) {
  for (const theme of ["light", "dark"]) {
    test("длинные фрагменты инсайта помещаются: " + width + "px, " + theme, async ({ page, user, db }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
      const list = await makeList(db, user.id, user.defaultSpaceId);
      const url = "https://habr.com/ru/companies/bizone/articles/1011196/";
      const word = "a".repeat(400);
      const insight = [
        "1. **Изучить OWASP:** ссылка (" + url + ") и длинное слово " + word,
        "   - Вложенный пункт: " + word,
        "2. Inline code: `" + url + word + "`",
        "```text\n  " + url + word + "\n```",
        "[Безопасный текст ссылки](https://evil.example/phish)",
        "![Текст картинки](https://evil.example/beacon)",
      ].join("\n\n");
      await openSpace(page, user);
      const card = listCard(page, list.id);
      await card.getByTestId("ai-insight-button").click();
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (request.method() !== "POST" || !request.headers()["next-action"]) {
          await route.continue();
          return;
        }
        await route.fulfill({
          contentType: "text/x-component",
          body: '0:{"a":"$1","f":[],"b":""}\n1:' + JSON.stringify({ insight }) + "\n",
        });
      });
      await card.getByTestId("ai-insight-analyze").click();
      const result = card.getByTestId("ai-insight-result");
      await expect(result).toBeVisible();
      await expect(result).toContainText(url);
      await expect(result).toContainText(word);
      await expect(result.locator("pre")).toHaveCount(1);
      await expect(result.locator("a, img")).toHaveCount(0);
      expect(await result.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const range = document.createRange();
          range.selectNodeContents(node);
          if (Array.from(range.getClientRects()).some(rect => rect.left < bounds.left || rect.right > bounds.right)) return false;
        }
        return element.scrollWidth <= element.clientWidth;
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await result.screenshot({ path: testInfo.outputPath("insight-layout.png") });
    });
  }
}
