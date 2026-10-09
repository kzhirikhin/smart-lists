/**
 * @file SmartList.tsx
 * @description Компонент отдельного списка с поддержкой оптимистичных обновлений.
 *
 * Client Component (`"use client"`).
 *
 * Отображает список записей и форму добавления новой записи.
 * Все три операции (добавление, удаление, переключение статуса) реализованы
 * с оптимистичным обновлением: UI меняется МГНОВЕННО, а запрос к серверу
 * выполняется в фоне.
 *
 * Паттерн "оптимистичный ID":
 *   При добавлении запись получает временный ID `temp-<timestamp>`.
 *   Пока запись имеет такой ID, она визуально помечается как "сохраняется":
 *     - Полупрозрачность (opacity-60)
 *     - Анимированный спиннер вместо чекбокса
 *     - Надпись "Сохраняется..." рядом с названием
 *   После ответа сервера `revalidatePath("/")` заменяет временную запись реальной.
 *
 * Откат при ошибке (только для addItem):
 *   Если сервер вернул ошибку — временная запись удаляется из UI,
 *   а введённое название возвращается в поле ввода.
 */

"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useOptimistic,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Reorder, useDragControls, type DragControls } from "framer-motion";
import {
  menuAnchorFor,
  sameMenuAnchor,
  type MenuAnchor,
} from "@/lib/menu-anchor";
import { beginDrag, endDrag } from "@/lib/drag-gate";
import {
  captureDropTargets,
  listIdAtPoint,
  pointerPoint,
  setDropHighlight,
  windowScroll,
  type DropTargets,
} from "@/lib/item-drop";
import { useListsApi } from "@/components/providers/ListsApiProvider";
import { useListsDirectory } from "@/components/providers/ListsDirectoryProvider";
import toast from "react-hot-toast";
import { useTranslations } from "next-intl";
import Highlight from "@/components/ui/Highlight";
import Tooltip from "@/components/ui/Tooltip";
import MoveItemModal from "@/components/lists/MoveItemModal";
import {
  DeleteNoteModal,
  NoteIcon,
  NotePanel,
  NoteRemoveIcon,
  TrashIcon,
} from "@/components/lists/Notes";
import { getNoteExcerpt } from "@/lib/notes";
import { MAX_ITEMS_PER_LIST, MAX_SUB_ITEMS_PER_ITEM } from "@/lib/limits";
import { applyCompletion, applyItemStatus, buildItemTree, type ItemNode } from "@/lib/item-tree";
import { useCollapsedItems } from "@/components/providers/CollapsedItemsProvider";
import { getItemStatus, type ItemStatus } from "@/lib/item-status";
import CollapseChevron from "@/components/ui/CollapseChevron";

// ---------------------------------------------------------------------------
// Типы данных
// ---------------------------------------------------------------------------

/** Одна запись в списке. */
type Item = {
  id: string;
  name: string;
  note: string | null;
  noteVersion: number;
  isCompleted: boolean;
  status?: ItemStatus;
  /**
   * ID родительского пункта. null — пункт верхнего уровня.
   *
   * Массив записей остаётся плоским, дерево собирает `buildItemTree` при
   * рендере: оптимистичное состояние тогда правится обычными `map`/`filter`
   * по одному массиву, без рекурсии по вложенным.
   */
  parentId: string | null;
  /** Пользователь, добавивший запись. null — для старых записей или temp-записей. */
  addedBy: { id: string; name: string | null; email: string } | null;
};

/**
 * Всё, что строка знает о своём месте в дереве.
 *
 * Тело строки одинаково у пункта и подпункта, различается только это: какая
 * отметка показывается, какой номер, какие пункты меню уместны. Собрано в один
 * объект, потому что позиционных аргументов набралось бы полдюжины.
 */
type RowContext = {
  status?: ItemStatus;
  /**
   * Производная отметка выполнения. У пункта с подпунктами это «выполнены
   * все», у остальных — собственное поле записи. Именно её показывает чекбокс,
   * и именно её инверсия уходит на сервер.
   */
  isCompleted: boolean;
  /** Видимый номер со точкой: «3.» или «3.2.». Пустая строка — номера нет. */
  numberLabel: string;
  /** Подпункт ли это. */
  isSubItem: boolean;
  /** Можно ли менять порядок на этом уровне: нужно больше одной активной записи. */
  canReorder: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Невыполненные записи уровня в текущем порядке — по ним считаются соседи. */
  siblings: Item[];
  /**
   * Блок подпунктов. undefined — подпунктов нет либо это сам подпункт.
   * Наличие блока и делает пункт родительским: отдельного признака нет.
   */
  block?: {
    isCollapsed: boolean;
    total: number;
    done: number;
    onToggle: () => void;
  };
};

/** Пропсы компонента `SmartList`. */
type SmartListProps = {
  /** Начальные данные о записях (загружаются с сервера). */
  items: Item[];
  /** ID списка, которому принадлежат эти записи. */
  listId: string;
  /** ID текущего пользователя (для отображения "Вы" вместо имени). */
  currentUserId: string;
  /** Имя текущего пользователя (для оптимистичного addedBy). */
  currentUserName: string | null;
  /** Email текущего пользователя (для оптимистичного addedBy). */
  currentUserEmail: string;
  /** Глобальный флаг отображения авторов (управляется из ListsContainer). */
  showAuthors: boolean;
  /** Глобальный флаг отображения порядковых номеров (тумблер в настройках). */
  showItemNumbers: boolean;
  /**
   * Показывать ли счётчики выполненного. Тумблер один на весь интерфейс:
   * он управляет и сводкой в шапке карточки, и счётчиком у свёрнутого блока
   * подпунктов. Разные переключатели для одного и того же по смыслу числа
   * пришлось бы объяснять, а объяснить нечем.
   */
  showItemsCounter: boolean;
  /**
   * ID записей, совпавших с поиском. null — показывать все записи.
   * Список приходит целиком именно для того, чтобы номера считались по нему,
   * а не по совпавшему подмножеству.
   */
  visibleItemIds: Set<string> | null;
  /** Активный поисковый запрос для подсветки совпадений (пустая строка = нет поиска). */
  searchQuery?: string;
};

// ---------------------------------------------------------------------------
// Иконки перемещения
// ---------------------------------------------------------------------------

/** Стрелка вверх для пункта меню «Переместить выше». */
function MoveUpIcon({ size = 17 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

/** Стрелка вниз для пункта меню «Переместить ниже». */
function MoveDownIcon({ size = 17 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

/** Стрелка в рамку — «переместить в другой список». */
function MoveToListIcon({ size = 17 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 4h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4" />
      <line x1="10" y1="12" x2="21" y2="12" />
      <polyline points="17 8 21 12 17 16" />
    </svg>
  );
}

/** Ветвление списка — «разбить на подпункты» и «добавить подпункт». */
function SubItemsIcon({ size = 17 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="4" y1="5" x2="20" y2="5" />
      <path d="M8 5v6a2 2 0 0 0 2 2h10" />
      <path d="M8 5v12a2 2 0 0 0 2 2h10" />
    </svg>
  );
}

/** Ручка перетаскивания: две колонки точек — привычный «grip». */
function GripIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Перетаскиваемая строка
// ---------------------------------------------------------------------------

/**
 * Обёртка строки, которую можно перетаскивать.
 *
 * Существует отдельным компонентом ради `useDragControls`: это хук, а значит
 * вызвать его в цикле по записям внутри `SmartList` нельзя — нужен один
 * компонент на строку.
 *
 * `dragListener={false}` отключает захват жеста самой строкой: перетаскивание
 * начинается ТОЛЬКО с ручки. Иначе жест конфликтовал бы с кликом по названию
 * (он открывает редактирование) и с вертикальным скроллом страницы на телефоне.
 */
function DraggableItemRow({
  item,
  className,
  testId = "item",
  isDragActive,
  isGestureArmed,
  onDragStart,
  onDragMove,
  onDragEnd,
  children,
}: {
  item: Item;
  className: string;
  /** Различает уровни: пункты остаются `item`, подпункты — `sub-item`. */
  testId?: string;
  /** Идёт ли перетаскивание хоть какой-нибудь записи в этом списке. */
  isDragActive: boolean;
  /**
   * Прижата ли ручка строки в этом списке: жест вот-вот начнётся или уже идёт.
   * Ровно на это время строке выдаются границы жеста — см. `dragConstraints`.
   */
  isGestureArmed: boolean;
  onDragStart: () => void;
  /**
   * Кадр жеста. Нужен только верхнему уровню — по координатам указателя
   * ищется карточка-получатель; сам порядок внутри списка ведёт `Reorder`.
   */
  onDragMove?: (event: MouseEvent | TouchEvent | PointerEvent) => void;
  onDragEnd: () => void;
  children: (dragControls: DragControls) => ReactNode;
}) {
  const dragControls = useDragControls();

  /**
   * Границы жеста — контейнер, в котором строка живёт: `ul` своего уровня.
   *
   * Берётся из DOM, а не пропом, потому что верен для обоих уровней разом:
   * у пункта родитель — группа списка, у подпункта — группа его блока. Проп
   * пришлось бы протаскивать через `SubItemsList`, а ref на группу подпунктов
   * создавать по одному на пункт — в цикле по записям хук не вызвать.
   *
   * Без этих границ строку можно было утащить куда угодно по вертикали: при
   * переносе в другой список она ехала за курсором через всю страницу, и
   * читать по ней, куда именно ляжет запись, становилось невозможно. Теперь
   * за пределами списка за курсором едет только плашка.
   */
  const constraintsRef = useRef<HTMLElement | null>(null);

  return (
    <Reorder.Item
      as="li"
      value={item}
      ref={(node: HTMLLIElement | null) => {
        constraintsRef.current = node?.parentElement ?? null;
      }}
      // Только позиция, без размеров. По умолчанию Reorder.Item ставит
      // layout={true} и анимирует в том числе высоту — а высота строки меняется
      // при раскрытии заметки. Framer анимирует размер через scale, поэтому
      // содержимое строки на время анимации сплющивалось и растягивалось.
      // "position" оставляет плавным переезд строк при перетаскивании и убирает
      // искажение: изменение высоты происходит мгновенно.
      layout="position"
      // Анимация переезда строк нужна ТОЛЬКО во время перетаскивания.
      //
      // Вне жеста высота строк меняется сама по себе: раскрылась заметка,
      // название перенеслось на вторую строку, показался сниппет поиска.
      // `layout="position"` применяет новую высоту мгновенно, а позицию соседей
      // тянет анимацией — и пока она идёт, соседняя строка стоит на старом
      // месте и налезает на выросшую. Никакая длительность это не лечит,
      // короткая пружина лишь укорачивает окно наложения.
      //
      // Поэтому вне жеста layout отрабатывает мгновенно (duration: 0) — список
      // перестраивается ровно так же, как обычный ul без анимаций. Во время
      // жеста включается пружина: там высоты не меняются, накладываться нечему,
      // а плавный разъезд соседей как раз и показывает, куда встанет запись.
      transition={{
        layout: isDragActive
          ? { type: "spring", stiffness: 700, damping: 50, mass: 0.5 }
          : { duration: 0 },
      }}
      dragListener={false}
      dragControls={dragControls}
      onDragStart={onDragStart}
      onDrag={onDragMove}
      onDragEnd={onDragEnd}
      // Инерция после отпускания в списке читается как «строка отскочила»:
      // запись должна замереть там, где её отпустили.
      dragMomentum={false}
      // Строка не покидает свой список: дальше её место всё равно не задаётся
      // порядком, а при переносе в другую карточку уехавшая через полстраницы
      // строка только мешает понять, куда ляжет запись.
      //
      // Границы выдаются ТОЛЬКО на время жеста, и это не оптимизация, а
      // обязательное условие. Получив `dragConstraints` в виде ref, framer
      // вешает ResizeObserver на строку и на контейнер и при каждом изменении
      // их размеров вызывает `scalePositionWithinConstraints`: она сохраняет
      // «прогресс» строки внутри границ, пересчитывая под новый размер, и
      // пишет результат прямо в x/y строки. Для покоящейся строки прогресс
      // ненулевой, поэтому после любого изменения высоты списка — раскрылась
      // заметка, заметка ушла в режим редактирования, раскрылся блок
      // подпунктов — строки получали inline `translateY` на десяток пикселей.
      // Он не снимался никогда, и следствий у него два: строки съезжают и
      // налезают друг на друга, а меню записи перестаёт открываться на своём
      // месте — элемент с трансформом становится содержащим блоком даже для
      // `position: fixed` потомков, и меню уезжает вместе со строкой.
      //
      // Во время жеста высоты не меняются, поэтому там наблюдателю нечего
      // ловить. Вне жеста пропа нет — и `scalePositionWithinConstraints`
      // выходит на первой же проверке, даже если наблюдатель остался висеть
      // с прошлого жеста.
      dragConstraints={isGestureArmed ? constraintsRef : undefined}
      // Мягкий край вместо жёсткого упора. Доля мала намеренно: она берётся от
      // всего перелёта, а он при переносе в другой список измеряется сотнями
      // пикселей — на прежних 0.12 строка заметно выползала бы из карточки.
      dragElastic={0.05}
      // Подъём строки под курсором. Тень и масштаб дают физическое ощущение
      // «взяли в руку»; без этого строка визуально неотличима от остальных.
      whileDrag={{ scale: 1.02 }}
      data-testid={testId}
      data-item-id={item.id}
      className={className}
    >
      {children(dragControls)}
    </Reorder.Item>
  );
}

/**
 * Контейнер подпунктов одного пункта.
 *
 * Когда порядок менять можно, это `Reorder.Group`, иначе обычный `ul`. Обёртка
 * существует ради одного: у группы и списка разные пропсы, а ветвление прямо в
 * разметке продублировало бы весь список подпунктов целиком.
 *
 * Группа своя у каждого пункта — отсюда и запрет переносить подпункт к другому
 * родителю: областей две, и жест не знает о существовании соседней.
 */
function SubItemsList({
  reorderable,
  values,
  onReorder,
  label,
  children,
}: {
  reorderable: boolean;
  values: Item[];
  onReorder: (items: Item[]) => void;
  label: string;
  children: ReactNode;
}) {
  // Уровень читается по отступу и по колонке номера «x.y»; вертикальная линия
  // добавляла третий признак того же самого и утяжеляла карточку.
  const className = "mt-1 ml-2 pl-3";

  if (!reorderable) {
    return (
      <ul data-testid="sub-items" aria-label={label} className={className}>
        {children}
      </ul>
    );
  }

  return (
    <Reorder.Group
      as="ul"
      axis="y"
      values={values}
      onReorder={onReorder}
      data-testid="sub-items"
      aria-label={label}
      className={className}
    >
      {children}
    </Reorder.Group>
  );
}

// ---------------------------------------------------------------------------
// Компонент
// ---------------------------------------------------------------------------

/**
 * Компонент списка записей с оптимистичными обновлениями.
 *
 * @param items - Начальный массив записей (с сервера).
 * @param listId - ID списка для привязки новых записей.
 */
export default function SmartList({
  items,
  listId,
  currentUserId,
  currentUserName,
  currentUserEmail,
  showAuthors,
  showItemNumbers,
  showItemsCounter,
  visibleItemIds,
  searchQuery = "",
}: SmartListProps) {
  const t = useTranslations("SmartList");
  const notesT = useTranslations("Notes");
  const commonT = useTranslations("Common");

  /**
   * Сообщение об отказе при добавлении записи.
   *
   * Добавление вызывается из двух мест — форма списка и форма подпунктов, —
   * и раньше каждое разбирало коды само. С появлением потолков вариантов
   * стало четыре, и разбор вынесен сюда: иначе новый код ошибки пришлось бы
   * не забыть добавить в оба места.
   */
  const addItemErrorMessage = (code?: string): string => {
    switch (code) {
      case "tooLong":
        return t("errors.tooLong");
      case "itemLimitReached":
        return t("errors.itemLimitReached", { max: MAX_ITEMS_PER_LIST });
      case "subItemLimitReached":
        return t("errors.subItemLimitReached", { max: MAX_SUB_ITEMS_PER_ITEM });
      case "dailyLimitReached":
        return t("errors.dailyLimitReached");
      default:
        return t("errors.addFailed");
    }
  };

  // Адаптер операций: Server Actions (авторизованный) или localStorage (гость)
  const api = useListsApi();

  // Справочник списков пространства — цели переноса записи.
  const { lists: directoryLists } = useListsDirectory();

  /** Есть ли куда переносить: единственный список не даёт целей. */
  const hasMoveTargets = directoryLists.some((list) => list.id !== listId);

  /**
   * Оптимистичный массив записей.
   *
   * `useOptimistic` принимает:
   *   - начальное состояние (`items` с сервера)
   *   - reducer-функцию, описывающую как изменить состояние локально
   *
   * Поддерживаемые действия:
   *   - `toggle`  — проставляет `isCompleted` записи вместе с синхронизацией
   *                 подпунктов и родителя (`applyCompletion`).
   *   - `delete`  — удаляет запись с заданным `itemId` вместе с её подпунктами.
   *   - `add`     — добавляет временную запись с `itemId` как временным ID.
   *   - `rename`  — меняет название записи.
   *   - `move`    — меняет местами запись и соседнюю по направлению `direction`.
   *   - `reorder` — задаёт произвольный порядок невыполненных пунктов
   *                 верхнего уровня (результат перетаскивания).
   */
  const [optimisticItems, setOptimisticItems] = useOptimistic(
    items,
    (
      state,
      {
        action,
        itemId,
        itemName,
        addedBy,
        direction,
        orderedIds,
        isCompleted,
        parentId,
        status,
      }: {
        action: "status" | "toggle" | "delete" | "add" | "rename" | "move" | "reorder";
        itemId: string;
        itemName?: string;
        addedBy?: Item["addedBy"];
        direction?: "up" | "down";
        orderedIds?: string[];
        /** Целевая отметка для `toggle` — уже производная, а не поле записи. */
        isCompleted?: boolean;
        status?: ItemStatus;
        /**
         * Для `add` — родитель новой записи (null — обычный пункт).
         * Для `reorder` — уровень, который переставляют.
         */
        parentId?: string | null;
      },
    ) => {
      switch (action) {
        case "status":
          return applyItemStatus(state, itemId, status ?? "NOT_STARTED");
        case "toggle":
          // Правило синхронизации живёт в одном месте на весь проект, и
          // оптимистичное состояние применяет ровно его: иначе экран до
          // ответа сервера показывал бы не то, что окажется в БД.
          return applyCompletion(state, itemId, isCompleted ?? false);
        case "delete":
          // Подпункты уходят вместе с родителем — как каскад в БД.
          return state.filter(
            (item) => item.id !== itemId && item.parentId !== itemId,
          );
        case "add":
          return [
            ...state,
            {
              id: itemId,
              name: itemName || "",
              note: null,
              noteVersion: 0,
              isCompleted: false,
              status: "NOT_STARTED" as const,
              parentId: parentId ?? null,
              addedBy: addedBy ?? null,
            },
          ];
        case "rename":
          return state.map((item) =>
            item.id === itemId
              ? { ...item, name: itemName || item.name }
              : item,
          );
        case "move": {
          // Меняем местами соседние НЕВЫПОЛНЕННЫЕ записи одного уровня.
          // Переставляем именно слоты в массиве: выполненные записи между ними
          // остаются на месте, а сортировка при рендере стабильна —
          // относительный порядок двух активных записей меняется ровно так,
          // как ожидает пользователь.
          const level = state.find((item) => item.id === itemId)?.parentId ?? null;
          const activeSlots = state.reduce<number[]>((slots, item, index) => {
            if (!item.isCompleted && item.parentId === level) slots.push(index);
            return slots;
          }, []);

          const from = activeSlots.findIndex(
            (slot) => state[slot].id === itemId,
          );
          if (from === -1) return state;

          const to = direction === "up" ? from - 1 : from + 1;
          if (to < 0 || to >= activeSlots.length) return state;

          const next = [...state];
          const a = activeSlots[from];
          const b = activeSlots[to];
          [next[a], next[b]] = [next[b], next[a]];
          return next;
        }
        case "reorder": {
          if (!orderedIds) return state;

          // Переставляется один уровень: `parentId` здесь — не родитель новой
          // записи, а уровень жеста (null — пункты списка). Остальные записи
          // идут следом одной группой, и это ничего не портит: `buildItemTree`
          // разбирает их по родителям сам, а относительный порядок внутри
          // каждой группы сохраняется — этого достаточно.
          const level = parentId ?? null;
          const rank = new Map(orderedIds.map((id, index) => [id, index]));
          const reordered = state
            .filter((item) => item.parentId === level)
            .sort(
              (a, b) =>
                (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
                (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
            );
          return [
            ...reordered,
            ...state.filter((item) => item.parentId !== level),
          ];
        }
        default:
          return state;
      }
    },
  );

  /** Текущее значение поля ввода новой записи. */
  const [newItemName, setNewItemName] = useState("");

  /** Флаг ожидания ответа сервера при добавлении записи. */
  const [isAddingItem, setIsAddingItem] = useState(false);

  /**
   * Запись, ожидающая подтверждения удаления.
   * `null` означает, что модальное окно закрыто.
   */
  const [itemToDelete, setItemToDelete] = useState<Item | null>(null);

  /** Флаг ожидания ответа сервера при удалении записи. Блокирует повторные запросы. */
  const [isDeletingItem, setIsDeletingItem] = useState(false);

  /** ID записи, название которой сейчас редактируется. */
  const [editingItemId, setEditingItemId] = useState<string | null>(null);

  /** Текущее значение поля ввода при редактировании записи. */
  const [editItemName, setEditItemName] = useState("");

  /** ID записи с раскрытой заметкой. */
  const [openNoteItemId, setOpenNoteItemId] = useState<string | null>(null);

  /** ID записи, заметку которой подтверждают к удалению из меню действий. */
  const [noteToDeleteItemId, setNoteToDeleteItemId] = useState<string | null>(null);

  /** ID записи с открытым меню действий. */
  const [openItemActionsId, setOpenItemActionsId] = useState<string | null>(null);
  const itemActionsMenuRef = useRef<HTMLDivElement>(null);
  const itemActionsButtonRef = useRef<HTMLButtonElement>(null);
  const itemActionsPanelRef = useRef<HTMLDivElement>(null);

  /**
   * Координаты открытого меню записи в координатах окна.
   *
   * Меню закреплено `fixed`, как и меню списка, и по той же паре причин —
   * они разобраны в `src/lib/menu-anchor.ts`. Для меню записи важнее первая:
   * строка списка на время layout-анимации получает inline-трансформ, а он
   * создаёт собственный контекст наложения, из которого `absolute`-меню уже не
   * всплывает над следующими строками.
   */
  const [itemActionsAnchor, setItemActionsAnchor] = useState<MenuAnchor | null>(
    null,
  );

  /** Открывает меню записи, запоминая координаты её кнопки. */
  const openItemActions = (itemId: string, button: HTMLButtonElement) => {
    // Координаты берём из самой кнопки: на момент клика меню ещё не
    // отрисовано, измерять по нему нечего.
    setItemActionsAnchor(menuAnchorFor(button, 0));
    setOpenItemActionsId(itemId);
  };

  /**
   * Пересчёт координат меню: сначала по факту отрисовки — тогда становится
   * известна его высота и решается вопрос переворота, — затем при прокрутке и
   * изменении размера окна, иначе закреплённое меню отрывается от своей кнопки.
   *
   * Слушатель прокрутки с capture: карточка может лежать в прокручиваемом
   * контейнере, а не только в окне.
   */
  useLayoutEffect(() => {
    if (!openItemActionsId) return;

    const reposition = () => {
      const button = itemActionsButtonRef.current;
      if (!button) return;
      const next = menuAnchorFor(
        button,
        itemActionsPanelRef.current?.offsetHeight ?? 0,
      );
      setItemActionsAnchor((current) =>
        sameMenuAnchor(current, next) ? current : next,
      );
    };

    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [openItemActionsId]);

  /** Защита от двойного вызова rename (Enter → blur). */
  const processingItemRenameRef = useRef(false);

  /** Сигнал для игнорирования blur при нажатии Escape. */
  const skipItemBlurRef = useRef(false);

  /**
   * Пункт, под которым открыто поле ввода подпункта. null — поле закрыто.
   *
   * Состояние только клиентское и ничего не сохраняет: «разбит на подпункты» —
   * это не признак записи, а факт наличия у неё хотя бы одного подпункта.
   * Поэтому команда меню лишь открывает поле, а родительским пункт делает
   * первый введённый подпункт.
   */
  const [addSubItemParentId, setAddSubItemParentId] = useState<string | null>(null);

  /** Текущее значение поля ввода подпункта. */
  const [newSubItemName, setNewSubItemName] = useState("");

  /** Свёрнутые вручную блоки: набор общий на пространство и лежит в localStorage. */
  const { collapsedIds, toggle: toggleCollapsedBlock } = useCollapsedItems();

  /**
   * Выполненные блоки, раскрытые вручную.
   *
   * Отдельно от сохранённого набора и намеренно живёт только до перезагрузки.
   * Выполненный блок сворачивается сам — это следствие отметки, а не выбор
   * пользователя, и хранить тут нечего: после перезагрузки он снова свёрнут,
   * ровно как и задумано словом «убрать сделанное с глаз». Сохранённый набор
   * при этом не трогается, поэтому снятие отметки возвращает блок в то
   * состояние, которое пользователь выбирал для него как для активного.
   */
  const [expandedCompletedIds, setExpandedCompletedIds] = useState<Set<string>>(
    () => new Set(),
  );

  /**
   * Обработчик подтверждения удаления записи.
   *
   * Вызывается из модального окна или по нажатию Enter.
   * Выполняет оптимистичное удаление.
   */
  const handleConfirmDeleteItem = useCallback(async () => {
    if (!itemToDelete) return;

    const item = itemToDelete;
    setIsDeletingItem(true);
    setItemToDelete(null); // Закрываем модал немедленно

    // Оптимистично убираем запись из UI
    startTransition(() => {
      setOptimisticItems({ action: "delete", itemId: item.id });
    });

    await api.deleteItem(item.id);

    setIsDeletingItem(false);
  }, [itemToDelete, setOptimisticItems, api]);

  /**
   * Эффект: подписка на клавиатурные события при открытом модале удаления записи.
   *
   * - `Escape` — закрывает модал без удаления.
   * - `Enter`  — подтверждает удаление.
   */
  useEffect(() => {
    if (!itemToDelete) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setItemToDelete(null);
        return;
      }
      if (event.key === "Enter" && !isDeletingItem) {
        event.preventDefault();
        void handleConfirmDeleteItem();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleConfirmDeleteItem, isDeletingItem, itemToDelete]);

  // Закрываем меню действий записи по клику снаружи или по Escape.
  useEffect(() => {
    if (!openItemActionsId) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!itemActionsMenuRef.current?.contains(event.target as Node)) {
        setOpenItemActionsId(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenItemActionsId(null);
        itemActionsButtonRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openItemActionsId]);

  /**
   * Подтверждает переименование записи.
   * Вызывается при Enter или blur.
   */
  const handleConfirmItemRename = async (item: Item) => {
    if (processingItemRenameRef.current) return;
    processingItemRenameRef.current = true;

    try {
      const trimmedName = editItemName.trim();
      setEditingItemId(null);

      if (!trimmedName || trimmedName === item.name) return;

      startTransition(() => {
        setOptimisticItems({
          action: "rename",
          itemId: item.id,
          itemName: trimmedName,
        });
      });

      const result = await api.renameItem(item.id, trimmedName);

      if (result && !result.success) {
        startTransition(() => {
          setOptimisticItems({
            action: "rename",
            itemId: item.id,
            itemName: item.name,
          });
        });
        toast.error(
          result.error === "tooLong"
            ? t("errors.tooLong")
            : t("errors.renameFailed"),
        );
      }
    } finally {
      processingItemRenameRef.current = false;
    }
  };

  /**
   * Запись, заметку которой подтверждают к удалению.
   * Берём её из актуального массива, чтобы удалять с последней известной версией.
   */
  const noteDeleteItem =
    optimisticItems.find((item) => item.id === noteToDeleteItemId) ?? null;

  /** Сколько подпунктов уйдёт вместе с записью, которую подтверждают к удалению. */
  const itemToDeleteSubCount = itemToDelete
    ? optimisticItems.filter((item) => item.parentId === itemToDelete.id).length
    : 0;

  /**
   * Дерево записей: уровни, производные отметки выполнения, порядок с
   * выполненными в конце каждого уровня и видимая нумерация.
   *
   * Считается по optimisticItems, то есть по полному списку и с учётом
   * оптимистичных изменений: номера пересчитываются мгновенно, не дожидаясь
   * ответа сервера, и не врут при активном поиске.
   *
   * Номер нигде не хранится — это порядковый индекс среди НЕВЫПОЛНЕННЫХ
   * записей уровня. Отсюда бесплатно следуют все правила: удалили запись —
   * последующие сдвинулись на -1; отметили выполненной — она потеряла номер;
   * сняли галку — вернулась на своё место вместе со своим номером.
   */
  const { nodes, activeCount: activeItemsCount } = buildItemTree(optimisticItems);

  /**
   * Пункты к отрисовке — блоками целиком.
   *
   * При активном поиске несовпавшие скрываются здесь, а не в `ListsContainer`:
   * иначе нумерация считалась бы по подмножеству. Совпадение в подпункте
   * показывает весь блок, и это не послабление, а единственный вариант без
   * лжи на экране: производная отметка родителя и нумерация «x.y» считаются
   * по всем подпунктам, и скрытая часть сделала бы чекбокс и номера
   * необъяснимыми. Совпадения при этом подсвечиваются только настоящие,
   * соседи служат контекстом.
   *
   * Только что добавленная запись (temp-) видна всегда: пользователь должен
   * видеть результат своего действия независимо от текущего фильтра.
   */
  const visibleNodes = visibleItemIds
    ? nodes.filter((node) => {
        const matches = (id: string) =>
          visibleItemIds.has(id) || id.startsWith("temp-");
        return (
          matches(node.item.id) || node.subItems.some((sub) => matches(sub.item.id))
        );
      })
    : nodes;

  /**
   * Порядок можно менять, только когда виден весь список. При активном поиске
   * пользователь видит подмножество записей, и «вверх» означало бы перескок
   * через скрытые записи — вместо этого пункты меню просто не показываются.
   */
  const canReorderItems = visibleItemIds === null && activeItemsCount > 1;

  /**
   * Доступен ли жест на верхнем уровне.
   *
   * Условие шире, чем у перестановки, и разошлись они не случайно: переставлять
   * нечего, пока запись одна, а вот унести её в другой список хочется как раз
   * чаще всего — «одна запись» и «некуда двигать» перестали быть одним и тем
   * же с появлением броска на чужую карточку. Поиск запрещает и то и другое:
   * видно подмножество, и соседи по экрану не соседи по списку.
   */
  const canDragItems =
    visibleItemIds === null &&
    activeItemsCount > 0 &&
    (canReorderItems || hasMoveTargets);

  /**
   * Перемещает запись на одну позицию вверх или вниз среди невыполненных
   * записей её уровня — доступная с клавиатуры альтернатива жесту.
   *
   * Серверу отправляются ID новых соседей, вычисленные по УЖЕ переставленному
   * массиву: сервер получает место назначения, а не наше представление о
   * текущем порядке, и потому не зависит от того, насколько оно свежее.
   *
   * @param activeItems - Невыполненные записи уровня в текущем порядке.
   */
  const handleMoveItem = (
    item: Item,
    direction: "up" | "down",
    activeItems: Item[],
  ) => {
    const index = activeItems.findIndex((entry) => entry.id === item.id);
    if (index === -1) return;

    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= activeItems.length) return;

    const reordered = [...activeItems];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved);

    // Запрос выполняется ВНУТРИ transition, как в form action у чекбокса:
    // оптимистичное значение живёт, пока transition не завершится. Если бы
    // await стоял снаружи, запись прыгнула бы обратно сразу после клика и
    // вернулась на новое место только после ответа сервера.
    startTransition(async () => {
      setOptimisticItems({ action: "move", itemId: item.id, direction });

      const result = await api.moveItem(
        item.id,
        reordered[targetIndex - 1]?.id ?? null,
        reordered[targetIndex + 1]?.id ?? null,
      );

      if (result && !result.success) {
        // Откат: обратное перемещение возвращает запись на прежнее место.
        setOptimisticItems({
          action: "move",
          itemId: item.id,
          direction: direction === "up" ? "down" : "up",
        });
        toast.error(t("errors.moveFailed"));
      }
    });
  };

  /**
   * Добавляет подпункт к пункту.
   *
   * Поле после отправки остаётся открытым: подпункты почти всегда набирают
   * очередью, и закрытие после каждого Enter заставляло бы лезть в меню
   * заново. Закрывает поле Escape или кнопка рядом.
   *
   * Ожидания ответа сервера здесь намеренно нет. Флаг «сохраняется» блокировал
   * бы следующий ввод — ровно то, ради чего поле и оставлено открытым: набрать
   * подряд три подпункта быстрее, чем успевает ответить БД. От повторной
   * отправки того же текста защищает очистка поля: второй submit увидит пустое
   * значение и выйдет. Одновременные добавления могут прочитать одинаковый
   * максимум позиции — это допустимо, порядок доопределяет тайбрейк.
   */
  const handleAddSubItem = async (parentItemId: string) => {
    const trimmedName = newSubItemName.trim();
    if (!trimmedName) return;

    const tempId = `temp-${Date.now()}`;

    startTransition(() => {
      setOptimisticItems({
        action: "add",
        itemId: tempId,
        itemName: trimmedName,
        parentId: parentItemId,
        addedBy: {
          id: currentUserId,
          name: currentUserName,
          email: currentUserEmail,
        },
      });
    });

    setNewSubItemName("");

    const result = await api.addItem(listId, trimmedName, parentItemId);

    if (result && !result.success) {
      startTransition(() => {
        setOptimisticItems({ action: "delete", itemId: tempId });
      });
      setNewSubItemName(trimmedName);
      toast.error(addItemErrorMessage(result.error));
    }
  };

  /** Запись, для которой открыт выбор списка-получателя. null — модал закрыт. */
  const [itemToMove, setItemToMove] = useState<Item | null>(null);

  /**
   * Переносит или копирует запись в другой список.
   *
   * Оптимистика здесь асимметрична, и иначе не выходит: состояние записей живёт
   * в `useOptimistic` каждого `SmartList` по отдельности, а операция затрагивает
   * два списка. Из исходного запись убирается сразу, в целевом появится вместе
   * со свежими данными (revalidatePath на сервере, refresh у гостя). Копия
   * оптимистичного отображения не получает вовсе — оригинал остаётся на месте,
   * и без тоста действие выглядело бы как «ничего не произошло».
   *
   * Запрос идёт ВНУТРИ transition — по той же причине, что и в `handleMoveItem`:
   * оптимистичное состояние живёт, пока transition не завершится.
   */
  const handleMoveItemToList = (
    item: Item,
    targetListId: string,
    mode: "move" | "copy",
  ) => {
    setItemToMove(null);

    const targetTitle =
      directoryLists.find((list) => list.id === targetListId)?.title ?? "";

    startTransition(async () => {
      if (mode === "move") {
        setOptimisticItems({ action: "delete", itemId: item.id });
      }

      const result = await api.moveItemToList(item.id, targetListId, mode);

      if (!result.success) {
        // Оптимистичное удаление откатится само по завершении transition.
        toast.error(
          result.error === "itemLimitReached"
            ? t("errors.itemLimitReached", { max: MAX_ITEMS_PER_LIST })
            : t("errors.moveToListFailed"),
        );
        return;
      }

      toast.success(
        mode === "move"
          ? t("moveToList.moved", { title: targetTitle })
          : t("moveToList.copied", { title: targetTitle }),
      );
    });
  };

  /** Невыполненные блоки — те, что можно перетаскивать. */
  const activeVisibleNodes = visibleNodes.filter((node) => !node.isCompleted);
  /** Выполненные блоки — рендерятся ниже обычным списком, без перетаскивания. */
  const completedVisibleNodes = visibleNodes.filter((node) => node.isCompleted);

  /**
   * Перетаскиваются пункты верхнего уровня; подпункты живут внутри своего узла
   * и потому едут вместе с ним, не участвуя в жесте отдельно.
   */
  const activeVisibleItems = activeVisibleNodes.map((node) => node.item);

  /**
   * Порядок, который пользователь «набрал» жестом, вместе с уровнем, на котором
   * идёт жест: null — пункты списка, ID родителя — его подпункты.
   * null вместо объекта означает, что жеста нет.
   */
  const [dragOrder, setDragOrder] = useState<{
    level: string | null;
    items: Item[];
  } | null>(null);

  /** Порядок, показываемый группой: во время жеста — набранный, иначе серверный. */
  const draggableItems =
    dragOrder?.level === null ? dragOrder.items : activeVisibleItems;

  /** Узел по ID записи — во время жеста порядок задан массивом записей. */
  const nodeById = new Map(visibleNodes.map((node) => [node.item.id, node]));

  /**
   * Свёрнут ли блок подпунктов.
   *
   * Три правила по убыванию приоритета:
   *
   *   1. При активном поиске блоки раскрыты, а сохранённое состояние не
   *      меняется — как и свёрнутость карточки. Показать совпадение и не дать
   *      на него посмотреть было бы сломанным поиском.
   *   2. Выполненный блок свёрнут: работа сделана, и держать её на экране
   *      незачем. Раскрывается вручную и только до перезагрузки.
   *   3. Остальные — по сохранённому набору.
   */
  const isBlockCollapsed = (node: ItemNode<Item>): boolean => {
    if (node.subItems.length === 0) return false;
    if (visibleItemIds !== null) return false;
    return node.isCompleted
      ? !expandedCompletedIds.has(node.item.id)
      : collapsedIds.has(node.item.id);
  };

  /**
   * Переключает свёрнутость блока.
   *
   * У выполненного блока выбор не сохраняется: он относится к состоянию
   * «сделано», а не к самому пункту, и переживать перезагрузку ему незачем.
   */
  const handleToggleBlock = (node: ItemNode<Item>) => {
    if (node.isCompleted) {
      setExpandedCompletedIds((prev) => {
        const next = new Set(prev);
        if (!next.delete(node.item.id)) next.add(node.item.id);
        return next;
      });
      return;
    }
    toggleCollapsedBlock(node.item.id);
  };

  /** ID записи под курсором во время жеста. null — жест не идёт. */
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);

  /**
   * Прижата ли ручка строки: жест ещё не начался, но вот-вот начнётся.
   *
   * Взвод существует ради `dragConstraints` (см. `DraggableItemRow`): границы
   * жеста нельзя держать выданными постоянно, а к началу жеста они уже должны
   * быть на месте. Нажатие на ручку даёт нужную перерисовку заранее — framer
   * разрешает границы не в момент нажатия, а когда указатель сдвинулся на
   * порог жеста.
   *
   * Раскладку взвод не меняет: он лишь возвращает пропу прежнее значение.
   */
  const [isDragArmed, setIsDragArmed] = useState(false);

  // Нажатие на ручку могло не перейти в жест — обычный клик по ней взвод бы не
  // снял. Если жест идёт, границы нужны до его конца: снимет их `handleDragEnd`.
  useEffect(() => {
    if (!isDragArmed) return;

    const disarm = () => {
      if (draggingItemId === null) setIsDragArmed(false);
    };

    window.addEventListener("pointerup", disarm);
    window.addEventListener("pointercancel", disarm);
    return () => {
      window.removeEventListener("pointerup", disarm);
      window.removeEventListener("pointercancel", disarm);
    };
  }, [isDragArmed, draggingItemId]);

  /**
   * Снимок карточек-целей на время жеста. null — цели не нужны: жест идёт на
   * уровне подпунктов либо в пространстве нет других списков.
   */
  const dropTargetsRef = useRef<DropTargets | null>(null);

  /**
   * Карточка-получатель под указателем. Ref, а не состояние: значение
   * обновляется на каждом кадре жеста, а перерисовывать по нему нечего —
   * подсветка целевой карточки и положение превью живут прямо в DOM.
   */
  const dropTargetIdRef = useRef<string | null>(null);

  /** Плашка, следующая за указателем за пределами своей карточки. */
  const dragPreviewRef = useRef<HTMLDivElement>(null);

  /**
   * Идёт ли жест, начатый в этом списке. Нужен только уборке при
   * размонтировании: следы жеста лежат вне поддерева компонента — на `body` и
   * на чужой карточке, — и сами бы не убрались.
   */
  const dragActiveRef = useRef(false);

  /**
   * Классы строки.
   *
   * `transition-colors`, а НЕ `transition-all`: перетаскиваемую строку двигает
   * framer-motion через inline `transform`, и CSS-переход по всем свойствам
   * начинал бы его догонять — строка дёргалась бы и отставала от курсора.
   *
   * Во время жеста строка получает свой фон и тень: в тёмной теме без этого
   * сквозь «поднятую» запись просвечивали бы соседние — ровно то ощущение, что
   * ничего не перетаскивается.
   *
   * Фон непрозрачный и в покое, а не только под курсором. Вне жеста строки на
   * один кадр накладываются друг на друга — framer удерживает соседей на старом
   * месте, пока доигрывает layout-анимацию (см. `DraggableItemRow`). В тёмной
   * теме строка была прозрачной, и на этом кадре два названия просвечивали
   * друг сквозь друга, превращаясь в нечитаемую кашу; с непрозрачным фоном они
   * просто перекрываются. Цвет совпадает с фоном карточки, поэтому в покое
   * ничего не меняется.
   */
  const rowClassName = (item: Item, isCompleted: boolean) => {
    const base = "py-2 px-1 transition-colors duration-200";
    if (item.id === draggingItemId) {
      return `${base} relative z-20 cursor-grabbing rounded-md bg-white shadow-lg ring-1 ring-gray-200 dark:bg-zinc-800 dark:shadow-black/60 dark:ring-zinc-700`;
    }
    return `${base} ${
      isCompleted
        ? "bg-gray-100 dark:bg-zinc-900"
        : "bg-gray-50 dark:bg-zinc-900"
    }`;
  };

  /**
   * Начинает жест на любом уровне.
   *
   * `level` — то же, что `parentId` перетаскиваемой записи: null у пунктов,
   * ID родителя у подпунктов. Уровни независимы, поэтому одно состояние с
   * пометкой уровня заменяет два: одновременно идёт максимум один жест.
   */
  const handleDragStart = (level: string | null, item: Item, siblings: Item[]) => {
    // Закрываем затвор realtime: перерисовка дерева посреди жеста сорвала бы его.
    beginDrag();
    setDraggingItemId(item.id);
    // Фиксируем текущий порядок как стартовый — дальше им управляет onReorder.
    setDragOrder({ level, items: siblings });

    // Гасим отклик страницы на наведение: по дороге курсор проходит над
    // вкладками, кнопками и чужими записями, а бросок туда ничего не делает
    // (правило — в `globals.css`). Касается любого жеста записи, не только
    // переноса в другой список.
    dragActiveRef.current = true;
    document.body.dataset.itemDragging = "true";

    // Цели переноса снимаются один раз на жест и только для пунктов верхнего
    // уровня: подпункт принадлежит родителю и отдельно в другой список не
    // едет — то же самое проверяет и сервер.
    dropTargetIdRef.current = null;
    dropTargetsRef.current =
      level === null && hasMoveTargets ? captureDropTargets() : null;
  };

  /**
   * Ищет карточку-получателя на кадре жеста.
   *
   * Состояние React здесь не участвует вовсе: кадров десятки в секунду, а
   * перерисовывать нужно ноль компонентов. Подсветку целевой карточки ставит
   * `setDropHighlight` (карточка чужая и мемоизированная), положение превью
   * пишется в его собственный узел.
   */
  const handleDragMove = (event: MouseEvent | TouchEvent | PointerEvent) => {
    const targets = dropTargetsRef.current;
    if (!targets) return;

    const point = pointerPoint(event);
    if (!point) return;

    const overListId = listIdAtPoint(targets, point, windowScroll());
    const targetId = overListId && overListId !== listId ? overListId : null;

    if (targetId !== dropTargetIdRef.current) {
      dropTargetIdRef.current = targetId;
      setDropHighlight(targetId);
    }

    // Превью появляется, как только указатель ушёл со своей карточки: строку
    // `Reorder` двигает только по вертикали, а колонки стоят горизонтально —
    // за курсором в соседнюю она не пойдёт, и следовать за ним нечему.
    const preview = dragPreviewRef.current;
    if (preview) {
      preview.style.display = overListId === listId ? "none" : "flex";
      preview.style.transform = `translate3d(${point.x + 14}px, ${point.y + 14}px, 0)`;
    }
  };

  /**
   * Завершает жест: сохраняет набранный порядок и открывает затвор realtime.
   *
   * Соседи берутся из ИТОГОВОГО порядка, поэтому серверу уходит место
   * назначения — тот же контракт, что и у перемещения через меню. Сервер сам
   * проверит, что соседи с того же уровня: подпункт остаётся у своего родителя.
   */
  const handleDragEnd = (level: string | null, item: Item, siblings: Item[]) => {
    endDrag();
    setDraggingItemId(null);
    setIsDragArmed(false);

    const dropTargetId = dropTargetIdRef.current;
    dropTargetsRef.current = null;
    dropTargetIdRef.current = null;
    dragActiveRef.current = false;
    setDropHighlight(null);
    delete document.body.dataset.itemDragging;

    const finalOrder = dragOrder?.level === level ? dragOrder.items : null;
    setDragOrder(null);

    // Бросок на чужую карточку — перенос, а не перестановка. Набранный по
    // дороге порядок не сохраняется: запись уезжает из этого списка целиком,
    // и `moveItem` рядом с `moveItemToList` означал бы две записи в БД ради
    // соседства, которого через мгновение не станет.
    if (dropTargetId) {
      handleMoveItemToList(item, dropTargetId, "move");
      return;
    }

    if (!finalOrder) return;

    const index = finalOrder.findIndex((entry) => entry.id === item.id);
    // Запись вернулась на исходное место — сохранять нечего.
    if (index === -1 || siblings[index]?.id === item.id) return;

    const orderedIds = finalOrder.map((entry) => entry.id);
    const previousIds = siblings.map((entry) => entry.id);

    startTransition(async () => {
      setOptimisticItems({
        action: "reorder",
        itemId: item.id,
        orderedIds,
        parentId: level,
      });

      const result = await api.moveItem(
        item.id,
        finalOrder[index - 1]?.id ?? null,
        finalOrder[index + 1]?.id ?? null,
      );

      if (result && !result.success) {
        setOptimisticItems({
          action: "reorder",
          itemId: item.id,
          orderedIds: previousIds,
          parentId: level,
        });
        toast.error(t("errors.moveFailed"));
      }
    });
  };

  /**
   * Запись, которую жест способен увести в другой список: перетаскивают пункт
   * верхнего уровня и цели существуют. null — превью показывать не для чего.
   */
  const draggedAwayItem =
    hasMoveTargets && draggingItemId !== null && dragOrder?.level === null
      ? (nodeById.get(draggingItemId)?.item ?? null)
      : null;

  // Жест мог оборваться размонтированием карточки — сменой группы или
  // пространства прямо во время перетаскивания. Оба следа жеста лежат вне
  // поддерева этого компонента: подсветка на чужой карточке, запрет наведения
  // на `body`. Страница без второго осталась бы вовсе некликабельной.
  useEffect(() => {
    return () => {
      if (!dragActiveRef.current) return;
      setDropHighlight(null);
      delete document.body.dataset.itemDragging;
    };
  }, []);

  /**
   * Рендерит содержимое строки записи.
   *
   * Вынесено в функцию, потому что строки живут в двух разных контейнерах:
   * активные — внутри Reorder.Group как Reorder.Item, остальные — обычными
   * li. Тело у них одинаковое, различается только обёртка и наличие ручки
   * перетаскивания.
   *
   * @param dragControls - Контроллер жеста; null у неперетаскиваемых строк.
   * @param context - Место записи в дереве: производная отметка, номер и
   *                  доступные для неё команды.
   */
  const renderItemRow = (
    item: Item,
    dragControls: DragControls | null,
    context: RowContext,
  ) => {
    const { isCompleted, numberLabel, isSubItem } = context;
    const status = context.status ?? getItemStatus(item);
    const isInProgress = status === "IN_PROGRESS";
    /**
     * Запись считается "в ожидании" (pending), если её ID начинается с "temp-".
     * В этом состоянии интерактивные элементы заблокированы.
     */
    const isPending = item.id.startsWith("temp-");
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const noteMatchesSearch = Boolean(
      item.note &&
        normalizedQuery &&
        item.note.toLocaleLowerCase().includes(normalizedQuery),
    );

    /**
     * Колонка номера. У подпункта номер вдвое длиннее («3.2.» против «3.»),
     * поэтому колонка шире — иначе название подпункта уезжало бы вправо
     * относительно соседей с однозначными номерами.
     */
    const numberColumn = isSubItem ? "min-w-10" : "min-w-5";

    /**
     * Отступ заметки под названием записи — сумма ширин колонок слева от него.
     * Значения привязаны к классам самих колонок: чекбокс даёт 2rem
     * (w-5 + gap-3), ручка и номер по 1.75rem (та же пара минус отрицательный
     * margin, которым они подтянуты к соседу), широкая колонка подпункта —
     * 3rem. Менять классы колонок — менять и эти значения, иначе заметка
     * съедет относительно текста.
     */
    // У подпункта колонка ручки есть всегда — пустая, когда ручки нет.
    const hasHandleColumn = Boolean(dragControls) || isSubItem;
    const rowIndent = showItemNumbers
      ? hasHandleColumn
        ? isSubItem
          ? "ml-[6.75rem]"
          : "ml-[5.5rem]"
        : "ml-[3.75rem]"
      : hasHandleColumn
        ? "ml-[3.75rem]"
        : "ml-8";

    return (
      <>
          <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            {/* Ручка перетаскивания. aria-hidden и tabIndex -1 намеренно:
                жест доступен только мышью и пальцем, а с клавиатуры порядок
                меняется пунктами «Переместить выше/ниже» в меню действий —
                они и есть доступная альтернатива. touch-none обязателен:
                без него палец на ручке скроллил бы страницу вместо жеста.

                У подпункта без ручки колонка сохраняется пустой — как колонка
                номера у выполненной записи. Иначе отступ блока зависел бы от
                того, можно ли сейчас перетаскивать: единственный подпункт,
                выполненный подпункт и подпункт при активном поиске ручки не
                получают и «уезжали» бы влево, вплотную к своему пункту. */}
            {dragControls ? (
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                data-testid="item-drag-handle"
                disabled={isPending}
                onPointerDown={(event) => {
                  if (isPending) return;
                  // Взвод до старта жеста: границы должны быть выданы раньше,
                  // чем framer начнёт их разрешать.
                  setIsDragArmed(true);
                  dragControls.start(event);
                }}
                className="-ml-1 flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-gray-400 transition-colors hover:text-gray-600 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-600 dark:hover:text-zinc-300"
              >
                <GripIcon />
              </button>
            ) : (
              isSubItem && <span aria-hidden className="-ml-1 h-6 w-5 shrink-0" />
            )}

            {/* Порядковый номер в виде «1.» — как в обычном нумерованном
                списке: точка сама сообщает, что это нумерация, без
                утяжеления шрифтом. Выполненная запись номер не получает,
                но колонку сохраняет — иначе блок выполненных «уезжает»
                влево. Выравнивание по правому краю плюс tabular-nums
                держат точки в одной вертикали при переходе 9 → 10. */}
            {showItemNumbers && (
              <span
                aria-hidden
                data-testid="item-number"
                className={`-mr-1 ${numberColumn} shrink-0 text-right text-sm tabular-nums text-gray-400 dark:text-zinc-500`}
              >
                {numberLabel}
              </span>
            )}

            {/* Кнопка переключения статуса (чекбокс): invisible при редактировании */}
            <form
              className={editingItemId === item.id ? "invisible" : ""}
              action={async () => {
                // 1. Мгновенно меняем UI. У пункта с подпунктами отметка
                //    производная, поэтому и туда, и на сервер уходит именно
                //    она, а не собственное поле записи.
                setOptimisticItems({
                  action: "toggle",
                  itemId: item.id,
                  isCompleted: !isCompleted,
                });

                // 2. Сохраняем инверсию текущего статуса в фоне
                await api.toggleItem(item.id, isCompleted);
              }}
            >
              <Tooltip label={t("inProgress")} disabled={!isInProgress || isPending}>
                <button
                  type="submit"
                  data-testid="item-toggle"
                  data-completed={isCompleted}
                  data-status={status}
                  role="checkbox"
                  aria-checked={isInProgress ? "mixed" : isCompleted}
                  aria-label={`${isInProgress ? `${t("inProgress")}. ` : ""}${t(isCompleted ? "ariaReopen" : "ariaComplete", { name: item.name })}`}
                  disabled={isPending}
                  title={isPending ? t("saving") : undefined}
                  className={`w-5 h-5 border-2 rounded flex items-center justify-center transition-all duration-200 flex-shrink-0 ${
                    isPending
                      ? "border-gray-300 dark:border-zinc-700 cursor-not-allowed"
                      : isCompleted
                        ? "bg-gray-600 border-gray-600 dark:bg-zinc-500 dark:border-zinc-500 scale-105 shadow-sm shadow-gray-200 dark:shadow-none"
                        : isInProgress
                          ? "bg-blue-50 border-blue-500 text-blue-600 dark:bg-blue-950 dark:border-blue-400 dark:text-blue-300"
                          : "bg-white dark:bg-zinc-900 border-gray-300 dark:border-zinc-600 hover:border-gray-500 dark:hover:border-zinc-400 hover:shadow-sm"
                  }`}
                >
                  {isInProgress && !isPending ? (
                    <svg aria-hidden data-testid="item-progress-indicator" className="h-3 w-3" viewBox="0 0 16 16" fill="none">
                      <path d="M8 3a5 5 0 1 0 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  ) : isPending ? (
                    // Спиннер для ожидающей записи
                    <span className="block w-2.5 h-2.5 border-2 border-gray-400 dark:border-zinc-500 !border-t-transparent rounded-full animate-spin" />
                  ) : (
                    // Галочка для выполненной записи
                    isCompleted && (
                      <svg
                        className="w-3 h-3 text-white"
                        viewBox="0 0 12 12"
                        fill="none"
                      >
                        <path
                          d="M2 6.5l3 3 5-5"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )
                  )}
                </button>
              </Tooltip>
            </form>

            {/* Метаданные стоят ниже: длинному названию нужна вся доступная ширина. */}
            <div className="flex-1 min-w-0">
              <div
                className={`flex-1 min-w-0 flex items-center gap-1 rounded-lg px-1 -mx-1 transition-colors ${
                  !isPending && !isCompleted && editingItemId !== item.id
                    ? "group cursor-pointer hover:bg-gray-100 dark:hover:bg-zinc-700 hover:ring-1 hover:ring-gray-300 dark:hover:ring-zinc-600"
                    : ""
                }`}
                onClick={
                  !isPending && !isCompleted && editingItemId !== item.id
                    ? () => {
                        setOpenNoteItemId(null);
                        setOpenItemActionsId(null);
                        setEditingItemId(item.id);
                        setEditItemName(item.name);
                      }
                    : undefined
                }
              >
                {!isPending && editingItemId === item.id ? (
                  <textarea
                    autoFocus
                    autoComplete="off"
                    data-testid="item-name-input"
                    value={editItemName}
                    maxLength={200}
                    rows={1}
                    onFocus={(e) => {
                      e.target.select();
                      e.target.style.height = "auto";
                      e.target.style.height = e.target.scrollHeight + "px";
                    }}
                    onInput={(e) => {
                      const el = e.currentTarget;
                      el.style.height = "auto";
                      el.style.height = el.scrollHeight + "px";
                    }}
                    onChange={(e) => setEditItemName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleConfirmItemRename(item);
                      }
                      if (e.key === "Escape") {
                        skipItemBlurRef.current = true;
                        setEditingItemId(null);
                      }
                    }}
                    onBlur={() => {
                      if (skipItemBlurRef.current) {
                        skipItemBlurRef.current = false;
                        return;
                      }
                      void handleConfirmItemRename(item);
                    }}
                    className="text-sm border dark:border-zinc-600 py-2 px-1 rounded-lg bg-gray-50 dark:bg-zinc-900 focus:bg-white dark:focus:bg-zinc-950 focus:ring-1 ring-gray-800 dark:ring-zinc-500 outline-none transition w-full min-w-0 resize-none overflow-hidden"
                  />
                ) : isPending || !isCompleted ? (
                  <>
                    <span className="flex-1 min-w-0 [overflow-wrap:anywhere]" data-testid="item-name"><Highlight text={item.name} query={searchQuery} /></span>
                    {!isPending && <span className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 text-xs flex-shrink-0">✎</span>}
                  </>
                ) : (
                  <span
                    data-testid="item-name"
                    className="min-w-0 [overflow-wrap:anywhere] transition-all duration-200 line-through text-gray-400 opacity-60 cursor-default"
                  >
                    <Highlight text={item.name} query={searchQuery} />
                  </span>
                )}

              </div>

              {!isPending && showAuthors && item.addedBy && (
                <div className="mt-1">
                  <span data-testid="item-author" className="min-w-0 [overflow-wrap:anywhere] text-gray-400 text-xs">
                    {item.addedBy.id === currentUserId
                      ? t("you")
                      : item.addedBy.name || item.addedBy.email}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {!isPending && editingItemId === item.id ? (
              <>
                {/* Кнопка сохранения при редактировании */}
                <Tooltip label={commonT("save")}>
                  <button
                    type="button"
                    onMouseDown={() => { skipItemBlurRef.current = true; }}
                    onClick={() => void handleConfirmItemRename(item)}
                    className="hidden sm:inline-flex items-center justify-center w-6 h-6 rounded text-sm text-green-600 dark:text-green-500 hover:bg-green-50 dark:hover:bg-zinc-700 transition"
                  >
                    ✓
                  </button>
                </Tooltip>
                {/* Кнопка отмены при редактировании */}
                <Tooltip label={commonT("cancel")}>
                  <button
                    type="button"
                    onMouseDown={() => { skipItemBlurRef.current = true; }}
                    onClick={() => setEditingItemId(null)}
                    className="inline-flex items-center justify-center w-6 h-6 rounded text-sm text-gray-400 dark:text-zinc-500 hover:bg-gray-100 dark:hover:bg-zinc-700 hover:text-gray-600 dark:hover:text-zinc-300 transition"
                  >
                    ✗
                  </button>
                </Tooltip>
              </>
            ) : (
              <>
                {/* Сворачивание блока подпунктов. Счётчик показывается только у
                    свёрнутого: у раскрытого те же числа читаются с самих
                    подпунктов, а у свёрнутого это единственный способ понять,
                    что там осталось. Тумблер у него общий со сводкой в шапке
                    карточки — число по смыслу одно и то же, просто на разных
                    уровнях, и два переключателя было бы нечем объяснить.

                    При активном поиске кнопки нет вовсе: блоки там раскрыты
                    принудительно, и кнопка выглядела бы сломанной — нажатие
                    меняло бы сохранённое состояние, ничего не меняя на экране.
                    Тот же приём, что с пунктами перемещения. */}
                {context.block && visibleItemIds === null && (
                  <>
                    {context.block.isCollapsed && showItemsCounter && (
                      <span
                        data-testid="sub-items-counter"
                        aria-label={t("ariaSubItemsCounter", {
                          done: context.block.done,
                          total: context.block.total,
                        })}
                        className="mr-0.5 text-xs tabular-nums text-gray-400 dark:text-zinc-500"
                      >
                        {context.block.done} / {context.block.total}
                      </span>
                    )}
                    <Tooltip
                      label={
                        context.block.isCollapsed
                          ? t("expandSubItems")
                          : t("collapseSubItems")
                      }
                    >
                      <button
                        type="button"
                        data-testid="sub-items-toggle"
                        disabled={isPending}
                        onClick={context.block.onToggle}
                        aria-label={t("ariaSubItemsToggle", { name: item.name })}
                        aria-expanded={!context.block.isCollapsed}
                        className="inline-flex h-7 w-7 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      >
                        <CollapseChevron isCollapsed={context.block.isCollapsed} />
                      </button>
                    </Tooltip>
                  </>
                )}

                {/* Заполненная заметка остаётся доступна отдельной кнопкой. */}
                {item.note && (
                  <Tooltip label={notesT("itemNote")}>
                    <button
                      type="button"
                      data-testid="item-note-toggle"
                      disabled={isPending}
                      onClick={() => {
                        setEditingItemId(null);
                        setOpenItemActionsId(null);
                        setOpenNoteItemId((current) =>
                          current === item.id ? null : item.id,
                        );
                      }}
                      aria-expanded={openNoteItemId === item.id}
                      className="inline-flex h-7 w-7 items-center justify-center rounded text-indigo-500 transition-colors hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-950/40"
                    >
                      <NoteIcon filled />
                    </button>
                  </Tooltip>
                )}
                {/* Меню действий записи: безопасное место для удаления и будущих команд. */}
                <div
                  ref={openItemActionsId === item.id ? itemActionsMenuRef : undefined}
                  className="relative"
                >
                  {/* Свой `aria-label` подробнее подсказки: скринридеру нужно
                      название записи, а в подсказке оно рядом и так. */}
                  <Tooltip
                    label={t("itemActions")}
                    disabled={openItemActionsId === item.id}
                  >
                    <button
                      ref={openItemActionsId === item.id ? itemActionsButtonRef : undefined}
                      type="button"
                      data-testid="item-menu-trigger"
                      disabled={isPending}
                      title={isPending ? t("saving") : undefined}
                      onClick={(event) => {
                        setEditingItemId(null);
                        setOpenNoteItemId(null);
                        if (openItemActionsId === item.id) {
                          setOpenItemActionsId(null);
                          return;
                        }
                        openItemActions(item.id, event.currentTarget);
                      }}
                      aria-label={t("ariaItemActions", { name: item.name })}
                      aria-haspopup="menu"
                      aria-expanded={openItemActionsId === item.id}
                      aria-controls={`item-actions-${item.id}`}
                      className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors ${
                        openItemActionsId === item.id
                          ? "bg-gray-100 text-gray-900 dark:bg-zinc-800 dark:text-white"
                          : "text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      } disabled:cursor-not-allowed disabled:text-gray-300 dark:disabled:text-zinc-700`}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="currentColor"
                        aria-hidden
                      >
                        <circle cx="12" cy="5" r="1.75" />
                        <circle cx="12" cy="12" r="1.75" />
                        <circle cx="12" cy="19" r="1.75" />
                      </svg>
                    </button>
                  </Tooltip>

                  {openItemActionsId === item.id && itemActionsAnchor && (
                    <div
                      ref={itemActionsPanelRef}
                      id={`item-actions-${item.id}`}
                      role="menu"
                      data-testid="item-menu"
                      style={{
                        top: itemActionsAnchor.top,
                        bottom: itemActionsAnchor.bottom,
                        right: itemActionsAnchor.right,
                      }}
                      className="fixed z-40 min-w-48 rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg dark:border-zinc-700 dark:bg-zinc-800 dark:shadow-black/60"
                    >
                      {!isCompleted && (
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="item-progress-action"
                          onClick={() => {
                            setOpenItemActionsId(null);
                            const next: ItemStatus = isInProgress ? "NOT_STARTED" : "IN_PROGRESS";
                            startTransition(async () => {
                              setOptimisticItems({ action: "status", itemId: item.id, status: next });
                              try {
                                const result = await api.setItemStatus(item.id, next);
                                if (!result.success) toast.error(t("errors.statusFailed"));
                              } catch {
                                toast.error(t("errors.statusFailed"));
                              }
                            });
                          }}
                          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                        >
                          <span aria-hidden className="inline-flex h-4 w-4 items-center justify-center rounded border border-blue-500 text-blue-600 dark:text-blue-300">−</span>
                          {t(isInProgress ? "resetProgress" : "startProgress")}
                        </button>
                      )}
                      {/* Перемещение доступно только у невыполненных
                          записей: выполненные нумерации не имеют и
                          живут отдельным блоком внизу. Подпункт двигается
                          среди подпунктов своего родителя — уровни
                          независимы, и «выше» никогда не выносит его наружу. */}
                      {context.canReorder && !isCompleted && (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="item-move-up"
                            disabled={!context.canMoveUp}
                            onClick={() => {
                              setOpenItemActionsId(null);
                              handleMoveItem(item, "up", context.siblings);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-zinc-200 dark:hover:bg-zinc-700"
                          >
                            <MoveUpIcon />
                            {t("moveUp")}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="item-move-down"
                            disabled={!context.canMoveDown}
                            onClick={() => {
                              setOpenItemActionsId(null);
                              handleMoveItem(item, "down", context.siblings);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-zinc-200 dark:hover:bg-zinc-700"
                          >
                            <MoveDownIcon />
                            {t("moveDown")}
                          </button>

                          <div
                            role="separator"
                            className="my-1 h-px bg-gray-100 dark:bg-zinc-700"
                          />
                        </>
                      )}

                      {/* Разбиение на подпункты ничего не сохраняет: пункт
                          становится родительским только с появлением первого
                          подпункта. Поэтому команда просто открывает поле
                          ввода, а её подпись зависит от того, есть ли уже
                          подпункты. У выполненного пункта команды нет:
                          разбивать сделанное незачем, а первый же подпункт
                          вернул бы его в невыполненные. */}
                      {!isSubItem && !isCompleted && (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="item-add-sub-item"
                            onClick={() => {
                              setOpenItemActionsId(null);
                              setNewSubItemName("");
                              setAddSubItemParentId(item.id);
                              // Свёрнутый блок раскрываем: иначе поле ввода
                              // оказалось бы спрятано вместе с подпунктами.
                              if (context.block?.isCollapsed) {
                                context.block.onToggle();
                              }
                            }}
                            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                          >
                            <SubItemsIcon />
                            {context.block
                              ? t("addSubItem")
                              : t("splitIntoSubItems")}
                          </button>

                          <div
                            role="separator"
                            className="my-1 h-px bg-gray-100 dark:bg-zinc-700"
                          />
                        </>
                      )}

                      {/* Перенос в другой список показывается, только когда
                          в пространстве есть куда переносить. Подпункт
                          принадлежит родителю и отдельно никуда не едет —
                          он уезжает вместе с ним. */}
                      {hasMoveTargets && !isSubItem && (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="item-move-to-list"
                            onClick={() => {
                              setOpenItemActionsId(null);
                              setItemToMove(item);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                          >
                            <MoveToListIcon />
                            {t("moveToListAction")}
                          </button>

                          <div
                            role="separator"
                            className="my-1 h-px bg-gray-100 dark:bg-zinc-700"
                          />
                        </>
                      )}

                      {!item.note && (
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="item-note-add"
                          onClick={() => {
                            setOpenItemActionsId(null);
                            setOpenNoteItemId(item.id);
                          }}
                          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                        >
                          <NoteIcon size={17} />
                          {notesT("addItemNote")}
                        </button>
                      )}

                      {/* Удаление заметки записи — без удаления самой записи,
                          поэтому пункт нейтральный, а не красный. */}
                      {item.note && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setOpenItemActionsId(null);
                            setNoteToDeleteItemId(item.id);
                          }}
                          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                        >
                          <NoteRemoveIcon />
                          {notesT("deleteNote")}
                        </button>
                      )}

                      <div
                        role="separator"
                        className="my-1 h-px bg-gray-100 dark:bg-zinc-700"
                      />

                      <button
                        type="button"
                        role="menuitem"
                        data-testid="item-delete"
                        onClick={() => {
                          setOpenItemActionsId(null);
                          setItemToDelete(item);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                      >
                        <TrashIcon />
                        {t("deleteItemAction")}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          </div>

          {noteMatchesSearch && item.note && openNoteItemId !== item.id && (
            <p className={`${rowIndent} mt-1.5 rounded-md bg-white/70 px-2 py-1.5 text-xs leading-relaxed text-gray-500 dark:bg-zinc-900/50 dark:text-zinc-400`}>
              <Highlight text={getNoteExcerpt(item.note, searchQuery)} query={searchQuery} />
            </p>
          )}

          {!isPending && openNoteItemId === item.id && (
            <div className={rowIndent}>
              <NotePanel
                note={item.note}
                version={item.noteVersion}
                title={item.name}
                compact
                searchQuery={searchQuery}
                onSave={(draft, expectedVersion) =>
                  api.updateItemNote(item.id, draft, expectedVersion)
                }
                onClose={() => setOpenNoteItemId(null)}
              />
            </div>
          )}
      </>
    );
  };

  /**
   * Рендерит блок: строку пункта, его подпункты и поле ввода нового подпункта.
   *
   * Подпункты лежат ВНУТРИ элемента списка родителя. Это не только про отступ:
   * при перетаскивании пункта framer двигает один DOM-узел, и подпункты едут
   * вместе с ним, ничего не зная о жесте.
   */
  const renderNode = (node: ItemNode<Item>, dragControls: DragControls | null) => {
    const isAddingHere = addSubItemParentId === node.item.id;
    const isCollapsed = isBlockCollapsed(node);

    /** Невыполненные подпункты — только они участвуют в перестановке. */
    const activeSubItems = node.subItems
      .filter((sub) => !sub.item.isCompleted)
      .map((sub) => sub.item);
    const completedSubItems = node.subItems.filter(
      (sub) => sub.item.isCompleted,
    );

    /**
     * Уровень подпунктов независим от уровня пунктов: список из одного пункта
     * не мешает переставлять его подпункты, и наоборот. Поиск запрещает
     * перестановку на обоих — видно подмножество, и «выше» перескакивало бы
     * через скрытое.
     */
    const canReorderSubItems =
      visibleItemIds === null && activeSubItems.length > 1;

    /** Порядок подпунктов: во время их жеста — набранный, иначе серверный. */
    const draggableSubItems =
      dragOrder?.level === node.item.id ? dragOrder.items : activeSubItems;

    /** Узел подпункта по ID: во время жеста порядок задан массивом записей. */
    const subNodeById = new Map(
      node.subItems.map((sub) => [sub.item.id, sub]),
    );

    /** Контекст строки подпункта. Номер берётся из дерева, а не из порядка жеста. */
    const subContext = (subItemId: string): RowContext => {
      const sub = subNodeById.get(subItemId);
      return {
        isCompleted: sub?.item.isCompleted ?? false,
        status: sub ? getItemStatus(sub.item) : "NOT_STARTED",
        // Номер подпункта показывается вместе с номером родителя:
        // «3.2.» читается сразу, а «2.» посреди чужого блока — нет.
        numberLabel:
          node.number && sub?.number ? `${node.number}.${sub.number}.` : "",
        isSubItem: true,
        canReorder: canReorderSubItems,
        canMoveUp: sub?.number !== undefined && sub.number > 1,
        canMoveDown:
          sub?.number !== undefined && sub.number < activeSubItems.length,
        siblings: activeSubItems,
      };
    };

    return (
      <>
        {renderItemRow(node.item, dragControls, {
          isCompleted: node.isCompleted,
          status: node.status,
          numberLabel: node.number ? `${node.number}.` : "",
          isSubItem: false,
          canReorder: canReorderItems,
          canMoveUp: node.number !== undefined && node.number > 1,
          canMoveDown:
            node.number !== undefined && node.number < activeItemsCount,
          siblings: activeVisibleItems,
          block:
            node.subItems.length > 0
              ? {
                  isCollapsed,
                  total: node.subItems.length,
                  done: node.subItems.filter((sub) => sub.item.isCompleted)
                    .length,
                  onToggle: () => handleToggleBlock(node),
                }
              : undefined,
        })}

        {/* Свёрнутый блок размонтируется целиком, а не прячется стилем: у
            карточки списка тело оставлено в DOM ради анимации высоты, здесь же
            анимации нет, и скрытая разметка только осталась бы доступной
            поиску по странице. */}
        {!isCollapsed && (node.subItems.length > 0 || isAddingHere) && (
          <SubItemsList
            reorderable={canReorderSubItems}
            values={draggableSubItems}
            onReorder={(items) =>
              setDragOrder({ level: node.item.id, items })
            }
            label={t("subItemsLabel", { name: node.item.name })}
          >
            {/* Вложенная Reorder.Group внутри Reorder.Item родителя работает
                потому, что оба уровня начинают жест только с ручки
                (`dragListener={false}` + `useDragControls`). Иначе pointer на
                подпункте поднимал бы весь блок. */}
            {canReorderSubItems
              ? draggableSubItems.map((subItem) => (
                  <DraggableItemRow
                    key={subItem.id}
                    item={subItem}
                    testId="sub-item"
                    className={rowClassName(subItem, subItem.isCompleted)}
                    isDragActive={draggingItemId !== null}
                    isGestureArmed={isDragArmed || draggingItemId !== null}
                    onDragStart={() =>
                      handleDragStart(node.item.id, subItem, activeSubItems)
                    }
                    onDragEnd={() =>
                      handleDragEnd(node.item.id, subItem, activeSubItems)
                    }
                  >
                    {(subDragControls) =>
                      renderItemRow(subItem, subDragControls, subContext(subItem.id))
                    }
                  </DraggableItemRow>
                ))
              : activeSubItems.map((subItem) => (
                  <li
                    key={subItem.id}
                    data-testid="sub-item"
                    data-item-id={subItem.id}
                    className={rowClassName(subItem, subItem.isCompleted)}
                  >
                    {renderItemRow(subItem, null, subContext(subItem.id))}
                  </li>
                ))}

            {completedSubItems.map((sub) => (
              <li
                key={sub.item.id}
                data-testid="sub-item"
                data-item-id={sub.item.id}
                className={rowClassName(sub.item, true)}
              >
                {renderItemRow(sub.item, null, subContext(sub.item.id))}
              </li>
            ))}

            {isAddingHere && (
              <li className="py-2 px-1">
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleAddSubItem(node.item.id);
                  }}
                  className="flex gap-2"
                >
                  <input
                    autoFocus
                    name="subItemName"
                    autoComplete="off"
                    data-testid="add-sub-item-input"
                    placeholder={t("subItemPlaceholder")}
                    value={newSubItemName}
                    onChange={(event) => setNewSubItemName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setAddSubItemParentId(null);
                    }}
                    maxLength={200}
                    required
                    className="w-full min-w-0 rounded-lg border bg-gray-50 p-1.5 text-sm outline-none transition focus:bg-white focus:ring-1 ring-gray-800 dark:border-zinc-700 dark:bg-zinc-900 dark:ring-zinc-500 dark:focus:bg-zinc-950"
                  />
                  <button
                    type="submit"
                    data-testid="add-sub-item-submit"
                    aria-label={t("subItemPlaceholder")}
                    className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gray-800 text-white shadow-sm transition-all duration-150 hover:bg-gray-700 active:scale-95 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                  <Tooltip label={t("closeSubItemInput")}>
                    <button
                      type="button"
                      data-testid="add-sub-item-close"
                      onClick={() => setAddSubItemParentId(null)}
                      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                    >
                      ✗
                    </button>
                  </Tooltip>
                </form>
              </li>
            )}
          </SubItemsList>
        )}
      </>
    );
  };

  return (
    <>
      <div>
        {/* -----------------------------------------------------------------------
          Список записей.

          Когда жест доступен, невыполненные блоки живут внутри Reorder.Group,
          а выполненные идут следом обычными li: переставлять их некуда,
          нумерации у них нет, и в другой список они уходят только через меню.
          Плоский ul остаётся для случаев, когда жеста нет вовсе, — активный
          поиск, пустой список и единственная запись в единственном списке.
      ----------------------------------------------------------------------- */}
        {canDragItems ? (
          <Reorder.Group
            as="ul"
            axis="y"
            values={draggableItems}
            onReorder={(items) => setDragOrder({ level: null, items })}
            data-testid="items-list"
            className="mb-4 divide-y divide-gray-100 dark:divide-zinc-800"
          >
            {draggableItems.map((item) => {
              const node = nodeById.get(item.id);
              if (!node) return null;
              return (
                <DraggableItemRow
                  key={item.id}
                  item={item}
                  className={rowClassName(item, node.isCompleted)}
                  isDragActive={draggingItemId !== null}
                  isGestureArmed={isDragArmed || draggingItemId !== null}
                  onDragStart={() =>
                    handleDragStart(null, item, activeVisibleItems)
                  }
                  onDragMove={hasMoveTargets ? handleDragMove : undefined}
                  onDragEnd={() => handleDragEnd(null, item, activeVisibleItems)}
                >
                  {(dragControls) => renderNode(node, dragControls)}
                </DraggableItemRow>
              );
            })}

            {completedVisibleNodes.map((node) => (
              <li
                key={node.item.id}
                data-testid="item"
                data-item-id={node.item.id}
                className={rowClassName(node.item, node.isCompleted)}
              >
                {renderNode(node, null)}
              </li>
            ))}
          </Reorder.Group>
        ) : (
          <ul
            data-testid="items-list"
            className="mb-4 divide-y divide-gray-100 dark:divide-zinc-800"
          >
            {visibleNodes.map((node) => (
              <li
                key={node.item.id}
                data-testid="item"
                data-item-id={node.item.id}
                className={rowClassName(node.item, node.isCompleted)}
              >
                {renderNode(node, null)}
              </li>
            ))}

            {/* Сообщение о пустом списке */}
            {visibleNodes.length === 0 && (
              <li className="text-gray-400 text-sm text-center">{t("empty")}</li>
            )}
          </ul>
        )}

        {/* -----------------------------------------------------------------------
          Форма добавления новой записи
      ----------------------------------------------------------------------- */}
        <form
          onSubmit={async (event) => {
            event.preventDefault();

            const trimmedName = newItemName.trim();
            if (!trimmedName || isAddingItem) return;

            // 1. Генерируем временный ID для оптимистичного обновления
            const tempId = `temp-${Date.now()}`;

            // 2. Мгновенно добавляем запись на экран
            startTransition(() => {
              setOptimisticItems({
                action: "add",
                itemId: tempId,
                itemName: trimmedName,
                addedBy: {
                  id: currentUserId,
                  name: currentUserName,
                  email: currentUserEmail,
                },
              });
            });

            // 3. Сразу очищаем поле ввода (пользователь может начинать следующий)
            setNewItemName("");
            setIsAddingItem(true);

            // 4. Сохраняем запись в фоне (БД или localStorage — решает адаптер)
            const result = await api.addItem(listId, trimmedName);

            setIsAddingItem(false);

            // 5. При ошибке — откат: удаляем временную запись и возвращаем введённое название
            if (result && !result.success) {
              startTransition(() => {
                setOptimisticItems({ action: "delete", itemId: tempId });
              });
              setNewItemName(trimmedName);
              toast.error(addItemErrorMessage(result.error));
            }
          }}
          className="flex gap-2"
        >
          <input
            name="itemName"
            autoComplete="off"
            data-testid="add-item-input"
            placeholder={t("placeholder")}
            className="border dark:border-zinc-700 p-2 rounded-lg w-full text-sm bg-gray-50 dark:bg-zinc-900 focus:bg-white dark:focus:bg-zinc-950 focus:ring-1 ring-gray-800 dark:ring-zinc-500 outline-none transition"
            value={newItemName}
            onChange={(e) => setNewItemName(e.target.value)}
            maxLength={200}
            required
          />
          <button
            type="submit"
            data-testid="add-item-submit"
            aria-label={t("placeholder")}
            className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-gray-800 text-white dark:bg-zinc-100 dark:text-zinc-900 hover:bg-gray-700 dark:hover:bg-white active:scale-95 transition-all duration-150 shadow-sm"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </form>
      </div>

      {/* -----------------------------------------------------------------------
          Модальное окно подтверждения удаления записи.
          Клик на фон (overlay) — закрыть без удаления.
          Клик внутри модала — не закрывает (stopPropagation).
      ----------------------------------------------------------------------- */}
      {itemToDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4"
          onClick={() => setItemToDelete(null)}
        >
          <div
            data-testid="item-delete-modal"
            className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-800 dark:border dark:border-zinc-700 p-5 shadow-lg dark:shadow-2xl dark:shadow-black/70"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-2">
              {t("deleteModal.title")}
            </h3>
            {/* Удаление пункта уносит его подпункты, и об этом нужно
                предупредить: на экране они могут быть свёрнуты, а отменить
                удаление нельзя. */}
            <p data-testid="item-delete-body" className="text-sm [overflow-wrap:anywhere] text-gray-600 dark:text-zinc-400 mb-5">
              {itemToDeleteSubCount > 0
                ? t("deleteModal.bodyWithSubItems", {
                    name: itemToDelete.name,
                    count: itemToDeleteSubCount,
                  })
                : t("deleteModal.body", { name: itemToDelete.name })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-testid="item-delete-cancel"
                onClick={() => setItemToDelete(null)}
                className="px-3 py-2 rounded-md text-sm border border-gray-300 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800"
              >
                {t("deleteModal.cancel")}
              </button>
              <button
                type="button"
                data-testid="item-delete-confirm"
                onClick={handleConfirmDeleteItem}
                className="px-3 py-2 rounded-md text-sm bg-red-600 text-white hover:bg-red-700"
              >
                {t("deleteModal.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Подтверждение удаления заметки записи: вызывается из меню действий. */}
      {noteDeleteItem && (
        <DeleteNoteModal
          version={noteDeleteItem.noteVersion}
          onSave={(draft, expectedVersion) =>
            api.updateItemNote(noteDeleteItem.id, draft, expectedVersion)
          }
          onDeleted={() => {
            setNoteToDeleteItemId(null);
            setOpenNoteItemId((current) =>
              current === noteDeleteItem.id ? null : current,
            );
          }}
          onCancel={() => setNoteToDeleteItemId(null)}
        />
      )}

      {/* Выбор списка-получателя: клик по строке сразу выполняет действие. */}
      {itemToMove && (
        <MoveItemModal
          sourceListId={listId}
          onSelect={(targetListId, mode) =>
            handleMoveItemToList(itemToMove, targetListId, mode)
          }
          onClose={() => setItemToMove(null)}
        />
      )}

      {/* Плашка, следующая за указателем за пределами своей карточки.
          Сама строка туда не доедет: `Reorder.Group axis="y"` двигает её
          только по вертикали, а карточки стоят в колонках — уже соседняя
          колонка для неё недостижима. Поэтому за курсор цепляется отдельное
          превью, как overlay у перетаскиваемых карточек списков.

          Положение и видимость пишутся прямо в DOM из `handleDragMove`:
          через состояние каждый кадр жеста перерисовывал бы весь список.
          Начальный `display: none` — на старте указатель всегда внутри своей
          карточки, и показывать превью там нечего и незачем. */}
      {draggedAwayItem && (
        <div
          ref={dragPreviewRef}
          aria-hidden
          data-testid="item-drag-preview"
          style={{
            display: "none",
            transform: "translate3d(-9999px, -9999px, 0)",
          }}
          className="pointer-events-none fixed left-0 top-0 z-50 max-w-64 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm shadow-xl dark:border-zinc-700 dark:bg-zinc-800 dark:shadow-black/70"
        >
          <span className="shrink-0 text-gray-400 dark:text-zinc-500">
            <MoveToListIcon size={15} />
          </span>
          <span className="truncate">{draggedAwayItem.name}</span>
        </div>
      )}
    </>
  );
}
