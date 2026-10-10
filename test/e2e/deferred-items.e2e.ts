/** Отложенная работа: оформление, возврат в работу и состояние блока. */
import { expect, test } from "./fixtures";
import { makeItems, makeList, makeSubItems } from "./factories";
import { itemRow, listCard, openItemMenu, openSpace, subItemRow } from "./helpers";

for (const width of [320, 1280]) {
  for (const theme of ["light", "dark"]) {
    test("отложение пунктов и подпунктов: " + width + "px, " + theme, async ({ page, user, db }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
      const list = await makeList(db, user.id, user.defaultSpaceId);
      const [parent, plain] = await makeItems(db, list.id, ["Блок", "Отдельная задача"]);
      const [done, open] = await makeSubItems(db, list.id, parent.id, ["Выполнено", "Отложить шаг"]);
      await db.item.update({ where: { id: done.id }, data: { isCompleted: true, status: "COMPLETED" } });
      await openSpace(page, user);
      const card = listCard(page, list.id);
      await (await openItemMenu(card, parent.id)).getByTestId("item-defer-action").click();
      await expect(itemRow(card, parent.id).getByTestId("item-toggle").first()).toHaveAttribute("data-status", "DEFERRED");
      await expect(subItemRow(card, open.id).getByTestId("item-deferred-indicator")).toBeVisible();
      await expect(subItemRow(card, done.id).getByTestId("item-toggle")).toHaveAttribute("data-completed", "true");
      await (await openItemMenu(card, plain.id)).getByTestId("item-defer-action").click();
      await expect(card.getByTestId("list-progress-indicator")).toHaveCount(0);
      const row = itemRow(card, plain.id);
      await expect(row.getByTestId("item-toggle")).toHaveAttribute("aria-checked", "false");
      await expect(row.getByTestId("item-name")).not.toHaveCSS("text-decoration-line", "line-through");
      await expect(row.getByTestId("item-name")).toHaveCSS("font-style", "italic");
      await expect(card.getByTestId("list-items-counter")).toHaveText("0 / 2");
      await page.reload();
      await expect(row.getByTestId("item-deferred-indicator")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await card.screenshot({ path: testInfo.outputPath("deferred-items.png") });
      await (await openItemMenu(card, plain.id)).getByTestId("item-progress-action").click();
      await expect(row.getByTestId("item-toggle")).toHaveAttribute("data-status", "IN_PROGRESS");
      await expect(card.getByTestId("list-progress-indicator")).toBeVisible();
      await (await openItemMenu(card, plain.id)).getByTestId("item-defer-action").click();
      await expect(row.getByTestId("item-toggle")).toHaveAttribute("data-status", "DEFERRED");
      await (await openItemMenu(card, plain.id)).getByTestId("item-defer-action").click();
      await expect(row.getByTestId("item-toggle")).toHaveAttribute("data-status", "NOT_STARTED");
      await subItemRow(card, open.id).getByTestId("item-menu-trigger").click();
      await subItemRow(card, open.id).getByTestId("item-progress-action").click();
      await expect(itemRow(card, parent.id).getByTestId("item-toggle").first()).toHaveAttribute("data-status", "IN_PROGRESS");
      await subItemRow(card, open.id).getByTestId("item-toggle").click();
      await expect(itemRow(card, parent.id).getByTestId("item-toggle").first()).toHaveAttribute("data-status", "COMPLETED");
      await (await openItemMenu(card, plain.id)).getByTestId("item-defer-action").click();
      await row.getByTestId("item-toggle").click();
      await expect(row.getByTestId("item-toggle")).toHaveAttribute("data-status", "COMPLETED");
      await expect(card.getByTestId("list-progress-indicator")).toHaveCount(0);
      await expect(card.getByTestId("list-items-counter")).toHaveText("2 / 2");
    });
  }
}


for (const width of [320, 1280]) {
  for (const theme of ["light", "dark"]) {
    test("визуальная иерархия трёх состояний: " + width + "px, " + theme, async ({ page, user, db }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => {
        localStorage.setItem("theme", value);
        localStorage.setItem("showAuthors", "true");
        localStorage.setItem("showItemNumbers", "true");
      }, theme);
      const list = await makeList(db, user.id, user.defaultSpaceId, { title: "Текущие задачи" });
      const [deferred, started, neutral] = await makeItems(db, list.id, [
        "Подготовить материалы после ответа коллег",
        "Разобрать текущие замечания и подготовить исправления",
        "Запланировать следующую встречу",
      ], { addedById: user.id });
      await db.item.update({ where: { id: deferred.id }, data: { status: "DEFERRED" } });
      await db.item.update({ where: { id: started.id }, data: { status: "IN_PROGRESS" } });
      await openSpace(page, user);
      const card = listCard(page, list.id);
      const deferredRow = itemRow(card, deferred.id);
      const startedRow = itemRow(card, started.id);
      const neutralRow = itemRow(card, neutral.id);
      await expect(deferredRow.getByTestId("item-author")).toBeVisible();
      await expect(startedRow.getByTestId("item-progress-indicator")).toBeVisible();
      await expect(deferredRow.getByTestId("item-deferred-indicator")).toBeVisible();
      const startedBackground = await startedRow.getByTestId("item-status-row").evaluate(el => getComputedStyle(el).backgroundImage);
      expect(startedBackground).toContain("linear-gradient");
      await expect(deferredRow.getByTestId("item-name")).toHaveCSS("font-style", "italic");
      await expect(neutralRow.getByTestId("item-name")).toHaveCSS("font-style", "normal");
      const secondaryColor = await deferredRow.getByTestId("item-author").evaluate(el => getComputedStyle(el).color);
      expect(secondaryColor).not.toBe(await neutralRow.getByTestId("item-author").evaluate(el => getComputedStyle(el).color));
      const deferredBackground = await deferredRow.getByTestId("item-status-row").evaluate(el => getComputedStyle(el).backgroundImage);
      expect(deferredBackground).toContain("linear-gradient");
      expect(startedBackground).not.toBe(deferredBackground);
      expect(startedBackground.split(",")[0]).toBe(deferredBackground.split(",")[0]);
      await expect(neutralRow.getByTestId("item-status-row")).toHaveCSS("background-image", "none");
      for (const statusRow of [deferredRow, startedRow]) {
        // Оба названия сохраняют контраст (WCAG AA) на краях своих градиентов.
        const contrast = await statusRow.getByTestId("item-name").evaluate((el) => {
          // Canvas переводит и rgb, и современные oklch-цвета Tailwind в sRGB.
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          const rgba = (value: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = value;
            context.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
            return [r, g, b, a / 255];
          };
          const title = rgba(getComputedStyle(el).color);
          let ancestor: Element | null = el;
          let background: number[] = [255, 255, 255, 1];
          while (ancestor) {
            const color = rgba(getComputedStyle(ancestor).backgroundColor);
            if ((color[3] ?? 1) === 1) { background = color; break; }
            ancestor = ancestor.parentElement;
          }
          const rowStyle = getComputedStyle(el.closest('[data-testid="item-status-row"]')!);
          const stops = ["--tw-gradient-from", "--tw-gradient-to"].map(property => rgba(rowStyle.getPropertyValue(property).trim()));
          const backgrounds = stops.map(stop => stop.slice(0, 3).map((channel, index) => channel * stop[3] + background[index] * (1 - stop[3])));
          const luminance = (color: number[]) => color.slice(0, 3).map(channel => {
            const normalized = channel / 255;
            return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
          }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
          return Math.min(...backgrounds.map(backdrop => {
            const alpha = title[3] ?? 1;
            const foreground = title.slice(0, 3).map((channel, index) => channel * alpha + backdrop[index] * (1 - alpha));
            const a = luminance(foreground), b = luminance(backdrop);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          }));
        });
        expect(contrast).toBeGreaterThanOrEqual(4.5);
      }
      await expect(deferredRow.getByTestId("item-menu-trigger")).toHaveCSS("opacity", "1");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await card.screenshot({ path: testInfo.outputPath("status-hierarchy.png") });
    });
  }
}
