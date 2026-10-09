/**
 * @file item-tree.ts
 * @description Сборка дерева записей: подпункты, производная отметка
 * выполнения, порядок и видимая нумерация.
 *
 * Модуль чистый: ни БД, ни React, ни localStorage. Он описывает продуктовые
 * правила подпунктов в одном месте, поэтому серверный и гостевой режимы, а
 * также оптимистичное состояние интерфейса не могут разойтись в поведении.
 *
 * Три правила, которые здесь закодированы:
 *
 *   1. Вложенность ровно одна. Запись, чей родитель сам является подпунктом,
 *      считается пунктом верхнего уровня: такие данные означают повреждение
 *      или гонку, и потерять запись на экране хуже, чем показать её не на том
 *      уровне.
 *
 *   2. Отметка выполнения пункта С ПОДПУНКТАМИ — производная: пункт выполнен
 *      ровно тогда, когда выполнены все его подпункты. Собственное поле такого
 *      пункта на чтении не используется вовсе. У пункта БЕЗ подпунктов
 *      значение своё — иначе пустое множество подпунктов сделало бы его
 *      выполненным (все ноль подпунктов выполнены).
 *
 *   3. Выполненные уходят в конец своего уровня и теряют номер. Номер нигде не
 *      хранится: это индекс среди невыполненных, поэтому удаление и отметка
 *      выполнения не требуют перенумерации. Подпункт показывается как «x.y»,
 *      где x — номер родителя.
 */

import { deriveParentStatus, getItemStatus, type ItemStatus } from "@/lib/item-status";

/** Минимум полей, нужный для сборки дерева. Всё остальное едет в `item`. */
export type ItemTreeInput = {
  id: string;
  /** ID родительского пункта. null — пункт верхнего уровня. */
  parentId: string | null;
  isCompleted: boolean;
  status?: ItemStatus;
};

/** Подпункт в дереве. */
export type SubItemNode<T> = {
  item: T;
  /** Видимый номер среди невыполненных подпунктов родителя. undefined — выполнен. */
  number: number | undefined;
};

/** Пункт верхнего уровня вместе со своими подпунктами. */
export type ItemNode<T> = {
  status: ItemStatus;
  item: T;
  /**
   * Производная отметка выполнения: при наличии подпунктов — «выполнены все»,
   * иначе собственное значение записи. Именно её показывает чекбокс.
   */
  isCompleted: boolean;
  /** Видимый номер среди невыполненных пунктов. undefined — выполнен. */
  number: number | undefined;
  subItems: SubItemNode<T>[];
};

/** Результат сборки: дерево и производные счётчики верхнего уровня. */
export type ItemTree<T> = {
  nodes: ItemNode<T>[];
  /**
   * Число невыполненных пунктов верхнего уровня. Задаёт границы для
   * «переместить выше/ниже» и совпадает с последним выданным номером.
   */
  activeCount: number;
  /**
   * Счётчик в шапке карточки считает ТОЛЬКО верхний уровень. Частично
   * выполненный пункт при этом честно считается невыполненным — благодаря
   * правилу 2 счётчик не может разойтись с тем, что видно в чекбоксах.
   */
  completedCount: number;
  totalCount: number;
};

/**
 * Собирает дерево из плоского массива записей.
 *
 * Массив обязан приходить уже упорядоченным по позиции — этот контракт общий
 * у серверной выборки и гостевого хранилища. Относительный порядок внутри
 * каждого уровня сохраняется: позиции сравнимы только внутри своей группы
 * `(listId, parentId)`, а сортировка на общем массиве оставляет подмножества
 * в их собственном порядке.
 */
export function buildItemTree<T extends ItemTreeInput>(
  items: readonly T[],
): ItemTree<T> {
  const byId = new Map(items.map((item) => [item.id, item]));

  /** Подпункты по ID родителя, в исходном порядке. */
  const childrenOf = new Map<string, T[]>();
  const topLevel: T[] = [];

  for (const item of items) {
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    // Родитель обязан существовать и сам быть верхнего уровня (правило 1).
    // Ссылка на себя отсекается тем же условием: parentId === id даёт
    // родителя с непустым parentId.
    if (!parent || parent.id === item.id || parent.parentId !== null) {
      topLevel.push(item);
      continue;
    }
    const siblings = childrenOf.get(parent.id);
    if (siblings) {
      siblings.push(item);
    } else {
      childrenOf.set(parent.id, [item]);
    }
  }

  const nodes: ItemNode<T>[] = topLevel.map((item) => {
    // Выполненные подпункты уходят в конец секции. Sort в JS стабилен, поэтому
    // внутри каждой из двух групп сохраняется порядок позиций.
    const subItems = (childrenOf.get(item.id) ?? [])
      .slice()
      .sort((a, b) => Number(a.isCompleted) - Number(b.isCompleted));

    const isCompleted =
      subItems.length > 0
        ? subItems.every((sub) => sub.isCompleted)
        : item.isCompleted;

    let subNumber = 0;
    return {
      item,
      isCompleted,
      status: subItems.length ? deriveParentStatus(subItems) : getItemStatus(item),
      // Номер проставляется ниже, после сортировки уровня.
      number: undefined,
      subItems: subItems.map((sub) => ({
        item: sub,
        number: sub.isCompleted ? undefined : (subNumber += 1),
      })),
    };
  });

  // Выполненные пункты уходят вниз списка — вместе со своими подпунктами,
  // потому что подпункты живут внутри узла.
  nodes.sort((a, b) => Number(a.isCompleted) - Number(b.isCompleted));

  let activeCount = 0;
  for (const node of nodes) {
    if (!node.isCompleted) {
      activeCount += 1;
      node.number = activeCount;
    }
  }

  return {
    nodes,
    activeCount,
    completedCount: nodes.length - activeCount,
    totalCount: nodes.length,
  };
}

/**
 * Применяет правило синхронизации статусов к плоскому массиву записей.
 *
 * Отметка родителя производная, поэтому «отметить пункт» физически означает
 * «отметить все его подпункты», а «снять отметку» — снять их все. Обратное
 * направление правила — пересчёт родителя после изменения подпункта — тоже
 * здесь: оба направления это одно и то же правило, записанное с двух сторон,
 * и разъехаться они могут только если разнести их по разным местам.
 *
 * Собственное поле родителя пишется вместе с подпунктами: на чтении оно не
 * используется (см. `buildItemTree`), но остаётся согласованным кешем — так
 * массив можно без оговорок сравнивать с тем, что лежит в хранилище.
 *
 * @param items - Плоский массив записей одного списка.
 * @param itemId - Запись, по которой кликнули.
 * @param isCompleted - Новое значение отметки для неё.
 * @returns Новый массив; исходный не меняется. Если записи нет — тот же массив.
 */
export function applyCompletion<T extends ItemTreeInput>(
  items: readonly T[],
  itemId: string,
  isCompleted: boolean,
): T[] {
  return applyItemStatus(items, itemId, isCompleted ? "COMPLETED" : "NOT_STARTED");
}

/**
 * Пересчитывает кеш отметки у родителя по фактическому состоянию подпунктов.
 *
 * Родитель, оставшийся без подпунктов, сохраняет прежнее значение: с этого
 * момента оно снова его собственное, и менять его было бы самодеятельностью.
 */
function recomputeParent<T extends ItemTreeInput>(items: T[], parentId: string): T[] {
  const children = items.filter((item) => item.parentId === parentId);
  if (children.length === 0) return items;

  const allCompleted = children.every((child) => child.isCompleted);
  return items.map((item) =>
    item.id === parentId
      ? { ...item, isCompleted: allCompleted, status: deriveParentStatus(children) }
      : item,
  );
}

/** Начало блока не снимает выполненные подпункты; сброс блока очищает все состояния. */
export function applyItemStatus<T extends ItemTreeInput>(
  items: readonly T[],
  itemId: string,
  status: ItemStatus,
): T[] {
  const target = items.find((item) => item.id === itemId);
  if (!target) return items.slice();
  const updated = items.map((item) => {
    if (
      item.id !== itemId &&
      !(target.parentId === null && item.parentId === itemId)
    ) return item;
    if (item.id !== itemId && status === "IN_PROGRESS" && item.isCompleted) return item;
    return { ...item, status, isCompleted: status === "COMPLETED" };
  });
  return recomputeParent(updated, target.parentId ?? itemId);
}
