/**
 * @file lists.e2e.ts
 * @description Жизненный цикл списка через интерфейс.
 *
 * Каждый шаг проверяется дважды: сразу после действия (оптимистичный рендер) и
 * после перезагрузки страницы. Расхождение между ними — самый частый способ
 * сломать связку Action → revalidatePath → RSC payload: на экране всё выглядит
 * правильно, но в базу ничего не легло.
 */

import { expect, test } from "./fixtures";
import { makeItems, makeList } from "./factories";
import {
  createList,
  itemRow,
  listCard,
  onlyListCard,
  openListMenu,
  openSpace,
  visible,
} from "./helpers";

test("созданный список переживает перезагрузку", async ({ page, user, db }) => {
  await openSpace(page, user);

  await createList(page, "Покупки на неделю");

  await page.reload();
  await expect(onlyListCard(page).getByTestId("list-title")).toHaveText(
    "Покупки на неделю",
  );

  // Список привязан к пространству, из которого его создали.
  const stored = await db.list.findFirst({ where: { ownerId: user.id } });
  expect(stored?.spaceId).toBe(user.defaultSpaceId);
});

test("список переименовывается по клику на название", async ({ page, user, db }) => {
  const list = await makeList(db, user.id, user.defaultSpaceId, {
    title: "Старое название",
  });
  await openSpace(page, user);

  const card = listCard(page, list.id);
  await card.getByTestId("list-title").click();
  await card.getByTestId("list-title-input").fill("Новое название");
  await card.getByTestId("list-title-input").press("Enter");

  await expect(card.getByTestId("list-title")).toHaveText("Новое название");

  await page.reload();
  await expect(listCard(page, list.id).getByTestId("list-title")).toHaveText(
    "Новое название",
  );
});

test("Escape отменяет переименование", async ({ page, user, db }) => {
  const list = await makeList(db, user.id, user.defaultSpaceId, {
    title: "Останется как было",
  });
  await openSpace(page, user);

  const card = listCard(page, list.id);
  await card.getByTestId("list-title").click();
  await card.getByTestId("list-title-input").fill("Случайный ввод");
  await card.getByTestId("list-title-input").press("Escape");

  await expect(card.getByTestId("list-title")).toHaveText("Останется как было");

  await page.reload();
  await expect(listCard(page, list.id).getByTestId("list-title")).toHaveText(
    "Останется как было",
  );
});

test("удаление списка требует подтверждения", async ({ page, user, db }) => {
  const list = await makeList(db, user.id, user.defaultSpaceId, {
    title: "Список под удаление",
  });
  await openSpace(page, user);

  const card = listCard(page, list.id);
  const menu = await openListMenu(card);
  await menu.getByTestId("list-delete").click();

  // Отмена оставляет список на месте.
  await expect(visible(page, "confirm-modal")).toBeVisible();
  await visible(page, "confirm-modal-cancel").click();
  await expect(visible(page, "confirm-modal")).toHaveCount(0);
  await expect(card).toBeVisible();

  const menuAgain = await openListMenu(card);
  await menuAgain.getByTestId("list-delete").click();
  await visible(page, "confirm-modal-confirm").click();

  await expect(card).toHaveCount(0);

  await page.reload();
  await expect(listCard(page, list.id)).toHaveCount(0);
  await expect(visible(page, "lists-empty")).toBeVisible();

  expect(await db.list.count({ where: { id: list.id } })).toBe(0);
});

test("счётчик выполненных виден по умолчанию и выключается в настройках", async ({
  page,
  user,
  db,
}) => {
  // Свёрнутая карточка проверяется здесь же: тумблер один на оба состояния, и
  // разъехаться они могут только вместе с этой проверкой.
  const list = await makeList(db, user.id, user.defaultSpaceId);
  const [first] = await makeItems(db, list.id, ["Раз", "Два", "Три"]);
  await openSpace(page, user);

  const card = listCard(page, list.id);
  await expect(card.getByTestId("list-items-counter")).toHaveText("0 / 3");

  // Отметка записи двигает счётчик, не дожидаясь перезагрузки.
  await itemRow(card, first.id).getByTestId("item-toggle").click();
  await expect(card.getByTestId("list-items-counter")).toHaveText("1 / 3");

  await visible(page, "settings-trigger-desktop").click();
  await visible(page, "setting-show-items-counter").click();
  await expect(card.getByTestId("list-items-counter")).toHaveCount(0);

  // У свёрнутой карточки счётчика тоже нет: настройка одна на всё приложение.
  await card.getByTestId("list-collapse-toggle").click();
  await expect(card).toHaveAttribute("data-collapsed", "true");
  await expect(card.getByTestId("list-items-counter")).toHaveCount(0);

  // Настройка живёт в localStorage и переживает перезагрузку.
  await page.reload();
  await expect(listCard(page, list.id).getByTestId("list-items-counter")).toHaveCount(0);
});

test("раскладка даёт три колонки на десктопе, две на среднем экране и одну на телефоне", async ({
  page,
  user,
  db,
}) => {
  // Колонки собраны вручную: три куска в разметке, а число видимых колонок
  // задаёт CSS через `display: contents`. Две колонки — единственный случай,
  // который включается уже после гидрации, поэтому проверяются все три ширины.
  const lists = await Promise.all(
    Array.from({ length: 6 }, (_, index) => index).map((index) =>
      makeList(db, user.id, user.defaultSpaceId, { title: `Список ${index}` }),
    ),
  );

  /** Число различных левых границ карточек — столько колонок и видно. */
  const visibleColumns = async () => {
    const positions = await Promise.all(
      lists.map(async (list) => {
        const box = await listCard(page, list.id).boundingBox();
        return box ? Math.round(box.x) : -1;
      }),
    );
    return new Set(positions).size;
  };

  await page.setViewportSize({ width: 1400, height: 900 });
  await openSpace(page, user);
  await expect.poll(visibleColumns).toBe(3);

  // Середина: CSS сам собрать две колонки из трёх кусков не может, их включает
  // подписка на медиа-запрос после гидрации.
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect.poll(visibleColumns).toBe(2);

  await page.setViewportSize({ width: 500, height: 900 });
  await expect.poll(visibleColumns).toBe(1);

  // Возврат на десктоп восстанавливает три колонки: подписка живёт всё время.
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect.poll(visibleColumns).toBe(3);
});

test("списки другого пространства не видны", async ({ page, user, db }) => {
  const list = await makeList(db, user.id, user.defaultSpaceId, {
    title: "Только в основном",
  });
  const other = await db.space.create({
    data: { userId: user.id, name: "Работа", normalizedName: "работа" },
  });

  await openSpace(page, user, other.id);

  await expect(listCard(page, list.id)).toHaveCount(0);
  await expect(visible(page, "lists-empty")).toBeVisible();
});

test("AI выключается из меню списка и кнопка исчезает", async ({ page, user, db }) => {
  const list = await makeList(db, user.id, user.defaultSpaceId, { title: "С инсайтом" });
  await openSpace(page, user);

  const card = listCard(page, list.id);

  // Строка о передаче данных видна до всякого запроса: она адресована и тому,
  // кто инсайт не запрашивает.
  await card.getByTestId("ai-insight-button").click();
  await expect(card.getByTestId("ai-privacy-notice")).toContainText("Vertex AI");

  const menu = await openListMenu(card);
  await menu.getByTestId("list-ai-toggle").click();

  await expect(card.getByTestId("ai-insight-button")).toHaveCount(0);
  await expect
    .poll(async () =>
      (await db.list.findUnique({ where: { id: list.id }, select: { aiEnabled: true } }))
        ?.aiEnabled,
    )
    .toBe(false);

  await page.reload();
  await expect(listCard(page, list.id).getByTestId("ai-insight-button")).toHaveCount(0);

  // Обратное включение возвращает кнопку — состояние не одностороннее.
  const menuAgain = await openListMenu(listCard(page, list.id));
  await menuAgain.getByTestId("list-ai-toggle").click();
  await expect(
    listCard(page, list.id).getByTestId("ai-insight-button"),
  ).toBeVisible();
});
