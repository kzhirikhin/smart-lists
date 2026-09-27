/**
 * @file insights.int.test.ts
 * @description Контекст, уезжающий во внешний AI-сервис.
 *
 * Сам сервис не поднимается — проверяется ровно то, что формирует приложение:
 * какие записи попали в запрос, в каком виде и что сказано в `notes_meta`.
 * Это единственная часть AI-потока, которая ломается тихо: ответ модели всё
 * равно придёт, просто он будет построен не по тем данным.
 *
 * `fetch` подменяется шпионом: настоящий вызов ушёл бы в сеть, а нам нужен
 * только его аргумент.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getListInsight } from "@/app/actions/insights";
import { MAX_INSIGHT_GROUPS, MAX_INSIGHT_ITEMS } from "@/lib/notes";
import { prisma, setSessionUser } from "./setup";
import { makeItem, makeList, makeUser, shareList } from "./factories";

/**
 * Федерация в тестах не поднимается: настоящий обмен пошёл бы в STS Google.
 * Подменяем сам выпуск токена — проверяем не его получение, а то, каким
 * запрос уходит с токеном и без него.
 */
const { idTokenMock } = vi.hoisted(() => ({
  // Сигнатура повторяет настоящую: audience — часть контракта, и тест на связку
  // адреса с токеном читает именно этот аргумент.
  idTokenMock: vi.fn<(audience: string) => Promise<string | null>>(),
}));

vi.mock("@/lib/gcp-auth", () => ({
  getCloudRunIdToken: idTokenMock,
}));

/** Форма запроса к сервису — ровно то, что проверяют тесты. */
type InsightRequest = {
  title: string;
  groups: string[];
  list_note: string | null;
  items: Array<{
    name: string;
    is_completed: boolean;
    note: string | null;
    sub_items: Array<{ name: string; is_completed: boolean; note: string | null }>;
  }>;
  notes_meta: {
    list_note_included: boolean;
    included_item_notes: number;
    omitted_item_notes: number;
  };
  user_message: string | null;
  response_language: "ru" | "vi" | "en" | "ja";
};

/** Живая форма адреса Cloud Run — та же, что проверяет `insights-service-url`. */
const SERVICE_URL = "https://insights-api-912709146180.us-central1.run.app";

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Адрес обязан быть настоящей формы: с 08-31 Action проверяет его до отправки
  // (A68), и произвольный тестовый хост запрос бы не выпустил.
  process.env.INSIGHTS_SERVICE_URL = SERVICE_URL;

  // По умолчанию токен выпускается: это нормальное состояние, и без него
  // запрос к сервису вообще не уходит. Отсутствие токена проверяется отдельно.
  idTokenMock.mockReset();
  idTokenMock.mockResolvedValue("test-id-token");

  fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ insight: "ok" }),
  }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Тело последнего запроса к сервису. */
function lastRequest(): InsightRequest {
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [, init] = fetchSpy.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body) as InsightRequest;
}

describe("контекст AI — уровни", () => {
  it("шлёт подпункты вложенными, а не отдельными записями", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId, { title: "Ужин" });
    const parent = await makeItem(list.id, { name: "Приготовить" });
    await makeItem(list.id, { name: "Купить продукты", parentId: parent.id });
    await makeItem(list.id, { name: "Нарезать салат", parentId: parent.id });
    await makeItem(list.id, { name: "Убрать со стола" });
    setSessionUser(user.id);

    const result = await getListInsight(list.id, undefined, user.defaultSpaceId);
    expect(result.error).toBeUndefined();

    const request = lastRequest();
    expect(request.items.map((item) => item.name)).toEqual([
      "Приготовить",
      "Убрать со стола",
    ]);
    expect(request.items[0].sub_items.map((subItem) => subItem.name)).toEqual([
      "Купить продукты",
      "Нарезать салат",
    ]);
    expect(request.items[1].sub_items).toEqual([]);
  });

  it("отметка пункта считается по подпунктам, а не по полю строки", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    // Кеш в строке намеренно расходится с подпунктами: в контексте для модели
    // ему доверять незачем.
    const parent = await makeItem(list.id, { name: "Ужин", isCompleted: true });
    await makeItem(list.id, {
      name: "Купить",
      parentId: parent.id,
      isCompleted: true,
    });
    await makeItem(list.id, { name: "Готовить", parentId: parent.id });
    setSessionUser(user.id);

    await getListInsight(list.id, undefined, user.defaultSpaceId);

    const [item] = lastRequest().items;
    expect(item.is_completed).toBe(false);
    // Порядок тот же, что видит пользователь: невыполненные сверху.
    expect(
      item.sub_items.map((subItem) => [subItem.name, subItem.is_completed]),
    ).toEqual([
      ["Готовить", false],
      ["Купить", true],
    ]);
  });

  it("подпункты не расходуют лимит пунктов", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await prisma.item.createMany({
      data: Array.from({ length: MAX_INSIGHT_ITEMS }, (_, index) => ({
        listId: list.id,
        name: `Пункт ${index + 1}`,
        position: index + 1,
      })),
    });
    const first = await prisma.item.findFirstOrThrow({
      where: { listId: list.id, name: "Пункт 1" },
    });
    await makeItem(list.id, { name: "Подпункт", parentId: first.id });
    setSessionUser(user.id);

    await getListInsight(list.id, undefined, user.defaultSpaceId);

    const request = lastRequest();
    expect(request.items).toHaveLength(MAX_INSIGHT_ITEMS);
    expect(request.items[0].sub_items).toHaveLength(1);
  });

  it("подпункт без своего пункта в контекст не попадает", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await prisma.item.createMany({
      data: Array.from({ length: MAX_INSIGHT_ITEMS }, (_, index) => ({
        listId: list.id,
        name: `Пункт ${index + 1}`,
        position: index + 1,
      })),
    });
    // Этот пункт за пределами лимита, значит и его подпункт бессмысленнен.
    const extra = await makeItem(list.id, {
      name: "Лишний",
      position: MAX_INSIGHT_ITEMS + 1,
    });
    await makeItem(list.id, { name: "Его подпункт", parentId: extra.id });
    setSessionUser(user.id);

    await getListInsight(list.id, undefined, user.defaultSpaceId);

    const request = lastRequest();
    expect(request.items.map((item) => item.name)).not.toContain("Лишний");
    expect(
      request.items.flatMap((item) => item.sub_items.map((s) => s.name)),
    ).not.toContain("Его подпункт");
  });
});

describe("контекст AI — заметки", () => {
  it("заметка подпункта уезжает вместе с ним и попадает в счётчик", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    const parent = await makeItem(list.id, { name: "Ужин" });
    const subItem = await makeItem(list.id, {
      name: "Купить",
      parentId: parent.id,
    });
    await prisma.item.update({
      where: { id: subItem.id },
      data: { note: "Взять безлактозное", noteUpdatedAt: new Date() },
    });
    setSessionUser(user.id);

    await getListInsight(list.id, undefined, user.defaultSpaceId);

    const request = lastRequest();
    expect(request.items[0].sub_items[0].note).toBe("Взять безлактозное");
    expect(request.notes_meta.included_item_notes).toBe(1);
    expect(request.notes_meta.omitted_item_notes).toBe(0);
  });

  it("заметка отброшенного подпункта считается пропущенной", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await prisma.item.createMany({
      data: Array.from({ length: MAX_INSIGHT_ITEMS }, (_, index) => ({
        listId: list.id,
        name: `Пункт ${index + 1}`,
        position: index + 1,
      })),
    });
    const extra = await makeItem(list.id, {
      name: "Лишний",
      position: MAX_INSIGHT_ITEMS + 1,
    });
    const subItem = await makeItem(list.id, {
      name: "Его подпункт",
      parentId: extra.id,
    });
    await prisma.item.update({
      where: { id: subItem.id },
      data: { note: "Не уедет", noteUpdatedAt: new Date() },
    });
    setSessionUser(user.id);

    await getListInsight(list.id, undefined, user.defaultSpaceId);

    // Заметка вошла в символьный бюджет, но в запрос не попала: сообщение
    // пользователю должно говорить о фактически отправленном.
    const request = lastRequest();
    expect(request.notes_meta.included_item_notes).toBe(0);
    expect(request.notes_meta.omitted_item_notes).toBe(1);
  });
});

describe("scoped-доступ и суточная квота", () => {
  it("чужое пространство выглядит как отсутствующий список и не тратит квоту", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const list = await makeList(owner.id, owner.defaultSpaceId);
    setSessionUser(stranger.id);

    const result = await getListInsight(
      list.id,
      undefined,
      owner.defaultSpaceId,
    );

    expect(result).toEqual({ error: "Список не найден" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      await prisma.userDailyUsage.count({ where: { userId: stranger.id } }),
    ).toBe(0);
  });

  it("параллельные запросы атомарно соблюдают лимит и откатывают лишний инкремент", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await makeItem(list.id, { name: "Пункт" });
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    await prisma.userDailyUsage.create({
      data: { userId: user.id, date: today, insights: 14 },
    });
    setSessionUser(user.id);

    const results = await Promise.all([
      getListInsight(list.id, undefined, user.defaultSpaceId),
      getListInsight(list.id, undefined, user.defaultSpaceId),
    ]);

    expect(results.filter((result) => result.insight === "ok")).toHaveLength(1);
    expect(
      results.filter((result) => result.error === "rateLimitError"),
    ).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(
      await prisma.userDailyUsage.findUnique({
        where: { userId_date: { userId: user.id, date: today } },
        select: { insights: true },
      }),
    ).toEqual({ insights: 15 });
  });
});

describe("аутентификация вызова Cloud Run", () => {
  /** Заголовки последнего запроса к сервису. */
  function lastHeaders(): Record<string, string> {
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    return init.headers;
  }

  it("шлёт ID-токен в обычном Authorization и больше ничего", async () => {
    idTokenMock.mockResolvedValue("id-token-value");
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await makeItem(list.id, { name: "Пункт" });
    setSessionUser(user.id);

    await getListInsight(list.id, undefined, user.defaultSpaceId);

    const headers = lastHeaders();
    // Именно Authorization: из X-Serverless-Authorization Cloud Run вырезает
    // подпись, и сервис не смог бы проверить токен сам.
    expect(headers.Authorization).toBe("Bearer id-token-value");
    expect(headers["X-Serverless-Authorization"]).toBeUndefined();
  });

  it("audience токена — базовый URL сервиса, а не путь запроса", async () => {
    idTokenMock.mockResolvedValue("id-token-value");
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await makeItem(list.id, { name: "Пункт" });
    setSessionUser(user.id);

    await getListInsight(list.id, undefined, user.defaultSpaceId);

    // Cloud Run сверяет `aud` с адресом сервиса; `/insights` в нём быть не должно.
    expect(idTokenMock).toHaveBeenCalledWith(SERVICE_URL);
  });

  it("токен выписывается ровно на тот хост, куда уходит запрос", async () => {
    idTokenMock.mockResolvedValue("id-token-value");
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await makeItem(list.id, { name: "Пункт" });
    setSessionUser(user.id);

    await getListInsight(list.id, undefined, user.defaultSpaceId);

    // Сторож против «наведения порядка» в будущем. Сейчас `audience` выводится
    // из того же значения, что и адрес запроса, и именно это делает утёкший
    // токен бесполезным: он выписан на хост получателя, поэтому настоящему
    // сервису его не предъявить. Рефакторинг, выносящий audience в отдельную
    // константу или переменную, вернул бы токен, годный для повторного
    // использования, и выглядел бы в диффе как аккуратное улучшение.
    // Ожидание берётся из фактических вызовов, а не из литерала: связка должна
    // ломать тест при любых значениях, а не только при этих.
    const [requestUrl] = fetchSpy.mock.calls[0] as [string, unknown];
    const [audience] = idTokenMock.mock.calls[0] as [string];
    expect(requestUrl).toBe(`${audience}/insights`);
  });

  it("не отправляет запрос, если адрес сервиса не прошёл проверку", async () => {
    process.env.INSIGHTS_SERVICE_URL = "https://insights-api-x.run.app.evil.example";
    idTokenMock.mockResolvedValue("id-token-value");
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await makeItem(list.id, { name: "Пункт" });
    setSessionUser(user.id);

    const result = await getListInsight(list.id, undefined, user.defaultSpaceId);

    // Ни запроса, ни токена: отказ наступает до того, как содержимое списка
    // куда-либо собирается, и до списания дневной квоты.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(idTokenMock).not.toHaveBeenCalled();
    expect(result.error).toBe("Service not configured");
  });

  it("без токена запрос не отправляется вовсе", async () => {
    idTokenMock.mockResolvedValue(null);
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await makeItem(list.id, { name: "Пункт" });
    setSessionUser(user.id);

    const result = await getListInsight(list.id, undefined, user.defaultSpaceId);

    // Отправлять нечего: без токена Cloud Run ответит отказом гарантированно.
    // Ошибка приходит от приложения, чтобы в логе была видна сломанная
    // федерация, а не безымянный 403 из сети.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.error).toBe("Service not configured");
  });

  it("секрет сервиса больше не участвует в запросе", async () => {
    // Переменная намеренно выставляется здесь и только здесь: ни в одном
    // окружении её больше нет, и тест проверяет не её отсутствие, а то, что
    // возвращённая обратно она всё равно никуда не уедет.
    process.env.INSIGHTS_SERVICE_SECRET = "должен-остаться-неиспользованным";
    idTokenMock.mockResolvedValue("id-token-value");
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await makeItem(list.id, { name: "Пункт" });
    setSessionUser(user.id);

    await getListInsight(list.id, undefined, user.defaultSpaceId);

    expect(JSON.stringify(lastHeaders())).not.toContain("должен-остаться");

    // Убираем за собой: значение не должно пережить этот тест и создать
    // видимость настроенного секрета в следующих.
    delete process.env.INSIGHTS_SERVICE_SECRET;
  });
});

describe("контекст AI — границы состава", () => {
  /**
   * Тест на точный набор ключей, а не на отсутствие конкретного лишнего поля.
   * Утечка в этом потоке выглядит не как ошибка, а как удобство: добавить в
   * выборку `id`, чтобы что-то связать, или `email`, чтобы обратиться по имени.
   * Явный список заставляет расширение состава быть намеренным — и заодно
   * напоминает, что менять его нужно вместе с privacy-notice и моделью угроз.
   */
  it("не отправляет ничего сверх согласованного состава", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId, { title: "Ремонт" });
    await prisma.list.update({
      where: { id: list.id },
      data: { note: "Заметка списка" },
    });
    const parent = await makeItem(list.id, { name: "Плитка" });
    const subItem = await makeItem(list.id, { name: "Затирка", parentId: parent.id });
    await prisma.item.update({
      where: { id: parent.id },
      data: { note: "Заметка записи", noteUpdatedAt: new Date() },
    });
    const group = await prisma.listGroup.create({
      data: {
        userId: user.id,
        spaceId: user.defaultSpaceId,
        name: "Дом",
        position: 1,
        listMemberships: { create: { listId: list.id, position: 1 } },
      },
    });
    setSessionUser(user.id);

    await getListInsight(list.id, "С чего начать?", user.defaultSpaceId, "ru");

    const body = lastRequest();
    expect(Object.keys(body).sort()).toEqual([
      "groups",
      "items",
      "list_note",
      "notes_meta",
      "response_language",
      "title",
      "user_message",
    ]);
    expect(body.response_language).toBe("ru");
    expect(Object.keys(body.items[0]).sort()).toEqual([
      "is_completed",
      "name",
      "note",
      "sub_items",
    ]);
    expect(Object.keys(body.items[0].sub_items[0]).sort()).toEqual([
      "is_completed",
      "name",
      "note",
    ]);
    expect(Object.keys(body.notes_meta).sort()).toEqual([
      "included_item_notes",
      "list_note_included",
      "omitted_item_notes",
    ]);

    // Ни одного идентификатора: ни списка, ни записей, ни группы, ни самого
    // пользователя. Модель получает содержимое, но не может связать его с
    // человеком, а логи AI-провайдера — сопоставить два запроса одного владельца.
    const serialized = JSON.stringify(body);
    for (const identifier of [
      list.id,
      parent.id,
      subItem.id,
      group.id,
      user.id,
      user.email,
      user.defaultSpaceId,
    ]) {
      expect(serialized).not.toContain(identifier);
    }
  });
});

describe("контракт ответа AI-сервиса", () => {
  async function makeAccessibleList() {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await makeItem(list.id, { name: "Пункт" });
    setSessionUser(user.id);
    return { user, list };
  }

  it.each([
    ["без поля insight", {}],
    ["с полем другого типа", { insight: 42 }],
    ["с пустой строкой", { insight: "   " }],
    ["со строкой длиннее лимита", { insight: "x".repeat(20_001) }],
  ])("отклоняет ответ %s", async (_caseName, responseData) => {
    const { user, list } = await makeAccessibleList();
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => responseData,
    });

    const result = await getListInsight(
      list.id,
      undefined,
      user.defaultSpaceId,
    );

    expect(result).toEqual({ error: "Service error" });
  });

  it("не относит невалидный JSON к сетевой ошибке", async () => {
    const { user, list } = await makeAccessibleList();
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("invalid JSON");
      },
    });

    const result = await getListInsight(
      list.id,
      undefined,
      user.defaultSpaceId,
    );

    expect(result).toEqual({ error: "Service error" });
  });
});

describe("контекст AI — группы", () => {
  it("шлёт группы вызывающего в том порядке, в каком тот их видит", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId, { title: "Ремонт" });
    await makeItem(list.id, { name: "Купить плитку" });
    for (const [index, name] of ["Дом", "Работа"].entries()) {
      await prisma.listGroup.create({
        data: {
          userId: user.id,
          spaceId: user.defaultSpaceId,
          name,
          position: index + 1,
          listMemberships: { create: { listId: list.id, position: 1 } },
        },
      });
    }
    setSessionUser(user.id);

    await getListInsight(list.id, undefined, user.defaultSpaceId);

    expect(lastRequest().groups).toEqual(["Дом", "Работа"]);
  });

  it("не шлёт группы, в которых список не состоит", async () => {
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await makeItem(list.id, { name: "Пункт" });
    await prisma.listGroup.create({
      data: {
        userId: user.id,
        spaceId: user.defaultSpaceId,
        name: "Посторонняя группа",
        position: 1,
      },
    });
    setSessionUser(user.id);

    await getListInsight(list.id, undefined, user.defaultSpaceId);

    expect(lastRequest().groups).toEqual([]);
  });

  it("не раскрывает группы другого участника расшаренного списка", async () => {
    // Группы персональные, а инсайт читает тот, кто его запросил. Название
    // чужой группы — личная организация её владельца, и в контекст оно
    // попасть не должно ни при каких условиях.
    const owner = await makeUser();
    const member = await makeUser();
    const list = await makeList(owner.id, owner.defaultSpaceId);
    await makeItem(list.id, { name: "Пункт" });
    await shareList(list.id, member.id, member.defaultSpaceId);

    await prisma.listGroup.create({
      data: {
        userId: owner.id,
        spaceId: owner.defaultSpaceId,
        name: "Кандидаты на увольнение",
        position: 1,
        listMemberships: { create: { listId: list.id, position: 1 } },
      },
    });
    await prisma.listGroup.create({
      data: {
        userId: member.id,
        spaceId: member.defaultSpaceId,
        name: "Мои задачи",
        position: 1,
        listMemberships: { create: { listId: list.id, position: 1 } },
      },
    });

    setSessionUser(member.id);
    await getListInsight(list.id, undefined, member.defaultSpaceId);

    expect(lastRequest().groups).toEqual(["Мои задачи"]);
    expect(JSON.stringify(lastRequest())).not.toContain("увольнение");
  });

  it("обрезает число групп до лимита сервиса", async () => {
    // Групп в пространстве бывает больше, чем принимает сервис: превышение
    // отбраковало бы весь запрос, а не лишние элементы.
    const user = await makeUser();
    const list = await makeList(user.id, user.defaultSpaceId);
    await makeItem(list.id, { name: "Пункт" });
    for (let index = 0; index < MAX_INSIGHT_GROUPS + 5; index += 1) {
      await prisma.listGroup.create({
        data: {
          userId: user.id,
          spaceId: user.defaultSpaceId,
          name: `Группа ${index}`,
          position: index + 1,
          listMemberships: { create: { listId: list.id, position: 1 } },
        },
      });
    }
    setSessionUser(user.id);

    await getListInsight(list.id, undefined, user.defaultSpaceId);

    expect(lastRequest().groups).toHaveLength(MAX_INSIGHT_GROUPS);
  });
});
