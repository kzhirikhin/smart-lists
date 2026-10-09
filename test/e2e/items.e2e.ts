/**
 * @file items.e2e.ts
 * @description Жизненный цикл записи и правила отображения выполненных.
 *
 * Отдельно проверяется нумерация: видимый номер нигде не хранится, он
 * вычисляется при рендере среди невыполненных записей. Такое правило можно
 * сломать только в интерфейсе — в базе номера просто нет.
 */

import { expect, test } from "./fixtures";
import { makeItems, makeList } from "./factories";
import {
  addItem,
  itemNames,
  itemRow,
  listCard,
  openItemMenu,
  openSpace,
  visible,
} from "./helpers";
import { MAX_ITEMS_PER_LIST } from "@/lib/limits";

test("запись добавляется и переживает перезагрузку", async ({ page, user, db }) => {
  const list = await makeList(db, user.id, user.defaultSpaceId);
  await openSpace(page, user);

  const card = listCard(page, list.id);
  await addItem(card, "Молоко");

  await page.reload();
  await expect(
    listCard(page, list.id).getByTestId("item-name"),
  ).toHaveText(["Молоко"]);

  const stored = await db.item.findFirst({ where: { listId: list.id } });
  expect(stored?.addedById).toBe(user.id);
});

test("запись переименовывается по клику на название", async ({ page, user, db }) => {
  const list = await makeList(db, user.id, user.defaultSpaceId);
  const [item] = await makeItems(db, list.id, ["Хлеб"]);
  await openSpace(page, user);

  const card = listCard(page, list.id);
  const row = itemRow(card, item.id);
  await row.getByTestId("item-name").click();
  await row.getByTestId("item-name-input").fill("Батон");
  await row.getByTestId("item-name-input").press("Enter");

  await expect(row.getByTestId("item-name")).toHaveText("Батон");

  await page.reload();
  await expect(itemRow(listCard(page, list.id), item.id).getByTestId("item-name")).toHaveText(
    "Батон",
  );
});

test("выполненная запись уходит вниз и возвращается на своё место", async ({
  page,
  user,
  db,
}) => {
  const list = await makeList(db, user.id, user.defaultSpaceId);
  const [first, second, third] = await makeItems(db, list.id, [
    "Первая",
    "Вторая",
    "Третья",
  ]);
  await openSpace(page, user);

  const card = listCard(page, list.id);
  await itemRow(card, second.id).getByTestId("item-toggle").click();

  // Выполненная запись живёт отдельным блоком в конце списка.
  await expect
    .poll(() => itemNames(card))
    .toEqual(["Первая", "Третья", "Вторая"]);

  await page.reload();
  const reloaded = listCard(page, list.id);
  await expect.poll(() => itemNames(reloaded)).toEqual([
    "Первая",
    "Третья",
    "Вторая",
  ]);

  // Снятие галки возвращает запись на прежнее место: `position` при
  // переключении статуса не пишется вовсе.
  await itemRow(reloaded, second.id).getByTestId("item-toggle").click();
  await expect.poll(() => itemNames(reloaded)).toEqual([
    "Первая",
    "Вторая",
    "Третья",
  ]);

  expect(
    (await db.item.findMany({ where: { listId: list.id }, orderBy: { position: "asc" } }))
      .map((row) => row.name),
  ).toEqual(["Первая", "Вторая", "Третья"]);

  // Порядок в базе не изменился, а значит, id остались прежними.
  expect([first.id, second.id, third.id]).toHaveLength(3);
});

test("нумерация считается среди невыполненных записей", async ({ page, user, db }) => {
  const list = await makeList(db, user.id, user.defaultSpaceId);
  const [, second] = await makeItems(db, list.id, ["Первая", "Вторая", "Третья"]);
  await openSpace(page, user);

  // Нумерация выключена по умолчанию — включаем тумблером в настройках.
  await visible(page, "settings-trigger-desktop").click();
  await visible(page, "setting-show-item-numbers").click();

  const card = listCard(page, list.id);
  await expect(card.getByTestId("item-number")).toHaveText(["1.", "2.", "3."]);

  // Выполненная запись номер теряет, остальные пересчитываются без записи в БД.
  await itemRow(card, second.id).getByTestId("item-toggle").click();
  await expect(card.getByTestId("item-number")).toHaveText(["1.", "2.", ""]);

  // Настройка живёт в localStorage и переживает перезагрузку.
  await page.reload();
  await expect(listCard(page, list.id).getByTestId("item-number")).toHaveText([
    "1.",
    "2.",
    "",
  ]);
});

test("удаление записи требует подтверждения", async ({ page, user, db }) => {
  const list = await makeList(db, user.id, user.defaultSpaceId);
  const [item] = await makeItems(db, list.id, ["Лишняя", "Нужная"]);
  await openSpace(page, user);

  const card = listCard(page, list.id);
  const menu = await openItemMenu(card, item.id);
  await menu.getByTestId("item-delete").click();
  await expect(visible(page, "item-delete-modal")).toBeVisible();
  await visible(page, "item-delete-confirm").click();

  await expect(itemRow(card, item.id)).toHaveCount(0);

  await page.reload();
  await expect(listCard(page, list.id).getByTestId("item-name")).toHaveText([
    "Нужная",
  ]);
  expect(await db.item.count({ where: { id: item.id } })).toBe(0);
});

test("список на потолке не принимает новую запись", async ({ page, user, db }) => {
  const list = await makeList(db, user.id, user.defaultSpaceId);
  // Наполняем одним запросом: проверяется граница, а не путь наполнения.
  await db.item.createMany({
    data: Array.from({ length: MAX_ITEMS_PER_LIST }, (_, index) => ({
      listId: list.id,
      name: `Запись ${index + 1}`,
      position: index + 1,
    })),
  });
  await openSpace(page, user);

  const card = listCard(page, list.id);
  await card.getByTestId("add-item-input").fill("Лишняя");
  await card.getByTestId("add-item-submit").click();

  // Селектор структурный, а не по тексту: сообщение переводится на четыре языка.
  await expect(page.locator('[role="status"]').first()).toBeVisible();

  // Оптимистичная запись откатилась, в базе её нет.
  await expect(
    card.getByTestId("item-name").filter({ hasText: "Лишняя" }),
  ).toHaveCount(0);
  expect(await db.item.count({ where: { listId: list.id } })).toBe(
    MAX_ITEMS_PER_LIST,
  );
});

test("начатый пункт сохраняет порядок и состояние после перезагрузки", async ({ page, user, db }) => {
  const list = await makeList(db, user.id, user.defaultSpaceId);
  const [, second] = await makeItems(db, list.id, ["Первая", "Вторая", "Третья"]);
  await openSpace(page, user);
  let card = listCard(page, list.id);
  await (await openItemMenu(card, second.id)).getByTestId("item-progress-action").click();
  await expect(itemRow(card, second.id).getByTestId("item-progress-indicator")).toBeVisible();
  await expect(itemRow(card, second.id).getByTestId("item-toggle")).toHaveAttribute("aria-checked", "mixed");
  await expect(card.getByTestId("item-progress-badge")).toHaveCount(0);
  await itemRow(card, second.id).getByTestId("item-toggle").hover();
  await expect(page.getByTestId("tooltip")).toBeVisible();
  await page.mouse.move(0, 0);
  await expect.poll(() => itemNames(card)).toEqual(["Первая", "Вторая", "Третья"]);
  await expect.poll(async () => (await db.item.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("IN_PROGRESS");
  await page.reload();
  card = listCard(page, list.id);
  await expect(itemRow(card, second.id).getByTestId("item-progress-indicator")).toBeVisible();
  await (await openItemMenu(card, second.id)).getByTestId("item-progress-action").click();
  await expect(itemRow(card, second.id).getByTestId("item-progress-indicator")).toHaveCount(0);
  await expect.poll(async () => (await db.item.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("NOT_STARTED");
  await (await openItemMenu(card, second.id)).getByTestId("item-progress-action").click();
  await expect(itemRow(card, second.id).getByTestId("item-progress-indicator")).toBeVisible();
  await itemRow(card, second.id).getByTestId("item-toggle").click();
  await expect(itemRow(card, second.id).getByTestId("item-toggle")).toHaveAttribute("data-completed", "true");
  await expect.poll(async () => (await db.item.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("COMPLETED");
  await expect(itemRow(card, second.id).getByTestId("item-progress-indicator")).toHaveCount(0);
});

test("отметка работы видна на мобильном экране в обеих темах", async ({ page, user, db }, testInfo) => {
  const list = await makeList(db, user.id, user.defaultSpaceId);
  const [item] = await makeItems(db, list.id, ["Подготовить материалы для встречи"]);
  await db.item.update({ where: { id: item.id }, data: { status: "IN_PROGRESS" } });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ["light", "dark"]) {
    await openSpace(page, user);
    await page.evaluate((value) => localStorage.setItem("theme", value), theme);
    await page.reload();
    const card = listCard(page, list.id);
    const row = itemRow(card, item.id);
    await expect(row.getByTestId("item-progress-indicator")).toBeVisible();
    await expect(row.getByTestId("item-toggle")).toHaveAttribute("aria-checked", "mixed");
    await expect(page.locator("html")).toHaveClass(new RegExp(theme));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("progress-" + theme + ".png") });
  }
});
