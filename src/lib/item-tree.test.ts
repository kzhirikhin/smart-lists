import { describe, expect, it } from "vitest";

import { applyCompletion, applyItemStatus, buildItemTree } from "@/lib/item-tree";

type TestItem = {
  id: string;
  parentId: string | null;
  isCompleted: boolean;
};

/** Компактный конструктор записи: `item("a")`, `item("a1", "a", true)`. */
function item(id: string, parentId: string | null = null, isCompleted = false): TestItem {
  return { id, parentId, isCompleted };
}

/** Плоское представление дерева для читаемых ожиданий: ["1 a", "1.1 a1", "— a2"]. */
function outline(items: TestItem[]): string[] {
  const { nodes } = buildItemTree(items);
  return nodes.flatMap((node) => [
    `${node.number ?? "—"} ${node.item.id}`,
    ...node.subItems.map(
      (sub) => `${node.number ?? "—"}.${sub.number ?? "—"} ${sub.item.id}`,
    ),
  ]);
}

describe("buildItemTree — уровни и порядок", () => {
  it("сохраняет порядок пунктов верхнего уровня", () => {
    expect(outline([item("a"), item("b"), item("c")])).toEqual(["1 a", "2 b", "3 c"]);
  });

  it("группирует подпункты под родителем в исходном порядке", () => {
    const items = [item("a"), item("a1", "a"), item("a2", "a"), item("b")];
    expect(outline(items)).toEqual(["1 a", "1.1 a1", "1.2 a2", "2 b"]);
  });

  it("собирает подпункты, даже если они лежат не рядом с родителем", () => {
    // Позиции сравнимы только внутри своей группы, поэтому в общей выборке
    // подпункты могут перемежаться с чужими пунктами.
    const items = [item("a"), item("b"), item("a1", "a"), item("b1", "b")];
    expect(outline(items)).toEqual(["1 a", "1.1 a1", "2 b", "2.1 b1"]);
  });

  it("выполненные пункты уходят вниз вместе со своими подпунктами", () => {
    const items = [
      item("done", null, true),
      item("done1", "done", true),
      item("open"),
    ];
    expect(outline(items)).toEqual(["1 open", "— done", "—.— done1"]);
  });

  it("выполненные подпункты уходят в конец своей секции и теряют номер", () => {
    const items = [
      item("a"),
      item("a1", "a", true),
      item("a2", "a"),
      item("a3", "a"),
    ];
    expect(outline(items)).toEqual(["1 a", "1.1 a2", "1.2 a3", "1.— a1"]);
  });
});

describe("buildItemTree — производная отметка выполнения", () => {
  it("пункт выполнен, когда выполнены все подпункты", () => {
    // Собственное поле пункта намеренно false: на чтении оно не используется.
    const items = [item("a"), item("a1", "a", true), item("a2", "a", true)];
    expect(buildItemTree(items).nodes[0].isCompleted).toBe(true);
  });

  it("пункт не выполнен, пока хоть один подпункт не выполнен", () => {
    const items = [item("a", null, true), item("a1", "a", true), item("a2", "a")];
    expect(buildItemTree(items).nodes[0].isCompleted).toBe(false);
  });

  it("пункт без подпунктов сохраняет собственную отметку", () => {
    // Пустое множество подпунктов не делает пункт выполненным: «все ноль
    // выполнены» истинно формально, но означало бы, что нажатие «разбить на
    // подпункты» само отмечает пункт.
    expect(buildItemTree([item("a")]).nodes[0].isCompleted).toBe(false);
    expect(buildItemTree([item("a", null, true)]).nodes[0].isCompleted).toBe(true);
  });
});

describe("buildItemTree — счётчики", () => {
  it("считает только верхний уровень", () => {
    const items = [
      item("a", null, true),
      item("a1", "a", true),
      item("a2", "a", true),
      item("b"),
      item("b1", "b"),
    ];
    const tree = buildItemTree(items);
    expect(tree.totalCount).toBe(2);
    expect(tree.completedCount).toBe(1);
    expect(tree.activeCount).toBe(1);
  });

  it("частично выполненный пункт считается невыполненным", () => {
    const items = [item("a"), item("a1", "a", true), item("a2", "a")];
    const tree = buildItemTree(items);
    expect(tree.completedCount).toBe(0);
    expect(tree.totalCount).toBe(1);
  });
});

describe("buildItemTree — устойчивость к неверным ссылкам", () => {
  it("подпункт подпункта поднимается на верхний уровень", () => {
    // Глубину проверяет Server Action; если такие данные всё же появились,
    // показать запись не на своём уровне лучше, чем потерять её.
    const items = [item("a"), item("a1", "a"), item("a1x", "a1")];
    expect(outline(items)).toEqual(["1 a", "1.1 a1", "2 a1x"]);
  });

  it("ссылка на несуществующего родителя не теряет запись", () => {
    expect(outline([item("a"), item("orphan", "missing")])).toEqual([
      "1 a",
      "2 orphan",
    ]);
  });

  it("ссылка на саму себя не теряет запись и не зацикливается", () => {
    expect(outline([item("a", "a")])).toEqual(["1 a"]);
  });
});

describe("applyCompletion — от пункта к подпунктам", () => {
  it("отметка пункта отмечает все его подпункты", () => {
    const items = [item("a"), item("a1", "a"), item("a2", "a", true), item("b")];
    const next = applyCompletion(items, "a", true);
    expect(next.map((i) => [i.id, i.isCompleted])).toEqual([
      ["a", true],
      ["a1", true],
      ["a2", true],
      ["b", false],
    ]);
  });

  it("снятие отметки с пункта снимает её со всех подпунктов", () => {
    const items = [item("a", null, true), item("a1", "a", true), item("a2", "a", true)];
    const next = applyCompletion(items, "a", false);
    expect(next.every((i) => !i.isCompleted)).toBe(true);
  });

  it("пункт без подпунктов меняет только себя", () => {
    const items = [item("a"), item("b")];
    const next = applyCompletion(items, "a", true);
    expect(next.map((i) => i.isCompleted)).toEqual([true, false]);
  });
});

describe("applyCompletion — от подпунктов к пункту", () => {
  it("отметка последнего невыполненного подпункта отмечает пункт", () => {
    const items = [item("a"), item("a1", "a", true), item("a2", "a")];
    const next = applyCompletion(items, "a2", true);
    expect(next.find((i) => i.id === "a")?.isCompleted).toBe(true);
  });

  it("снятие отметки с подпункта снимает её с пункта", () => {
    const items = [item("a", null, true), item("a1", "a", true), item("a2", "a", true)];
    const next = applyCompletion(items, "a1", false);
    expect(next.find((i) => i.id === "a")?.isCompleted).toBe(false);
    // Соседний подпункт не трогаем: снята отметка ровно с того, по чему кликнули.
    expect(next.find((i) => i.id === "a2")?.isCompleted).toBe(true);
  });

  it("при остальных невыполненных подпунктах пункт не меняется", () => {
    const items = [item("a"), item("a1", "a"), item("a2", "a")];
    const next = applyCompletion(items, "a1", true);
    expect(next.find((i) => i.id === "a")?.isCompleted).toBe(false);
  });
});

describe("applyCompletion — контракт", () => {
  it("не мутирует исходный массив", () => {
    const items = [item("a"), item("a1", "a")];
    applyCompletion(items, "a", true);
    expect(items.every((i) => !i.isCompleted)).toBe(true);
  });

  it("неизвестный ID оставляет состояние прежним", () => {
    const items = [item("a"), item("a1", "a")];
    expect(applyCompletion(items, "missing", true)).toEqual(items);
  });
});

 describe("состояние выполнения", () => {
  it("начало не меняет порядок, нумерацию и счётчик завершённых", () => {
    const input = [item("a"), item("b"), item("c")];
    const next = applyItemStatus(input, "b", "IN_PROGRESS");
    const tree = buildItemTree(next);
    expect(tree.nodes.map((node) => [node.item.id, node.number, node.status])).toEqual([
      ["a", 1, "NOT_STARTED"], ["b", 2, "IN_PROGRESS"], ["c", 3, "NOT_STARTED"],
    ]);
    expect(tree.completedCount).toBe(0);
    expect(input[1]).not.toHaveProperty("status");
  });
  it("начало блока сохраняет выполненные подпункты, а сброс очищает блок", () => {
    const input = [item("a"), item("done", "a", true), item("open", "a")];
    const started = applyItemStatus(input, "a", "IN_PROGRESS");
    expect(started.map((entry) => [entry.id, entry.isCompleted])).toEqual([["a", false], ["done", true], ["open", false]]);
    expect(buildItemTree(started).nodes[0].status).toBe("IN_PROGRESS");
    expect(buildItemTree(applyItemStatus(started, "a", "NOT_STARTED")).nodes[0].status).toBe("NOT_STARTED");
  });
  it("изменение подпункта пересчитывает состояние родителя", () => {
    const input = [item("a"), item("sub", "a")];
    const next = applyItemStatus(input, "sub", "IN_PROGRESS");
    expect(buildItemTree(next).nodes[0].status).toBe("IN_PROGRESS");
    expect(buildItemTree(applyCompletion(next, "sub", true)).nodes[0].status).toBe("COMPLETED");
    expect(buildItemTree(applyCompletion(next, "a", false)).nodes[0].status).toBe("NOT_STARTED");
  });
});
