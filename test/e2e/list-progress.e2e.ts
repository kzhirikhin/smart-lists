/** Начатая работа видна в шапке независимо от сворачивания и уровня записи. */
import { expect, test } from "./fixtures";
import { makeItems, makeList, makeSubItems } from "./factories";
import { itemRow, subItemRow, listCard, openItemMenu, openSpace, visible } from "./helpers";

for (const width of [320, 1280]) {
  for (const theme of ["light", "dark"]) {
    test("индикатор начатого списка: " + width + "px, " + theme, async ({ page, user, db }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
      const list = await makeList(db, user.id, user.defaultSpaceId, { title: "Список с длинным заголовком для проверки шапки" });
      const [parent, plain] = await makeItems(db, list.id, ["Родитель", "Отдельный пункт"]);
      const [sub] = await makeSubItems(db, list.id, parent.id, ["Начатый подпункт"]);
      await openSpace(page, user);
      const card = listCard(page, list.id);
      await expect(card.getByTestId("list-progress-indicator")).toHaveCount(0);
      let menu = await openItemMenu(card, plain.id);
      const startIcon = menu.getByTestId("item-start-progress-icon");
      await expect(startIcon).toBeVisible();
      const startCellStyle = await menu.getByTestId("item-start-progress-cell").evaluate((cell) => {
        const style = getComputedStyle(cell);
        return [style.width, style.height, style.borderWidth, style.borderColor, style.borderRadius];
      });
      expect(await startIcon.evaluate((icon) => getComputedStyle(icon).color === getComputedStyle(icon.closest("button")!).color)).toBe(true);
      await expect(startIcon.locator("path")).toHaveAttribute("stroke-width", String(4 / 3));
      await menu.screenshot({ path: testInfo.outputPath("start-progress-menu.png") });
      await expect(menu.getByTestId("item-reset-progress-icon")).toHaveCount(0);
      await menu.getByTestId("item-progress-action").click();
      await expect(card.getByTestId("list-progress-indicator")).toBeVisible();
      menu = await openItemMenu(card, plain.id);
      await expect(menu.getByTestId("item-reset-progress-icon")).toBeVisible();
      expect(await menu.getByTestId("item-reset-progress-icon").evaluate((cell) => {
        const style = getComputedStyle(cell);
        return [style.width, style.height, style.borderWidth, style.borderColor, style.borderRadius];
      })).toEqual(startCellStyle);
      await expect(menu.getByTestId("item-start-progress-icon")).toHaveCount(0);
      await menu.getByTestId("item-progress-action").click();
      await expect(card.getByTestId("list-progress-indicator")).toHaveCount(0);
      await subItemRow(card, sub.id).getByTestId("item-menu-trigger").click();
      await subItemRow(card, sub.id).getByTestId("item-progress-action").click();
      const indicator = card.getByTestId("list-progress-indicator");
      await expect(indicator).toBeVisible();
      await card.getByTestId("list-collapse-toggle").focus();
      await page.keyboard.press("Tab");
      await expect(indicator).toBeFocused();
      await expect(page.getByTestId("tooltip")).toBeVisible();
      await card.getByTestId("list-collapse-toggle").click();
      await expect(card.getByTestId("add-item-input")).toBeHidden();
      await expect(indicator).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await card.screenshot({ path: testInfo.outputPath("collapsed-progress.png") });
      await page.reload();
      await expect(indicator).toBeVisible();
      await card.getByTestId("list-collapse-toggle").click();
      // Поиск другого пункта не должен скрыть отметку начатого подпункта.
      await visible(page, "tab-search").click();
      await visible(page, "search-input").fill("Отдельный");
      await expect(indicator).toBeVisible();
      await visible(page, "search-input").fill("");
      await subItemRow(card, sub.id).getByTestId("item-toggle").click();
      await expect(indicator).toHaveCount(0);
      await expect(itemRow(card, parent.id).getByTestId("item-toggle").first()).toHaveAttribute("data-completed", "true");
    });
  }
}
