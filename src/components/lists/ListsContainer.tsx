/**
 * @file ListsContainer.tsx
 * @description Главный контейнер списков пользователя.
 *
 * Client Component (`"use client"`).
 *
 * Компонент отвечает исключительно за управление состоянием и координацию
 * дочерних компонентов. Весь UI вынесен в отдельные компоненты:
 *   - `ListCard`      — карточка отдельного списка.
 *   - `ListsTopPanel` — панель с вкладками Создать/Поиск и переключателем авторов.
 *   - `ConfirmModal`  — переиспользуемый модал подтверждения действия.
 *
 * Оптимистичные обновления (`useOptimistic`):
 *   Список обновляется МГНОВЕННО на клиенте, не дожидаясь ответа сервера.
 *   Если Server Action вернул ошибку — изменение откатывается.
 *
 * Поддерживаемые действия reducer:
 *   - `add`     — добавить новый список (используется при создании).
 *   - `delete`  — удалить список по id.
 *   - `restore` — восстановить список на исходную позицию (откат удаления).
 *   - `replace` — заменить оптимистичный список реальным (после ответа сервера).
 *   - `rename`  — обновить название списка (оптимистично или откат).
 *
 * Удаление через модальное окно:
 *   Клик на ✕ → модал → подтверждение/отмена (или Esc/Enter с клавиатуры).
 */

"use client";

import {
  forwardRef,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useListsApi } from "@/components/providers/ListsApiProvider";
import { ListsDirectoryProvider } from "@/components/providers/ListsDirectoryProvider";
import { CollapsedItemsProvider } from "@/components/providers/CollapsedItemsProvider";
import toast from "react-hot-toast";
import CreateListForm from "@/components/lists/CreateListForm";
import { useTranslations } from "next-intl";
import { useSettings } from "@/components/providers/SettingsProvider";
import { useRouter } from "next/navigation";
import { getPusherClient } from "@/lib/pusher-client";
import {
  beginDrag,
  deferRefreshWhileDragging,
  endDrag,
} from "@/lib/drag-gate";
import { randomUUID } from "@/lib/uuid";
import {
  parseCollapsedIds,
  pruneCollapsedIds,
  serializeCollapsedIds,
  toggleCollapsedId,
} from "@/lib/collapsed-ids";
import { buildItemTree } from "@/lib/item-tree";
import { listsInGroupOrder, splitIntoColumns } from "@/lib/list-columns";
import { useMediaQuery } from "@/lib/use-media-query";
import { MAX_GROUPS_PER_SPACE, MAX_LISTS_PER_SPACE } from "@/lib/limits";
import ListCard, { type ListData, type ListGroup } from "@/components/lists/ListCard";
import ListsTopPanel from "@/components/lists/ListsTopPanel";
import ConfirmModal from "@/components/ui/ConfirmModal";
import GroupFilter from "@/components/lists/GroupFilter";

/**
 * Промежуток между `md` и `xl` из Tailwind.
 *
 * Единственное место, где брейкпоинт продублирован в коде, — и он существует
 * только ради двух колонок на средних экранах. Значения в `rem`, потому что
 * Tailwind 4 задаёт брейкпоинты в них же: в пикселях они разъедутся при
 * нестандартном размере шрифта.
 */
const MEDIUM_SCREEN_QUERY = "(min-width: 48rem) and (max-width: 79.999rem)";

const listDndId = (listId: string) => `list:${listId}`;

/**
 * Sortable-обёртка карточки.
 *
 * Transform живёт на том же motion-узле, который уже отвечал за появление и
 * исчезновение карточки. Масштаб из rectSortingStrategy намеренно отбрасываем:
 * карточки разной высоты не должны сплющивать содержимое при обмене местами.
 */
type SortableListCardProps = {
  list: ListData;
  showHandle: boolean;
  disabled: boolean;
  isCollapsed: boolean;
  dragLabel: string;
  children: (dragHandle: ReactNode) => ReactNode;
};

const SortableListCard = forwardRef<HTMLDivElement, SortableListCardProps>(
  function SortableListCard(
    { list, showHandle, disabled, isCollapsed, dragLabel, children },
    presenceRef,
  ) {
    const {
      attributes,
      listeners,
      setActivatorNodeRef,
      setNodeRef,
      transform,
      transition,
      isDragging,
    } = useSortable({
      id: listDndId(list.id),
      disabled,
      data: { type: "list", listId: list.id },
    });

    // `popLayout` передаёт ref непосредственному ребёнку AnimatePresence.
    // Объединяем его с ref dnd-kit, чтобы исчезающая при смене колонки копия
    // сразу выпадала из flex-раскладки, не теряя измерения и exit-анимацию.
    const setCombinedNodeRef = useCallback(
      (node: HTMLDivElement | null) => {
        setNodeRef(node);
        if (typeof presenceRef === "function") {
          presenceRef(node);
        } else if (presenceRef) {
          presenceRef.current = node;
        }
      },
      [presenceRef, setNodeRef],
    );

    const dragHandle = showHandle ? (
      <button
        ref={setActivatorNodeRef}
        type="button"
        data-testid="list-drag-handle"
        disabled={disabled}
        {...attributes}
        {...listeners}
        aria-label={dragLabel}
        className="inline-flex h-6 w-6 flex-shrink-0 touch-none cursor-grab items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 active:cursor-grabbing disabled:cursor-wait disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-gray-400 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:disabled:hover:bg-transparent dark:disabled:hover:text-zinc-500"
      >
        <GripVertical aria-hidden size={16} strokeWidth={2.2} />
      </button>
    ) : null;

    return (
      <motion.div
        ref={setCombinedNodeRef}
        style={{
          transform: CSS.Translate.toString(transform),
          transition,
          zIndex: isDragging ? 30 : undefined,
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: isDragging ? (isCollapsed ? 0.18 : 0) : 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: isDragging && !isCollapsed ? 0 : 0.15 }}
        data-testid="list-sortable"
        data-list-id={list.id}
        data-drag-projection={
          isDragging ? (isCollapsed ? "visible" : "hidden") : "idle"
        }
      >
        {children(dragHandle)}
      </motion.div>
    );
  },
);

/** Пропсы компонента `ListsContainer`. */
type ListsContainerProps = {
  /** Все списки, доступные пользователю (свои + расшаренные). Загружаются на сервере. */
  allLists: ListData[];
  /** ID текущего авторизованного пользователя. Используется для проверки прав. */
  currentUserId: string;
  /** Имя текущего пользователя (для оптимистичного placeholder нового списка). */
  currentUserName: string | null;
  /** Email текущего пользователя (аналогично). */
  currentUserEmail: string;
  /** Группы списков текущего пользователя. */
  userGroups: ListGroup[];
  /** Пространство авторизованного пользователя; у гостя остаётся один default-контекст. */
  spaceId?: string;
};

/**
 * Главный контейнер списков.
 *
 * Управляет состоянием и координирует дочерние компоненты:
 * `ListCard`, `ListsTopPanel`, `ConfirmModal`.
 *
 * @param allLists - Начальные данные со всеми доступными списками.
 * @param currentUserId - ID авторизованного пользователя.
 * @param currentUserName - Имя авторизованного пользователя.
 * @param currentUserEmail - Email авторизованного пользователя.
 */
export default function ListsContainer({
  allLists,
  currentUserId,
  currentUserName,
  currentUserEmail,
  userGroups: initialGroups,
  spaceId = "default",
}: ListsContainerProps) {
  const t = useTranslations("ListsContainer");
  const router = useRouter();
  const { showAuthors, showItemNumbers, showItemsCounter } = useSettings();

  // Адаптер операций: Server Actions (авторизованный) или localStorage (гость)
  const api = useListsApi();

  // Ключи localStorage для UI-настроек: у гостя свои, чтобы значения
  // (например, ID активной группы) не пересекались с аккаунтом в этом браузере
  const tabStorageKey = api.isGuest ? "guest:activeTab" : "activeTab";
  // Свёрнутость верхней панели общая для всех пространств, как и активная
  // вкладка: панель одна и та же везде, а её состояние — привычка работы с
  // интерфейсом на этом устройстве, а не свойство конкретного пространства.
  const panelStorageKey = api.isGuest ? "guest:topPanel" : "topPanel";
  const groupStorageKey = api.isGuest
    ? "guest:activeGroupId"
    : `activeGroupId:${spaceId}`;
  const collapsedStorageKey = api.isGuest
    ? "guest:collapsedLists"
    : `collapsedLists:${spaceId}`;
  const collapsedItemsStorageKey = api.isGuest
    ? "guest:collapsedItems"
    : `collapsedItems:${spaceId}`;

  /**
   * Список, ожидающий подтверждения удаления.
   * `null` означает, что модальное окно закрыто.
   */
  const [listToDelete, setListToDelete] = useState<ListData | null>(null);

  /** Флаг ожидания ответа сервера при удалении. Блокирует повторные запросы. */
  const [isDeleting, setIsDeleting] = useState(false);

  /**
   * Расшаренный список, от которого пользователь хочет отписаться.
   * `null` означает, что модальное окно закрыто.
   */
  const [listToLeave, setListToLeave] = useState<ListData | null>(null);

  /** Флаг ожидания ответа сервера при выходе из расшаренного списка. */
  const [isLeaving, setIsLeaving] = useState(false);

  /** Группы пользователя (оптимистично обновляемые). */
  const [groups, setGroups] = useState<ListGroup[]>(initialGroups);

  /** Группа, ожидающая подтверждения удаления. null — модал закрыт. */
  const [groupToDelete, setGroupToDelete] = useState<ListGroup | null>(null);

  /** Флаг ожидания ответа сервера при удалении группы. */
  const [isDeletingGroup, setIsDeletingGroup] = useState(false);

  /** Флаг сохранения нового порядка групп. Блокирует пересекающиеся мутации. */
  const [isReorderingGroup, setIsReorderingGroup] = useState(false);

  /** Флаг сохранения порядка/назначения списка через DnD. */
  const [isReorderingList, setIsReorderingList] = useState(false);

  /** Тип и ID поднятой сущности; нужен overlay и подсветке drop-target. */
  const [activeDrag, setActiveDrag] = useState<{
    type: "group" | "list";
    id: string;
  } | null>(null);

  /** Вкладка группы под карточкой во время переноса. */
  const [listDropTargetGroupId, setListDropTargetGroupId] = useState<
    string | null
  >(null);

  /** Активный фильтр группы. null = показывать все списки. Сохраняется в localStorage. */
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);

  /**
   * ID свёрнутых карточек.
   *
   * Свёрнутость — персональная настройка отображения на устройство: в БД её
   * нет, участникам расшаренного списка она не видна. Набор живёт здесь, а не
   * в состоянии `ListCard`, потому что отсюда он попадает в localStorage тем же
   * порядком, что и активная группа, — одним ключом на пространство.
   */
  const [collapsedListIds, setCollapsedListIds] = useState<Set<string>>(
    () => new Set(),
  );

  /**
   * ID пунктов со свёрнутыми подпунктами.
   *
   * Живут здесь по той же причине, что и свёрнутые карточки, плюс одна своя:
   * уборка исчезнувших ID требует знать все записи пространства сразу, а
   * отдельный `SmartList` видит только свой список.
   */
  const [collapsedItemIds, setCollapsedItemIds] = useState<Set<string>>(
    () => new Set(),
  );

  // isSearchOpen: управляет видимостью поля поиска. Сохраняется в localStorage.
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  /**
   * Свёрнута ли верхняя панель создания и поиска.
   *
   * По умолчанию раскрыта, поэтому серверная разметка совпадает с первым
   * клиентским рендером: сохранённое значение приезжает эффектом после
   * гидрации, как активная вкладка и набор свёрнутых карточек.
   */
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false);

  /**
   * Разрешена ли анимация сворачивания панели.
   *
   * Сохранённое значение приезжает эффектом после гидрации: сервер отрисовал
   * панель раскрытой, и её закрытие на загрузке — восстановление, а не действие
   * пользователя. Анимировать там нечего: 180 мс схлопывания в самом верху
   * страницы сдвигают всё под ней и читаются как сбой. Флаг включает первое же
   * переключение руками.
   */
  const [isPanelAnimated, setIsPanelAnimated] = useState(false);

  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  // isPending: true пока React рендерит результаты поиска (низкоприоритетный переход)
  const [isPending, startSearchTransition] = useTransition();

  // isSearching: true в промежутке между вводом и применением дебаунса —
  // используется для показа лоадера в поле поиска. Выводится из состояния,
  // а не хранится отдельно (иначе setState в эффекте — cascading renders).
  const isSearching = searchInput !== searchQuery;

  // Debounce: применяем поисковый запрос с задержкой 350мс,
  // чтобы не пересчитывать filteredLists при каждом нажатии клавиши.
  // startSearchTransition помечает обновление searchQuery как низкоприоритетное —
  // React не блокирует UI пока пересчитывает filteredLists.
  useEffect(() => {
    const timer = setTimeout(() => {
      startSearchTransition(() => {
        setSearchQuery(searchInput);
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Читаем сохранённые значения из localStorage только после гидрации,
  // чтобы не было расхождения между серверным и клиентским HTML.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsSearchOpen(localStorage.getItem(tabStorageKey) === "search");
    setIsPanelCollapsed(localStorage.getItem(panelStorageKey) === "collapsed");
    const savedGroupId = localStorage.getItem(groupStorageKey);
    if (savedGroupId) setActiveGroupId(savedGroupId);
  }, [tabStorageKey, panelStorageKey, groupStorageKey]);

  /** Сворачивает или разворачивает верхнюю панель, запоминая выбор. */
  const handleTogglePanel = useCallback(() => {
    setIsPanelAnimated(true);
    setIsPanelCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(panelStorageKey, next ? "collapsed" : "expanded");
      return next;
    });
  }, [panelStorageKey]);

  /**
   * Раскрывает панель при переключении вкладки.
   *
   * Вкладки видны и в свёрнутом виде, поэтому клик по ним обязан что-то
   * показывать: иначе переключение выглядит как сломанная кнопка.
   */
  const expandPanel = useCallback(() => {
    setIsPanelAnimated(true);
    setIsPanelCollapsed(false);
    localStorage.setItem(panelStorageKey, "expanded");
  }, [panelStorageKey]);

  /**
   * Эффект: чтение свёрнутых карточек и уборка ID исчезнувших списков.
   *
   * Отдельно от эффекта выше, потому что зависит ещё и от `allLists`: удалённый
   * список пропадает из выборки, а его ID остался бы в localStorage навсегда.
   * Перезапуск на каждом обновлении данных безвреден — чтение идемпотентно, а
   * запись выполняется, только если что-то действительно отсеялось.
   */
  useEffect(() => {
    const stored = parseCollapsedIds(
      localStorage.getItem(collapsedStorageKey),
    );
    const pruned = pruneCollapsedIds(
      stored,
      allLists.map((list) => list.id),
    );
    if (pruned !== stored) {
      localStorage.setItem(collapsedStorageKey, serializeCollapsedIds(pruned));
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsedListIds(pruned);
  }, [collapsedStorageKey, allLists]);

  /**
   * Сворачивает или разворачивает карточку.
   *
   * Запись в localStorage внутри updater — тот же приём, что в
   * `SettingsProvider`: колбэк остаётся стабильным, и переключение одной
   * карточки не ломает мемоизацию всех остальных.
   */
  const handleToggleCollapse = useCallback(
    (listId: string) => {
      setCollapsedListIds((prev) => {
        const next = toggleCollapsedId(prev, listId);
        localStorage.setItem(
          collapsedStorageKey,
          serializeCollapsedIds(next),
        );
        return next;
      });
    },
    [collapsedStorageKey],
  );

  /**
   * Эффект: чтение свёрнутых блоков подпунктов и уборка исчезнувших записей.
   *
   * Записей сильно больше, чем списков, поэтому без уборки набор рос бы быстрее
   * всего именно здесь. Сравнение идёт со всеми записями пространства: свернуть
   * можно только пункт с подпунктами, но лишняя проверка ничего не стоит и не
   * зависит от того, есть ли у записи подпункты прямо сейчас.
   */
  useEffect(() => {
    const stored = parseCollapsedIds(
      localStorage.getItem(collapsedItemsStorageKey),
    );
    const pruned = pruneCollapsedIds(
      stored,
      allLists.flatMap((list) => list.items.map((item) => item.id)),
    );
    if (pruned !== stored) {
      localStorage.setItem(
        collapsedItemsStorageKey,
        serializeCollapsedIds(pruned),
      );
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsedItemIds(pruned);
  }, [collapsedItemsStorageKey, allLists]);

  /** Сворачивает или разворачивает блок подпунктов, сохраняя выбор. */
  const handleToggleItemCollapse = useCallback(
    (itemId: string) => {
      setCollapsedItemIds((prev) => {
        const next = toggleCollapsedId(prev, itemId);
        localStorage.setItem(
          collapsedItemsStorageKey,
          serializeCollapsedIds(next),
        );
        return next;
      });
    },
    [collapsedItemsStorageKey],
  );

  /**
   * Значение контекста стабильно между рендерами, пока набор не менялся:
   * иначе каждый рендер контейнера перерисовывал бы все `SmartList`.
   */
  const collapsedItems = useMemo(
    () => ({ collapsedIds: collapsedItemIds, toggle: handleToggleItemCollapse }),
    [collapsedItemIds, handleToggleItemCollapse],
  );

  /**
   * Эффект: подписка на личный private-канал Pusher текущего пользователя.
   *
   * Используется private-user-* канал (не публичный), что требует прохождения
   * auth endpoint (/api/pusher/auth) — сервер проверяет, что пользователь
   * подписывается только на свой канал. Это предотвращает слежку за чужой активностью.
   *
   * При получении события `refresh` вызывает `router.refresh()` —
   * Next.js перезапрашивает Server Component с актуальными данными из БД.
   * Это обеспечивает real-time обновление у всех участников списка.
   */
  useEffect(() => {
    // Гость не подключается к Pusher: realtime-обновлений у localStorage нет,
    // а auth endpoint private-каналов всё равно отклонил бы подписку
    if (api.isGuest) return;

    const client = getPusherClient();
    const channel = client.subscribe(`private-user-${currentUserId}`);

    channel.bind("refresh", () => {
      // Во время перетаскивания записи обновление откладывается до отпускания:
      // перерисовка дерева посреди жеста сорвала бы его (см. drag-gate.ts).
      if (deferRefreshWhileDragging(() => router.refresh())) return;
      router.refresh();
    });

    return () => {
      channel.unbind_all();
      client.unsubscribe(`private-user-${currentUserId}`);
    };
  }, [api.isGuest, currentUserId, router]);

  /**
   * Карта стабильных ключей для рендера карточек списков.
   * Сопоставляет listId → renderKey, чтобы при замене temp-списка реальным
   * React видел тот же ключ и не запускал exit/enter анимацию.
   * Хранится в состоянии (обновляется иммутабельно), а не в ref:
   * читать ref во время рендера запрещено (react-hooks/refs).
   */
  const [stableKeys, setStableKeys] = useState(() => new Map<string, string>());

  /**
   * Оптимистичный список всех списков покупок.
   *
   * Reducer обрабатывает обычные CRUD-действия и две операции порядка:
   *   - `add`     — добавляет список в начало массива (с защитой от дублей).
   *   - `delete`  — удаляет список по id.
   *   - `restore` — возвращает список на исходную позицию при откате удаления.
   *   - `replace` — заменяет временный список (temp-*) реальным из ответа сервера.
   *   - `rename`  — обновляет название списка (оптимистично или откат);
   *   - `groupOrder` — задаёт временные позиции карточек активной группы;
   *   - `addToGroup` — оптимистично добавляет membership в конец группы.
   */
  const [optimisticLists, setOptimisticLists] = useOptimistic(
    allLists,
    (
      state,
      {
        action,
        listId,
        list,
        groupId,
        group,
        orderedListIds,
      }: {
        action:
          | "add"
          | "delete"
          | "restore"
          | "replace"
          | "rename"
          | "groupOrder"
          | "addToGroup";
        listId?: string;
        list?: ListData;
        groupId?: string;
        group?: ListGroup;
        orderedListIds?: string[];
      },
    ) => {
      switch (action) {
        case "add":
          if (!list || state.some((item) => item.id === list.id)) {
            return state;
          }
          return [list, ...state];

        case "delete":
          if (!listId) {
            return state;
          }
          return state.filter((item) => item.id !== listId);

        case "restore":
          if (!list || !listId || state.some((item) => item.id === list.id)) {
            return state;
          }
          // Ищем исходную позицию в немутированном `allLists`
          const originalIndex = allLists.findIndex(
            (item) => item.id === listId,
          );
          if (originalIndex < 0) {
            return [...state, list]; // Не нашли позицию — добавляем в конец
          }
          const nextState = [...state];
          nextState.splice(originalIndex, 0, list);
          return nextState;

        case "replace":
          if (!list || !listId) {
            return state;
          }
          return state.map((item) => (item.id === listId ? list : item));

        case "rename":
          if (!list || !listId) {
            return state;
          }
          return state.map((item) =>
            item.id === listId ? { ...item, title: list.title } : item,
          );

        case "groupOrder": {
          if (!groupId || !orderedListIds) return state;
          const positions = new Map(
            orderedListIds.map((id, index) => [id, index + 1]),
          );
          return state.map((item) => {
            const position = positions.get(item.id);
            if (position === undefined) return item;
            return {
              ...item,
              groups: item.groups.map((membership) =>
                membership.id === groupId
                  ? { ...membership, position }
                  : membership,
              ),
            };
          });
        }

        case "addToGroup": {
          if (!groupId || !group || !listId) return state;
          const maxPosition = state.reduce((maximum, item) => {
            const position = item.groups.find(
              (membership) => membership.id === groupId,
            )?.position;
            return position === undefined
              ? maximum
              : Math.max(maximum, position);
          }, 0);
          return state.map((item) =>
            item.id !== listId ||
            item.groups.some((membership) => membership.id === groupId)
              ? item
              : {
                  ...item,
                  groups: [
                    ...item.groups,
                    { ...group, position: maxPosition + 1 },
                  ],
                },
          );
        }

        default:
          return state;
      }
    },
  );

  /**
   * Списки без дублей по id.
   *
   * Дубль возможен в переходном рендере при создании списка: базовый массив
   * `allLists` уже обновился (в гостевом режиме `refresh()` синхронный,
   * на сервере — RSC-payload из revalidatePath), а оптимистичный temp-список
   * ещё не отыгран и после действия `replace` совпадает с реальным по id.
   * Оба маппятся на один стабильный ключ рендера — React ругается на
   * дублирующиеся ключи. Оставляем первое вхождение каждого id.
   */
  const uniqueLists = useMemo(() => {
    const seen = new Set<string>();
    return optimisticLists.filter((list) => {
      if (seen.has(list.id)) return false;
      seen.add(list.id);
      return true;
    });
  }, [optimisticLists]);

  /**
   * Справочник списков для переноса записей между списками.
   *
   * Строится по `uniqueLists`, а НЕ по `filteredLists`: активный фильтр группы
   * или поиск сужают то, что видно на экране, но не то, куда можно перенести
   * запись. Иначе цель переноса пропадала бы из выбора вместе с фильтром.
   */
  const directory = useMemo(
    () => ({
      lists: uniqueLists.map((list) => ({
        id: list.id,
        title: list.title,
        groupIds: list.groups.map((group) => group.id),
        // Расшарен мной или получен от другого пользователя — в обоих случаях
        // список видит кто-то ещё.
        isShared: list.sharedWith.length > 0 || list.ownerId !== currentUserId,
      })),
      groups,
    }),
    [uniqueLists, groups, currentUserId],
  );

  /**
   * Отфильтрованные списки: сначала по группе, затем по поисковому запросу.
   *
   * Важно: при совпадении по записям список отдаётся с ПОЛНЫМ набором записей,
   * а совпавшие ID возвращаются отдельной картой `matchedItemIds`. Раньше здесь
   * подменялся сам массив `items`, но тогда `SmartList` не может посчитать
   * настоящий номер записи: под поиском пункт №7 показался бы как №1.
   * Скрытием несовпавших записей занимается `SmartList`, а нумерует он их
   * по полному списку.
   */
  const { lists: filteredLists, matchedItemIds } = useMemo(() => {
    // Шаг 1: фильтр по активной группе
    const groupFiltered = activeGroupId
      ? listsInGroupOrder(uniqueLists, activeGroupId)
      : uniqueLists;

    // Шаг 2: фильтр по поисковому запросу
    const q = searchQuery.trim().toLowerCase();
    if (!q) return { lists: groupFiltered, matchedItemIds: null };

    // Список отсутствует в карте => показываем все его записи (совпало
    // название или общая заметка). Есть в карте => показываем только совпавшие.
    const matches = new Map<string, Set<string>>();

    const lists = groupFiltered.reduce<typeof groupFiltered>((acc, list) => {
      const titleMatches = list.title.toLocaleLowerCase().includes(q);
      const listNoteMatches = list.note?.toLocaleLowerCase().includes(q) ?? false;

      if (titleMatches || listNoteMatches) {
        // Название или общая заметка совпали — показываем список со всеми записями
        acc.push(list);
      } else {
        // Ищем совпадения в названии и заметке каждой записи
        const matchedItems = list.items.filter(
          (item) =>
            item.name.toLocaleLowerCase().includes(q) ||
            (item.statusText?.toLocaleLowerCase().includes(q) ?? false) ||
            (item.note?.toLocaleLowerCase().includes(q) ?? false),
        );
        if (matchedItems.length > 0) {
          matches.set(list.id, new Set(matchedItems.map((item) => item.id)));
          acc.push(list);
        }
      }
      return acc;
    }, []);

    return { lists, matchedItemIds: matches };
  }, [uniqueLists, searchQuery, activeGroupId]);

  /**
   * Средний экран: между `md` и `xl`.
   *
   * До гидрации всегда `false`, поэтому серверная разметка совпадает с
   * клиентской: три куска, которые CSS показывает одной колонкой ниже `xl` и
   * тремя от `xl`. На телефоне и десктопе этот флаг ничего не меняет — он
   * включается только в середине, где иначе была бы одна колонка вместо двух.
   */
  const isMediumScreen = useMediaQuery(MEDIUM_SCREEN_QUERY);

  /**
   * Карточки, разложенные по колонкам.
   *
   * Три колонки — раскладка по умолчанию, и её достаточно для обоих крайних
   * случаев: ниже `xl` обёртки колонок получают `display: contents`, выпадают
   * из раскладки, и карточки выстраиваются в один поток в порядке DOM. Две
   * колонки — единственный случай, который CSS сам собрать не может: из трёх
   * кусков две колонки не склеить.
   */
  const listColumns = useMemo(
    () => splitIntoColumns(filteredLists, isMediumScreen ? 2 : 3),
    [filteredLists, isMediumScreen],
  );

  // -------------------------------------------------------------------------
  // Обработчики для групп
  // -------------------------------------------------------------------------

  const handleSelectGroup = useCallback((groupId: string | null) => {
    setActiveGroupId(groupId);
    if (groupId) {
      localStorage.setItem(groupStorageKey, groupId);
    } else {
      localStorage.removeItem(groupStorageKey);
    }
  }, [groupStorageKey]);

  const handleCreateGroup = useCallback(async (name: string) => {
    const result = await api.createGroup(name);
    if (result.success && result.group) {
      setGroups((prev) => [...prev, result.group!]);
    } else {
      toast.error(
        result.error === "tooLong"
          ? t("errors.tooLong")
          : result.error === "groupLimitReached"
            ? t("errors.groupLimitReached", { max: MAX_GROUPS_PER_SPACE })
            : result.error === "dailyLimitReached"
              ? t("errors.dailyLimitReached")
              : t("errors.groupCreateFailed"),
      );
    }
  }, [api, t]);

  /** Открывает модал подтверждения удаления группы. */
  const handleDeleteGroup = useCallback((groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (group) setGroupToDelete(group);
  }, [groups]);

  /** Подтверждение удаления группы из модала. */
  const handleConfirmDeleteGroup = useCallback(async () => {
    if (!groupToDelete) return;

    const group = groupToDelete;
    // Снимок текущего состояния для отката (включает группы, созданные в этой сессии)
    const groupsSnapshot = groups;
    setIsDeletingGroup(true);
    setGroupToDelete(null); // Закрываем модал немедленно

    // Если удаляем активную группу — сбрасываем фильтр
    if (activeGroupId === group.id) {
      handleSelectGroup(null);
    }
    setGroups((prev) => prev.filter((g) => g.id !== group.id));

    const result = await api.deleteGroup(group.id);
    if (!result.success) {
      // Откат: восстанавливаем полный снимок до удаления
      setGroups(groupsSnapshot);
      toast.error(t("errors.groupDeleteFailed"));
    }

    setIsDeletingGroup(false);
  }, [groupToDelete, activeGroupId, handleSelectGroup, groups, api, t]);

  const handleRenameGroup = useCallback(async (groupId: string, newName: string) => {
    // Захватываем текущее состояние группы до оптимистичного обновления
    const originalGroup = groups.find((g) => g.id === groupId);
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, name: newName } : g)),
    );

    const result = await api.renameGroup(groupId, newName);
    if (!result.success) {
      // Откат: восстанавливаем старое имя из снимка текущего состояния
      if (originalGroup) {
        setGroups((prev) =>
          prev.map((g) => (g.id === groupId ? originalGroup : g)),
        );
      }
      toast.error(
        result.error === "tooLong"
          ? t("errors.tooLong")
          : t("errors.groupRenameFailed"),
      );
    }
  }, [groups, api, t]);

  const handleMoveGroup = useCallback(
    async (groupId: string, orderedGroups: ListGroup[]) => {
      if (isReorderingGroup) return;

      const groupsSnapshot = groups;
      const newIndex = orderedGroups.findIndex((group) => group.id === groupId);
      if (newIndex === -1) return;

      setIsReorderingGroup(true);
      setGroups(orderedGroups);

      const result = await api.moveGroup(
        groupId,
        orderedGroups[newIndex - 1]?.id ?? null,
        orderedGroups[newIndex + 1]?.id ?? null,
      );
      if (!result.success) {
        setGroups(groupsSnapshot);
        toast.error(t("errors.groupMoveFailed"));
      }
      setIsReorderingGroup(false);
    },
    [api, groups, isReorderingGroup, t],
  );

  const handleToggleListGroup = useCallback(
    async (listId: string, groupId: string, inGroup: boolean) => {
      const result = inGroup
        ? await api.removeListFromGroup(listId, groupId)
        : await api.addListToGroup(listId, groupId);
      if (!result.success) {
        toast.error(t("errors.groupAssignFailed"));
        return false;
      }
      // RSC-payload из Server Action (или синхронный refresh гостевого
      // хранилища) уже применён к моменту завершения Promise. Меню карточки
      // закрывается только после этого, чтобы новый payload не отменил выбор.
      return true;
    },
    [api, t],
  );

  /**
   * Сохраняет уже собранный плоский порядок активной группы.
   * На клиенте временно выдаём позициям 1..n; сервер обычно пишет только одну
   * дробную позицию между переданными соседями.
   */
  const persistListOrder = useCallback(
    (listId: string, orderedLists: ListData[]) => {
      if (!activeGroupId || isReorderingList) return;
      const newIndex = orderedLists.findIndex((list) => list.id === listId);
      if (newIndex === -1) return;

      setIsReorderingList(true);
      startTransition(async () => {
        setOptimisticLists({
          action: "groupOrder",
          groupId: activeGroupId,
          orderedListIds: orderedLists.map((list) => list.id),
        });

        const result = await api.moveListInGroup(
          activeGroupId,
          listId,
          orderedLists[newIndex - 1]?.id ?? null,
          orderedLists[newIndex + 1]?.id ?? null,
        );
        if (!result.success) {
          toast.error(t("errors.listMoveFailed"));
          if (result.error === "stale") router.refresh();
        }
        setIsReorderingList(false);
      });
    },
    [
      activeGroupId,
      api,
      isReorderingList,
      router,
      setOptimisticLists,
      t,
    ],
  );

  /** Кнопки «раньше/позже» — клавиатурная альтернатива жесту карточки. */
  const handleMoveListStep = useCallback(
    (listId: string, direction: "earlier" | "later") => {
      if (!activeGroupId || searchQuery.trim()) return;
      const currentIndex = filteredLists.findIndex((list) => list.id === listId);
      const targetIndex =
        direction === "earlier" ? currentIndex - 1 : currentIndex + 1;
      if (
        currentIndex === -1 ||
        targetIndex < 0 ||
        targetIndex >= filteredLists.length
      ) {
        return;
      }
      persistListOrder(
        listId,
        arrayMove(filteredLists, currentIndex, targetIndex),
      );
    },
    [activeGroupId, filteredLists, persistListOrder, searchQuery],
  );

  /** Drop карточки на вкладку добавляет membership и сохраняет исходные. */
  const addListToGroupByDrop = useCallback(
    (listId: string, groupId: string) => {
      if (isReorderingList) return;
      const group = groups.find((entry) => entry.id === groupId);
      const list = uniqueLists.find((entry) => entry.id === listId);
      if (
        !group ||
        !list ||
        list.groups.some((membership) => membership.id === groupId)
      ) {
        return;
      }

      setIsReorderingList(true);
      startTransition(async () => {
        setOptimisticLists({
          action: "addToGroup",
          listId,
          groupId,
          group,
        });
        const result = await api.addListToGroup(listId, groupId);
        if (!result.success) {
          toast.error(t("errors.groupAssignFailed"));
        } else {
          toast.success(t("addedToGroup", { name: group.name }));
        }
        setIsReorderingList(false);
      });
    },
    [
      api,
      groups,
      isReorderingList,
      setOptimisticLists,
      t,
      uniqueLists,
    ],
  );

  const dndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  /**
   * В одном DndContext живут два независимых порядка.
   * Для карточки вкладки имеют приоритет только когда указатель действительно
   * находится внутри валидной цели; в остальных случаях ищется ближайшая
   * карточка. Для группы карточки полностью исключаются из collision detection.
   */
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const activeType = args.active.data.current?.type;
      if (activeType === "group") {
        return closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter(
            (container) => container.data.current?.type === "group",
          ),
        });
      }
      if (activeType !== "list") return [];

      const activeListId = args.active.data.current?.listId;
      const activeList = uniqueLists.find((list) => list.id === activeListId);
      const groupTargets = args.droppableContainers.filter((container) => {
        if (container.data.current?.type !== "group") return false;
        const groupId = container.data.current.groupId;
        return (
          typeof groupId === "string" &&
          groupId !== activeGroupId &&
          !activeList?.groups.some((membership) => membership.id === groupId)
        );
      });
      const groupCollisions = pointerWithin({
        ...args,
        droppableContainers: groupTargets,
      });
      if (groupCollisions.length > 0) return groupCollisions;

      if (!activeGroupId || searchQuery.trim()) return [];
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (container) => container.data.current?.type === "list",
        ),
      });
    },
    [activeGroupId, searchQuery, uniqueLists],
  );

  const handleDndStart = useCallback((event: DragStartEvent) => {
    const type = event.active.data.current?.type;
    const id =
      type === "group"
        ? event.active.data.current?.groupId
        : event.active.data.current?.listId;
    if ((type !== "group" && type !== "list") || typeof id !== "string") return;
    beginDrag();
    setActiveDrag({ type, id });
  }, []);

  const handleDndOver = useCallback((event: DragOverEvent) => {
    const targetGroupId =
      event.active.data.current?.type === "list" &&
      event.over?.data.current?.type === "group"
        ? event.over.data.current.groupId
        : null;
    setListDropTargetGroupId(
      typeof targetGroupId === "string" ? targetGroupId : null,
    );
  }, []);

  const finishDnd = useCallback(() => {
    endDrag();
    setActiveDrag(null);
    setListDropTargetGroupId(null);
  }, []);

  const handleDndCancel = useCallback(() => {
    finishDnd();
  }, [finishDnd]);

  const handleDndEnd = useCallback(
    (event: DragEndEvent) => {
      const activeType = event.active.data.current?.type;
      const overType = event.over?.data.current?.type;
      const activeListId = event.active.data.current?.listId;
      const activeGroupIdFromEvent = event.active.data.current?.groupId;
      const overListId = event.over?.data.current?.listId;
      const overGroupId = event.over?.data.current?.groupId;
      finishDnd();

      if (
        activeType === "group" &&
        overType === "group" &&
        typeof activeGroupIdFromEvent === "string" &&
        typeof overGroupId === "string" &&
        activeGroupIdFromEvent !== overGroupId
      ) {
        const oldIndex = groups.findIndex(
          (group) => group.id === activeGroupIdFromEvent,
        );
        const newIndex = groups.findIndex((group) => group.id === overGroupId);
        if (oldIndex !== -1 && newIndex !== -1) {
          void handleMoveGroup(
            activeGroupIdFromEvent,
            arrayMove(groups, oldIndex, newIndex),
          );
        }
        return;
      }

      if (activeType !== "list" || typeof activeListId !== "string") return;
      if (overType === "group" && typeof overGroupId === "string") {
        addListToGroupByDrop(activeListId, overGroupId);
        return;
      }
      if (
        overType !== "list" ||
        typeof overListId !== "string" ||
        !activeGroupId ||
        searchQuery.trim() ||
        activeListId === overListId
      ) {
        return;
      }

      const oldIndex = filteredLists.findIndex(
        (list) => list.id === activeListId,
      );
      const newIndex = filteredLists.findIndex((list) => list.id === overListId);
      if (oldIndex !== -1 && newIndex !== -1) {
        persistListOrder(
          activeListId,
          arrayMove(filteredLists, oldIndex, newIndex),
        );
      }
    },
    [
      activeGroupId,
      addListToGroupByDrop,
      filteredLists,
      finishDnd,
      groups,
      handleMoveGroup,
      persistListOrder,
      searchQuery,
    ],
  );

  /**
   * Обработчик создания нового списка.
   *
   * Передаётся в `CreateListForm` как колбэк.
   * Выполняет полный цикл оптимистичного обновления:
   *   1. Генерирует временный ID и создаёт placeholder-список.
   *   2. Немедленно добавляет его в UI через `setOptimisticLists`.
   *   3. Вызывает Server Action `createList`.
   *   4. При успехе — заменяет placeholder реальным объектом из БД.
   *   5. При ошибке — удаляет placeholder и показывает alert.
   *
   * @param title - Название нового списка (уже нормализованное).
   * @returns `{ success: boolean }` для `CreateListForm`.
   */
  const handleCreateList = useCallback(
    async (title: string) => {
      const tempListId = `temp-${randomUUID()}`;

      // Если активна группа — оптимистично включаем список в неё сразу
      const activeGroup = activeGroupId
        ? (groups.find((g) => g.id === activeGroupId) ?? null)
        : null;
      const firstPosition = activeGroupId
        ? Math.min(
            ...uniqueLists
              .map(
                (list) =>
                  list.groups.find((group) => group.id === activeGroupId)
                    ?.position,
              )
              .filter((position): position is number => position !== undefined),
            1,
          )
        : 1;

      // Оптимистичный объект с временным ID и данными текущего пользователя
      const optimisticList: ListData = {
        id: tempListId,
        title,
        note: null,
        noteVersion: 0,
        // Совпадает с умолчанием в БД: иначе на миг после создания список
        // выглядел бы как список с выключенным AI.
        aiEnabled: true,
        ownerId: currentUserId,
        owner: {
          name: currentUserName,
          email: currentUserEmail,
        },
        items: [],
        sharedWith: [],
        groups: activeGroup
          ? [{ ...activeGroup, position: firstPosition - 1 }]
          : [],
        files: [],
      };

      // Регистрируем стабильный ключ для рендера: tempId → tempId
      setStableKeys((prev) => new Map(prev).set(tempListId, tempListId));

      startTransition(() => {
        setOptimisticLists({ action: "add", list: optimisticList });
      });

      // Передаём активную группу — список подключится к ней сразу
      const result = await api.createList({ title, groupId: activeGroupId });

      if (!result || !result.success) {
        startTransition(() => {
          setOptimisticLists({ action: "delete", listId: tempListId });
        });
        toast.error(
          result?.error === "tooLong"
            ? t("errors.tooLong")
            : result?.error === "listLimitReached"
              ? t("errors.listLimitReached", { max: MAX_LISTS_PER_SPACE })
              : result?.error === "dailyLimitReached"
                ? t("errors.dailyLimitReached")
                : t("errors.createFailed"),
        );
        return { success: false };
      }

      if (!result.list) {
        startTransition(() => {
          setOptimisticLists({ action: "delete", listId: tempListId });
        });
        toast.error(t("errors.createLoadFailed"));
        return { success: false };
      }

      // Переносим стабильный ключ: теперь realId тоже рендерится под tempId
      const realListId = result.list.id;
      setStableKeys((prev) => new Map(prev).set(realListId, tempListId));

      // Заменяем временный список реальным объектом из БД
      startTransition(() => {
        setOptimisticLists({
          action: "replace",
          listId: tempListId,
          list: result.list,
        });
      });

      return { success: true };
    },
    [currentUserEmail, currentUserId, currentUserName, setOptimisticLists, activeGroupId, groups, uniqueLists, api, t],
  );

  /**
   * Колбэк переименования для `ListCard`.
   * Вызывается уже с обрезанным новым названием.
   */
  const handleRename = useCallback(
    async (listId: string, newTitle: string, originalList: ListData) => {
      // Оптимистично обновляем название в UI
      startTransition(() => {
        setOptimisticLists({
          action: "rename",
          listId,
          list: { ...originalList, title: newTitle },
        });
      });

      const result = await api.renameList(listId, newTitle);

      if (result && !result.success) {
        // Откат: восстанавливаем исходное название
        startTransition(() => {
          setOptimisticLists({ action: "rename", listId, list: originalList });
        });
        toast.error(
          result.error === "tooLong"
            ? t("errors.tooLong")
            : t("errors.renameFailed"),
        );
      }
    },
    [setOptimisticLists, api, t],
  );

  /**
   * Обработчик подтверждения удаления списка.
   *
   * Вызывается из модального окна подтверждения или по нажатию Enter.
   * Выполняет оптимистичное удаление с откатом при ошибке.
   */
  const handleConfirmDelete = useCallback(async () => {
    if (!listToDelete) {
      return;
    }

    const list = listToDelete;
    setIsDeleting(true);
    setListToDelete(null); // Закрываем модал немедленно

    // Оптимистично убираем список из UI
    startTransition(() => {
      setOptimisticLists({ action: "delete", listId: list.id });
    });

    const result = await api.deleteList(list.id);

    if (result && !result.success) {
      // Откат: возвращаем список на исходную позицию
      startTransition(() => {
        setOptimisticLists({
          action: "restore",
          listId: list.id,
          list,
        });
      });
      toast.error(t("errors.deleteFailed"));
    }

    setIsDeleting(false);
  }, [listToDelete, setOptimisticLists, api, t]);

  /**
   * Обработчик подтверждения выхода из расшаренного списка.
   *
   * Оптимистично убирает список из UI, затем вызывает `leaveSharedList`.
   * При ошибке — восстанавливает список на исходной позиции.
   */
  const handleConfirmLeave = useCallback(async () => {
    if (!listToLeave) return;

    const list = listToLeave;
    setIsLeaving(true);
    setListToLeave(null); // Закрываем модал немедленно

    // Оптимистично убираем список из UI
    startTransition(() => {
      setOptimisticLists({ action: "delete", listId: list.id });
    });

    const result = await api.leaveSharedList(list.id);

    if (result && !result.success) {
      // Откат: возвращаем список на исходную позицию
      startTransition(() => {
        setOptimisticLists({ action: "restore", listId: list.id, list });
      });
      toast.error(t("errors.leaveFailed"));
    }

    setIsLeaving(false);
  }, [listToLeave, setOptimisticLists, api, t]);

  /**
   * Эффект: клавиатурные события при открытом модале выхода из списка.
   *
   * - `Escape` — закрывает модал.
   * - `Enter`  — подтверждает выход.
   */
  useEffect(() => {
    if (!listToLeave) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setListToLeave(null);
        return;
      }
      if (event.key === "Enter" && !isLeaving) {
        event.preventDefault();
        void handleConfirmLeave();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleConfirmLeave, isLeaving, listToLeave]);

  /**
   * Эффект: подписка на клавиатурные события при открытом модале удаления.
   *
   * - `Escape` — закрывает модал без удаления.
   * - `Enter`  — подтверждает удаление (если не идёт другое удаление).
   *
   * Подписка активна только пока `listToDelete !== null`.
   * Отписка происходит автоматически при закрытии модала.
   */
  useEffect(() => {
    if (!listToDelete) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setListToDelete(null);
        return;
      }

      if (event.key === "Enter" && !isDeleting) {
        event.preventDefault();
        void handleConfirmDelete();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleConfirmDelete, isDeleting, listToDelete]);

  /**
   * Эффект: клавиатурные события при открытом модале удаления группы.
   *
   * - `Escape` — закрывает модал.
   * - `Enter`  — подтверждает удаление.
   */
  useEffect(() => {
    if (!groupToDelete) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setGroupToDelete(null);
        return;
      }
      if (event.key === "Enter" && !isDeletingGroup) {
        event.preventDefault();
        void handleConfirmDeleteGroup();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleConfirmDeleteGroup, isDeletingGroup, groupToDelete]);

  const draggedList =
    activeDrag?.type === "list"
      ? uniqueLists.find((list) => list.id === activeDrag.id) ?? null
      : null;

  /** Прогресс перетаскиваемого списка для overlay — по тем же правилам, что в шапке. */
  const draggedListProgress = buildItemTree(draggedList?.items ?? []);

  return (
    <ListsDirectoryProvider directory={directory}>
      <CollapsedItemsProvider value={collapsedItems}>
      <DndContext
        sensors={dndSensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDndStart}
        onDragOver={handleDndOver}
        onDragCancel={handleDndCancel}
        onDragEnd={handleDndEnd}
        accessibility={{
          screenReaderInstructions: {
            draggable: t("dragInstructions"),
          },
        }}
      >
      {/* Фильтр по группам */}
      <GroupFilter
        groups={groups}
        activeGroupId={activeGroupId}
        onSelectGroup={handleSelectGroup}
        onCreateGroup={handleCreateGroup}
        onDeleteGroup={handleDeleteGroup}
        onRenameGroup={handleRenameGroup}
        isReordering={isReorderingGroup || isReorderingList}
        listDropTargetGroupId={listDropTargetGroupId}
      />

      {/* Панель с вкладками Создать/Поиск */}
      <ListsTopPanel
        isSearchOpen={isSearchOpen}
        searchInput={searchInput}
        isSearching={isSearching}
        isPending={isPending}
        isCollapsed={isPanelCollapsed}
        animateCollapse={isPanelAnimated}
        searchInputRef={searchInputRef}
        onToggleCollapse={handleTogglePanel}
        onTabCreate={() => {
          setIsSearchOpen(false);
          setSearchInput("");
          expandPanel();
          localStorage.setItem(tabStorageKey, "create");
        }}
        onTabSearch={() => {
          setIsSearchOpen(true);
          expandPanel();
          localStorage.setItem(tabStorageKey, "search");
          // Поле монтируется вместе с раскрытием панели, поэтому фокус ставится
          // следующим кадром — к этому моменту оно уже в DOM.
          requestAnimationFrame(() => searchInputRef.current?.focus());
        }}
        onSearchChange={(value) => setSearchInput(value)}
        onSearchEscape={() => {
          setIsSearchOpen(false);
          setSearchInput("");
          localStorage.setItem(tabStorageKey, "create");
        }}
        createListContent={<CreateListForm onCreateList={handleCreateList} />}
      />

      {/* Плашка с результатами поиска */}
      {searchQuery && (
        <div className="flex items-center justify-between mb-4 px-1">
          <span className="text-sm text-gray-500" data-testid="search-results">
            {t("searchResults", { found: filteredLists.length, total: uniqueLists.length })}
          </span>
          <button
            type="button"
            data-testid="search-close"
            onClick={() => { setIsSearchOpen(false); setSearchInput(""); localStorage.setItem(tabStorageKey, "create"); }}
            className="text-xs text-gray-400 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 transition-colors"
          >
            {t("closeSearch")} ✕
          </button>
        </div>
      )}

      {/* Внешний AnimatePresence реагирует на смену группы:
          mode="wait" гарантирует, что старые карточки полностью исчезнут
          до появления новых — устраняет прыжки columns-layout. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={activeGroupId ?? "all"}
          data-testid="lists-group-view"
          data-group-id={activeGroupId ?? "all"}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
        >
          {/* Колонки — отдельные контейнеры, а не `columns` и не грид.
              Причины обеих замен в `PROJECT_MEMORY.md`; коротко: в multicol
              колонка карточки вычислялась из высот, и сворачивание
              перебрасывало соседей, а в гриде ряды выровнены, и рядом со
              свёрнутой карточкой оставалась дыра во всю высоту раскрытой.
              Здесь колонка задана номером карточки, а внутри колонки они
              лежат вплотную. */}
          {/* Ключ по числу колонок. При его смене карточки переезжают в другие
              контейнеры, и без ключа каждая на мгновение оказывалась бы в DOM
              дважды: старая копия доигрывает исчезновение в прежней колонке,
              пока новая появляется в соседней. Ключ размонтирует старое дерево
              целиком и мгновенно — `AnimatePresence` не может анимировать
              собственное исчезновение, поэтому призраков не остаётся. */}
          <SortableContext
            items={filteredLists.map((list) => listDndId(list.id))}
            strategy={rectSortingStrategy}
          >
            <div
              key={listColumns.length}
              className={`flex gap-6 ${
                isMediumScreen
                  ? "flex-row items-start"
                  : "flex-col xl:flex-row xl:items-start"
              }`}
            >
            {listColumns.map((column, columnIndex) => (
              /* `contents` ниже xl убирает саму обёртку из раскладки: карточки
                 становятся детьми внешнего flex-контейнера и выстраиваются в
                 одну колонку в порядке DOM. Благодаря этому обе крайние ширины
                 обходятся без JS, а серверная разметка сразу верна. На среднем
                 экране колонок две, и обёртка становится настоящей колонкой на
                 всех ширинах — этот случай уже включён после гидрации. */
              <div
                key={columnIndex}
                data-testid="lists-column"
                className={
                  isMediumScreen
                    ? "flex min-w-0 flex-1 flex-col gap-6"
                    : "contents xl:flex xl:min-w-0 xl:flex-1 xl:flex-col xl:gap-6"
                }
              >
                {/* AnimatePresence обрабатывает добавление и удаление списков
                    внутри колонки. */}
                <AnimatePresence initial={false} mode="popLayout">
                  {column.map((list) => {
                    const flatIndex = filteredLists.findIndex(
                      (entry) => entry.id === list.id,
                    );
                    const hasGroupTarget = groups.some(
                      (group) =>
                        !list.groups.some(
                          (membership) => membership.id === group.id,
                        ),
                    );
                    const canReorder =
                      activeGroupId !== null && filteredLists.length > 1;
                    const showDragHandle =
                      activeGroupId !== null &&
                      !list.id.startsWith("temp-") &&
                      !searchQuery.trim() &&
                      (canReorder || hasGroupTarget);
                    const isDragDisabled =
                      !showDragHandle ||
                      isReorderingGroup ||
                      isReorderingList;
                    const isListCollapsed = collapsedListIds.has(list.id);

                    return (
                    <SortableListCard
                      key={stableKeys.get(list.id) ?? list.id}
                      list={list}
                      showHandle={showDragHandle}
                      disabled={isDragDisabled}
                      isCollapsed={isListCollapsed}
                      dragLabel={t("ariaDragList", {
                        title: list.title,
                      })}
                    >
                      {(dragHandle) => (
                      <ListCard
                        list={list}
                        currentUserId={currentUserId}
                        currentUserName={currentUserName}
                        currentUserEmail={currentUserEmail}
                        showAuthors={showAuthors}
                        showItemNumbers={showItemNumbers}
                        showItemsCounter={showItemsCounter}
                        visibleItemIds={matchedItemIds?.get(list.id) ?? null}
                        isCollapsed={isListCollapsed}
                        onToggleCollapse={handleToggleCollapse}
                        isDeleting={isDeleting}
                        isLeaving={isLeaving}
                        onRename={handleRename}
                        onDelete={setListToDelete}
                        onLeave={setListToLeave}
                        searchQuery={searchQuery}
                        userGroups={groups}
                        onToggleListGroup={handleToggleListGroup}
                        dragHandle={dragHandle}
                        canMoveEarlier={canReorder && flatIndex > 0}
                        canMoveLater={
                          canReorder &&
                          flatIndex >= 0 &&
                          flatIndex < filteredLists.length - 1
                        }
                        onMoveInGroup={
                          canReorder ? handleMoveListStep : undefined
                        }
                      />
                      )}
                    </SortableListCard>
                    );
                  })}
                </AnimatePresence>
              </div>
            ))}
            </div>
          </SortableContext>

          {/* Сообщение о пустом состоянии */}
          {filteredLists.length === 0 && (
            <div
              data-testid="lists-empty"
              className="text-center py-10 border-2 border-dashed border-gray-200 dark:border-zinc-800 rounded-xl"
            >
              <p className="text-gray-500 dark:text-zinc-400">
                {searchQuery.trim()
                  ? t("noSearchResults")
                  : uniqueLists.length === 0
                    ? t("noLists")
                    : t("noListsInGroup")}
              </p>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Модал подтверждения выхода из расшаренного списка */}
      {listToLeave && (
        <ConfirmModal
          title={t("leaveModal.title")}
          body={t("leaveModal.body", { title: listToLeave.title })}
          confirmLabel={t("leaveModal.confirm")}
          cancelLabel={t("leaveModal.cancel")}
          isConfirming={isLeaving}
          onConfirm={() => void handleConfirmLeave()}
          onCancel={() => setListToLeave(null)}
        />
      )}

      {/* Модал подтверждения удаления списка */}
      {listToDelete && (
        <ConfirmModal
          title={t("deleteModal.title")}
          body={t("deleteModal.body", { title: listToDelete.title })}
          confirmLabel={t("deleteModal.confirm")}
          cancelLabel={t("deleteModal.cancel")}
          isConfirming={isDeleting}
          onConfirm={() => void handleConfirmDelete()}
          onCancel={() => setListToDelete(null)}
        />
      )}

      {/* Модал подтверждения удаления группы */}
      {groupToDelete && (
        <ConfirmModal
          title={t("deleteGroupModal.title")}
          body={t("deleteGroupModal.body", { name: groupToDelete.name })}
          confirmLabel={t("deleteGroupModal.confirm")}
          cancelLabel={t("deleteGroupModal.cancel")}
          isConfirming={isDeletingGroup}
          onConfirm={() => void handleConfirmDeleteGroup()}
          onCancel={() => setGroupToDelete(null)}
        />
      )}
      <DragOverlay dropAnimation={null}>
        {draggedList ? (
          <div className="flex w-[min(22rem,calc(100vw-2rem))] items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-2xl ring-1 ring-black/5 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/70">
            <GripVertical
              aria-hidden
              className="flex-shrink-0 text-gray-400 dark:text-zinc-500"
              size={17}
            />
            <span className="min-w-0 flex-1 truncate font-semibold">
              {draggedList.title}
            </span>
            {/* Тот же счётчик, что в шапке карточки: только верхний уровень. */}
            {draggedListProgress.totalCount > 0 && (
              <span className="flex-shrink-0 text-xs tabular-nums text-gray-400 dark:text-zinc-500">
                {draggedListProgress.completedCount} /{" "}
                {draggedListProgress.totalCount}
              </span>
            )}
          </div>
        ) : null}
      </DragOverlay>
      </DndContext>
      </CollapsedItemsProvider>
    </ListsDirectoryProvider>
  );
}
