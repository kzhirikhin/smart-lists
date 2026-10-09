/** Регрессия длинных слов: проверяем реальные границы текста, а не только карточки. */
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";
import { makeItems, makeList, makeSubItems } from "./factories";
import { itemRow, subItemRow, listCard, openItemMenu, openSpace, visible } from "./helpers";

async function expectTextFits(text: Locator) {
  await expect(text).toBeVisible();
  expect(await text.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    return element.scrollWidth <= element.clientWidth + 1 &&
      Array.from(range.getClientRects()).every((rect) =>
        rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1);
  })).toBe(true);
}

for (const width of [320, 1280]) {
  for (const theme of ["light", "dark"]) {
    const locale = width === 320 ? (theme === "light" ? "ru" : "vi") : (theme === "light" ? "en" : "ja");
    test("длинные пункты и диалог не переполняются: " + width + "px, " + theme + ", " + locale, async ({ page, user, db }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem("showAuthors", "true");
        localStorage.setItem("showItemNumbers", "true");
        localStorage.setItem("theme", selectedTheme);
      }, theme);
      const list = await makeList(db, user.id, user.defaultSpaceId);
      const names = ["213" + "3".repeat(197), "https://example.com/" + "a".repeat(180), "Длинное название с пробелами ".repeat(7).slice(0, 200), "4".repeat(200)];
      const [plain, progress, parent, completed] = await makeItems(db, list.id, names, { addedById: user.id });
      const [sub] = await makeSubItems(db, list.id, parent.id, ["333".repeat(66), "Подпункт с длинным названием ".repeat(7).slice(0, 200)]);
      await db.item.update({ where: { id: progress.id }, data: { status: "IN_PROGRESS" } });
      await db.item.update({ where: { id: sub.id }, data: { status: "IN_PROGRESS" } });
      await db.item.update({ where: { id: completed.id }, data: { status: "COMPLETED", isCompleted: true } });
      await openSpace(page, user);
      if (locale !== "en") await page.goto("/" + locale + "/spaces/" + user.defaultSpaceId);
      const card = listCard(page, list.id);
      for (const item of [plain, progress, parent, completed]) {
        await expectTextFits(itemRow(card, item.id).getByTestId("item-name").first());
      }
      for (const name of await card.getByTestId("sub-item").getByTestId("item-name").all()) await expectTextFits(name);
      const progressRow = itemRow(card, progress.id);
      const checkbox = await progressRow.getByTestId("item-toggle").boundingBox();
      const indicator = await progressRow.getByTestId("item-progress-indicator").boundingBox();
      expect(indicator!.x).toBeGreaterThan(checkbox!.x);
      expect(indicator!.x + indicator!.width).toBeLessThan(checkbox!.x + checkbox!.width);
      expect(indicator!.y).toBeGreaterThan(checkbox!.y);
      expect(indicator!.y + indicator!.height).toBeLessThan(checkbox!.y + checkbox!.height);
      await expect(progressRow.getByTestId("item-author")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await card.screenshot({ path: testInfo.outputPath("long-items.png") });

      // Редактор должен оставаться доступным, а Escape — возвращать полное название.
      await progressRow.getByTestId("item-name").click();
      await expect(progressRow.getByTestId("item-name-input")).toHaveValue(names[1]);
      await progressRow.getByTestId("item-name-input").press("Escape");
      await expectTextFits(progressRow.getByTestId("item-name"));

      await (await openItemMenu(card, plain.id)).getByTestId("item-delete").click();
      const modal = visible(page, "item-delete-modal");
      await expectTextFits(modal.getByTestId("item-delete-body"));
      await expect(modal.getByTestId("item-delete-body")).toContainText(names[0]);
      expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await modal.screenshot({ path: testInfo.outputPath("long-delete.png") });
      await modal.getByTestId("item-delete-cancel").click();
      await expect(modal).toHaveCount(0);

      // Подсветка совпадения добавляет mark внутри длинного слова и не должна ломать перенос.
      await visible(page, "tab-search").click();
      await visible(page, "search-input").fill("333");
      await expect(subItemRow(card, sub.id).getByTestId("item-name").locator("mark")).toBeVisible();
      await expectTextFits(subItemRow(card, sub.id).getByTestId("item-name"));
      await expectTextFits(itemRow(card, plain.id).getByTestId("item-name"));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}
