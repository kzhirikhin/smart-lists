/**
 * @file ListCard.tsx
 * @description Мемоизированная карточка одного списка покупок.
 *
 * Изолирует состояние редактирования заголовка внутри себя,
 * чтобы ре-рендер при поиске или изменении другой карточки не затрагивал её.
 *
 * Поддерживаемые функции:
 *   - Переименование заголовка (Enter — сохранить, Escape/blur — отменить).
 *   - Удаление списка (только для владельца).
 *   - Выход из расшаренного списка (кнопка "Отписаться").
 *   - Подсветка совпадений по поисковому запросу через компонент `Highlight`.
 *
 * Экспортирует вспомогательные типы:
 *   `SharedUser`, `ListOwner`, `Item`, `ListData`, `ListCardProps`.
 */

"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useMediaQuery } from "@/lib/use-media-query";
import { useListsApi } from "@/components/providers/ListsApiProvider";
import SmartList from "@/components/lists/SmartList";
import CollapseChevron from "@/components/ui/CollapseChevron";
import Highlight from "@/components/ui/Highlight";
import Tooltip from "@/components/ui/Tooltip";
import ShareListForm, { ShareListButton } from "@/components/lists/ShareListForm";
import AiInsight, { AiInsightButton } from "@/components/lists/AiInsight";
import Attachments, { AttachmentsButton } from "@/components/lists/Attachments";
import {
  DeleteNoteModal,
  ListNote,
  ListNoteButton,
  NoteIcon,
  NoteRemoveIcon,
  TrashIcon,
} from "@/components/lists/Notes";
import type { ItemStatus } from "@/lib/item-status";
import { buildItemTree } from "@/lib/item-tree";
import { DROP_TARGET_ATTR } from "@/lib/item-drop";
import { menuAnchorFor, sameMenuAnchor, type MenuAnchor } from "@/lib/menu-anchor";
import { ArrowDown, ArrowUp, Sparkles } from "lucide-react";
import toast from "react-hot-toast";
import { setListAiEnabled } from "@/app/actions";
import { appendSocketId } from "@/lib/pusher-client";
import { useCurrentSpaceId } from "@/components/spaces/SpaceContext";

/** Пользователь, которому предоставлен доступ к списку. */
export type SharedUser = {
  id: string;
  name: string | null;
  email: string | null;
};

/** Данные о владельце списка. */
export type ListOwner = {
  name: string | null;
  email: string;
};

/**
 * Запись внутри списка.
 *
 * Уровень задаётся полем `parentId`, а массив записей остаётся плоским: дерево
 * собирает `buildItemTree` при рендере. Плоское представление нужно
 * оптимистичному состоянию — обычные `map`/`filter` по одному массиву вместо
 * рекурсии по вложенным.
 */
export type Item = {
  id: string;
  name: string;
  note: string | null;
  noteVersion: number;
  isCompleted: boolean;
  status?: ItemStatus;
  /** ID родительского пункта. null — пункт верхнего уровня. */
  parentId: string | null;
  addedBy: { id: string; name: string | null; email: string } | null;
};

/** Группа списков (минимальные данные для отображения). */
export type ListGroup = {
  id: string;
  name: string;
};

/** Размещение списка в группе вместе с его персональной позицией. */
export type ListGroupMembership = ListGroup & {
  position: number;
};

/** Вложение к списку (только подтверждённые, status UPLOADED). */
export type Attachment = {
  id: string;
  name: string;
  /** Категория для иконки в UI. */
  type: "IMAGE" | "DOCUMENT";
  contentType: string;
  size: number;
  /** Кто загрузил. null — аккаунт удалён (onDelete: SetNull), нужен fallback. */
  uploadedBy: { id: string; name: string | null; email: string } | null;
};

/** Полные данные списка (включая связанные сущности). */
export type ListData = {
  id: string;
  title: string;
  note: string | null;
  noteVersion: number;
  /** Разрешена ли отправка содержимого списка в AI-сервис. */
  aiEnabled: boolean;
  ownerId: string;
  owner: ListOwner;
  items: Item[];
  sharedWith: SharedUser[];
  /** Персональные размещения списка в группах текущего пользователя. */
  groups: ListGroupMembership[];
  /** Вложения списка (подтверждённые). */
  files: Attachment[];
};

/** Пропсы компонента `ListCard`. */
export type ListCardProps = {
  list: ListData;
  currentUserId: string;
  currentUserName: string | null;
  currentUserEmail: string;
  showAuthors: boolean;
  /** Показывать ли порядковые номера записей (тумблер в настройках). */
  showItemNumbers: boolean;
  /** Показывать ли счётчик «выполнено / всего» в шапке (тумблер в настройках). */
  showItemsCounter: boolean;
  /**
   * ID записей, совпавших с поиском. null — показывать все записи списка.
   * Фильтрацией занимается `SmartList`, чтобы нумеровать записи по полному
   * списку, а не по совпавшему подмножеству.
   */
  visibleItemIds: Set<string> | null;
  /**
   * Свёрнута ли карточка. Персональная настройка отображения: хранится в
   * localStorage, в БД её нет и другим участникам списка она не видна.
   */
  isCollapsed: boolean;
  /** Колбэк сворачивания/разворачивания карточки. */
  onToggleCollapse: (listId: string) => void;
  isDeleting: boolean;
  isLeaving: boolean;
  onRename: (listId: string, newTitle: string, originalList: ListData) => Promise<void>;
  onDelete: (list: ListData) => void;
  onLeave: (list: ListData) => void;
  /** Активный поисковый запрос для подсветки совпадений (пустая строка = нет поиска). */
  searchQuery: string;
  /** Все группы пользователя (для меню назначения в группу). */
  userGroups: ListGroup[];
  /** Колбэк добавления/удаления списка из группы. */
  onToggleListGroup: (
    listId: string,
    groupId: string,
    inGroup: boolean,
  ) => Promise<boolean>;
  /** Ручка DnD, создаваемая sortable-обёрткой контейнера. */
  dragHandle?: ReactNode;
  /** Доступная альтернатива жесту в плоском порядке активной группы. */
  canMoveEarlier?: boolean;
  canMoveLater?: boolean;
  onMoveInGroup?: (listId: string, direction: "earlier" | "later") => void;
};

/**
 * Мемоизированная карточка одного списка.
 *
 * Изолирует состояние редактирования (isEditing, editTitle) внутри себя,
 * чтобы ре-рендер при поиске или изменении другой карточки не затрагивал её.
 *
 * @param list - Данные списка.
 * @param currentUserId - ID авторизованного пользователя.
 * @param currentUserName - Имя авторизованного пользователя.
 * @param currentUserEmail - Email авторизованного пользователя.
 * @param showAuthors - Показывать ли авторов записей.
 * @param isDeleting - Идёт ли процесс удаления (блокирует кнопку ✕).
 * @param isLeaving - Идёт ли процесс выхода из списка (блокирует кнопку Отписаться).
 * @param onRename - Колбэк переименования списка.
 * @param onDelete - Колбэк открытия модала удаления.
 * @param onLeave - Колбэк открытия модала выхода из списка.
 * @param searchQuery - Текущий поисковый запрос для подсветки совпадений.
 */

/**
 * Пункт меню «включить/выключить AI для списка».
 *
 * Отдельный компонент нужен из-за `useCurrentSpaceId`: он бросает исключение
 * вне `SpaceProvider`, а гостевой режим рендерит карточку без него. Условие
 * внутри одного компонента здесь не помогло бы — хуки вызываются безусловно.
 *
 * Состояние держит родитель: от него же зависит видимость кнопки инсайта.
 */
function ListAiToggleMenuItem({
  listId,
  aiEnabled,
  onOptimistic,
  onRevert,
}: {
  listId: string;
  aiEnabled: boolean;
  onOptimistic: (next: boolean) => void;
  onRevert: (previous: boolean) => void;
}) {
  const t = useTranslations("ListsContainer");
  const spaceId = useCurrentSpaceId();

  const handleToggle = async () => {
    const next = !aiEnabled;
    onOptimistic(next);

    const formData = new FormData();
    formData.append("listId", listId);
    formData.append("aiEnabled", String(next));
    formData.append("spaceId", spaceId);
    appendSocketId(formData);

    const result = await setListAiEnabled(formData);
    if (!result?.success) {
      onRevert(!next);
      toast.error(
        result?.error === "dailyLimitReached"
          ? t("errors.dailyLimitReached")
          : t("errors.aiToggleFailed"),
      );
    }
  };

  return (
    <button
      type="button"
      role="menuitem"
      data-testid="list-ai-toggle"
      data-ai-enabled={aiEnabled}
      onClick={() => void handleToggle()}
      className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
    >
      <Sparkles size={17} />
      {aiEnabled ? t("aiDisableAction") : t("aiEnableAction")}
    </button>
  );
}

const ListCard = memo(function ListCard({
  list,
  currentUserId,
  currentUserName,
  currentUserEmail,
  showAuthors,
  showItemNumbers,
  showItemsCounter,
  visibleItemIds,
  isCollapsed,
  onToggleCollapse,
  isDeleting,
  isLeaving,
  onRename,
  onDelete,
  onLeave,
  searchQuery,
  userGroups,
  onToggleListGroup,
  dragHandle,
  canMoveEarlier = false,
  canMoveLater = false,
  onMoveInGroup,
}: ListCardProps) {
  const t = useTranslations("ListsContainer");
  const notesT = useTranslations("Notes");
  const commonT = useTranslations("Common");

  // Гостевой режим: шаринг, AI-инсайты и вложения требуют аккаунта/сервера —
  // соответствующий блок кнопок не рендерится вовсе
  const api = useListsApi();
  const { isGuest } = api;

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const processingRenameRef = useRef(false);
  const skipBlurRef = useRef(false);

  // Активная панель: 'ai' | 'share' | 'files' | null — только одна открыта одновременно
  const [activePanel, setActivePanel] = useState<"ai" | "share" | "files" | null>(null);
  const [isListNoteOpen, setIsListNoteOpen] = useState(false);
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
  // Подтверждение удаления заметки списка вызывается из меню действий.
  const [isNoteDeleteOpen, setIsNoteDeleteOpen] = useState(false);

  /**
   * Оптимистичное состояние флага AI.
   *
   * Инициализируется значением с сервера и перезаписывается им же после
   * `revalidatePath`; локальное значение живёт только до ответа Action.
   */
  const [aiEnabled, setAiEnabled] = useState(list.aiEnabled);
  useEffect(() => {
    setAiEnabled(list.aiEnabled);
  }, [list.aiEnabled]);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuButtonRef = useRef<HTMLButtonElement>(null);

  const actionsMenuPanelRef = useRef<HTMLDivElement>(null);

  /** Координаты открытого меню действий в координатах окна. */
  const [actionsMenuAnchor, setActionsMenuAnchor] = useState<MenuAnchor | null>(
    null,
  );

  const togglePanel = (panel: "ai" | "share" | "files") => {
    setIsListNoteOpen(false);
    setActivePanel((prev) => (prev === panel ? null : panel));
  };

  const toggleListNote = () => {
    setActivePanel(null);
    setIsActionsMenuOpen(false);
    setIsListNoteOpen((current) => !current);
  };

  /** Координаты меню от его кнопки. Механика — в `src/lib/menu-anchor.ts`. */
  const anchorFor = useCallback(
    (button: HTMLButtonElement) =>
      menuAnchorFor(button, actionsMenuPanelRef.current?.offsetHeight ?? 0),
    [],
  );

  /**
   * Пересчёт координат меню: сначала по факту отрисовки — тогда становится
   * известна его высота и решается вопрос переворота, — затем при прокрутке и
   * изменении размера окна, иначе закреплённое меню отрывается от своей кнопки.
   *
   * Слушатель прокрутки с capture: карточка может лежать в прокручиваемом
   * контейнере, а не только в окне.
   */
  useLayoutEffect(() => {
    if (!isActionsMenuOpen) return;

    const reposition = () => {
      const button = actionsMenuButtonRef.current;
      if (!button) return;
      const next = anchorFor(button);
      // Возврат прежнего объекта отменяет лишний ререндер: перерисовка карточки
      // стоит дорого, а координаты чаще всего не меняются.
      setActionsMenuAnchor((current) =>
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
  }, [isActionsMenuOpen, anchorFor]);

  // Закрываем меню действий по клику снаружи или по Escape.
  useEffect(() => {
    if (!isActionsMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!actionsMenuRef.current?.contains(event.target as Node)) {
        setIsActionsMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsActionsMenuOpen(false);
        actionsMenuButtonRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isActionsMenuOpen]);

  // Состояние дропдауна меню групп
  const [isGroupMenuOpen, setIsGroupMenuOpen] = useState(false);
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(null);
  const groupMenuRef = useRef<HTMLDivElement>(null);

  // Закрываем меню при клике вне его
  useEffect(() => {
    if (!isGroupMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(e.target as Node)) {
        setIsGroupMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isGroupMenuOpen]);

  const handleConfirmRename = useCallback(async () => {
    if (processingRenameRef.current) return;
    processingRenameRef.current = true;
    try {
      const trimmed = editTitle.trim();
      setIsEditing(false);
      if (!trimmed || trimmed === list.title) return;
      await onRename(list.id, trimmed, list);
    } finally {
      processingRenameRef.current = false;
    }
  }, [editTitle, list, onRename]);

  const isOwner = list.ownerId === currentUserId;
  const isTemp = list.id.startsWith("temp-");

  /**
   * Скрыто ли тело карточки.
   *
   * При активном поиске свёрнутость игнорируется, а сохранённое состояние не
   * меняется: карточка вообще отрисована только если совпадение в ней есть
   * (`ListsContainer` отдаёт лишь подошедшие списки), и оставить её закрытой
   * значило бы показать результат, на который нельзя посмотреть. Закончился
   * поиск — карточка снова свёрнута.
   */
  const isBodyHidden = isCollapsed && !isTemp && !searchQuery.trim();

  /**
   * Выполненные записи: сводка в шапке карточки.
   *
   * Считаются именно выполненные, а не оставшиеся: «N / M» в списке задач
   * читается как прогресс, и обратный счёт сбивал бы с толку — отметка записи
   * уменьшала бы первое число.
   *
   * Счёт идёт только по верхнему уровню, и частично выполненный пункт
   * считается невыполненным. Это не приблизительность: отметка такого пункта
   * производная от подпунктов, поэтому счётчик показывает ровно то же, что
   * видно в его чекбоксе.
   */
  const { completedCount: completedItemsCount, totalCount: itemsCount } =
    buildItemTree(list.items);
  const listProgressState = itemsCount === 0
    ? "empty"
    : completedItemsCount === itemsCount
      ? "complete"
      : "active";

  const bodyId = `list-body-${list.id}`;

  /**
   * Сворачивает или разворачивает карточку, закрывая заметку.
   *
   * Заметка живёт выше тела и сворачивание переживает, поэтому свёрнутая
   * карточка с открытой заметкой осталась бы высокой — и выглядело бы это как
   * сбой сворачивания. Свернул — компактно; понадобилась заметка — открыл
   * кнопкой уже в свёрнутом виде.
   */
  const handleToggleCollapse = useCallback(() => {
    if (!isBodyHidden) setIsListNoteOpen(false);
    onToggleCollapse(list.id);
  }, [isBodyHidden, onToggleCollapse, list.id]);

  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * Идёт ли анимация сворачивания.
   *
   * Ref, а не состояние, и стили ниже пишутся прямо в DOM. Через состояние это
   * стоило непозволительно дорого: `setState` в момент старта анимации
   * перерисовывал всё тело карточки вместе со `SmartList`, и первый кадр
   * растягивался до 90 мс — клик, пауза, рывок. Ни одно из этих свойств не
   * влияет на разметку React, поэтому ререндер тут не нужен вовсе.
   */
  const isAnimatingBodyRef = useRef(false);

  /**
   * Стиль покоя: у свёрнутой карточки тело скрыто и обрезано, у раскрытой не
   * тронуто.
   *
   * `visibility` обязателен: нулевая высота с обрезкой прячет содержимое лишь
   * визуально, оставляя его в порядке обхода и в поиске по странице.
   * `overflow` в покое снимается — у раскрытой карточки он срезал бы меню
   * записи, выходящее за нижний край короткого списка.
   */
  const applyRestingBodyStyle = useCallback(() => {
    const node = bodyRef.current;
    if (!node) return;
    node.style.overflow = isBodyHidden ? "hidden" : "";
    node.style.visibility = isBodyHidden ? "hidden" : "";
  }, [isBodyHidden]);

  // Начальное состояние и переходы без анимации: свёрнутая карточка после
  // перезагрузки, раскрытие поиском. Пока анимация идёт, стилями управляют её
  // колбэки — эффект в это время не вмешивается.
  useEffect(() => {
    if (!isAnimatingBodyRef.current) applyRestingBodyStyle();
  }, [applyRestingBodyStyle]);

  const prefersReducedMotion = useReducedMotion();

  /**
   * Тач-устройство. Анимация высоты заставляет браузер пересчитывать раскладку
   * каждый кадр, и на телефоне этого бюджета не хватает — переход виден как
   * рывок. Мгновенное сворачивание там выглядит лучше плохой анимации, тем
   * более что на узком экране карточка занимает всю ширину и прыжок заметен
   * сам по себе.
   */
  const isCoarsePointer = useMediaQuery("(pointer: coarse)");

  /**
   * Переход сворачивания.
   *
   * Короткий и без пружины: меняется высота, а значит браузер пересчитывает
   * раскладку на каждом кадре. Чем дольше переход, тем дольше эта работа.
   */
  const collapseTransition =
    prefersReducedMotion || isCoarsePointer
      ? { duration: 0 }
      : { duration: 0.18, ease: [0.4, 0, 0.2, 1] as const };

  return (
    <div
      data-testid="list-card"
      data-list-id={list.id}
      data-list-role={isOwner ? "owner" : "editor"}
      data-collapsed={isBodyHidden}
      data-progress-state={listProgressState}
      /* Карточка объявляет себя целью для записи, которую тащат из другого
         списка. Атрибут отдельный от `data-list-id`: тот адресует карточку
         вообще, а этот — только для геометрии броска, и по нему же идёт
         поиск целей (`src/lib/item-drop.ts`). Подсветку ставит и снимает тот
         же модуль прямой записью в DOM — карточка мемоизирована, и
         перерисовывать её на каждое пересечение границы незачем. */
      {...{ [DROP_TARGET_ATTR]: list.id }}
      className={`border p-6 rounded-xl shadow-sm dark:shadow-lg dark:shadow-black/50 transition-colors data-[item-drop-active=true]:ring-2 data-[item-drop-active=true]:ring-gray-800 dark:data-[item-drop-active=true]:ring-zinc-200 ${
        listProgressState === "empty"
          ? "border-gray-200 bg-gray-50 dark:border-transparent dark:bg-zinc-900/60"
          : listProgressState === "complete"
            ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20"
            : "border-gray-100 bg-white dark:border-transparent dark:bg-zinc-900"
      }`}
    >
      {/* Заголовок и кнопки управления. Разделительная черта и отступ под ней
          нужны, только если ниже что-то есть: у свёрнутой карточки без открытой
          заметки шапка — это вся карточка, и черта висела бы над пустотой. */}
      <div
        className={`flex items-center justify-between gap-3 ${
          isBodyHidden && !isListNoteOpen
            ? ""
            : "mb-4 border-b dark:border-zinc-700 pb-2"
        }`}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {dragHandle}

          {/* Шеврон — основной способ свернуть карточку. Клик по заголовку
              занят переименованием, поэтому нужна отдельная кнопка. */}
          {!isTemp && !isEditing && (
            <Tooltip
              label={isBodyHidden ? t("expandAction") : t("collapseAction")}
            >
              <button
                type="button"
                data-testid="list-collapse-toggle"
                onClick={handleToggleCollapse}
                aria-expanded={!isBodyHidden}
                aria-controls={bodyId}
                /* Зона нажатия расширена невидимым `::after`, а не размером самой
                   кнопки: 24px пальцем не поймать, но растить видимую кнопку
                   незачем — рядом иконки того же масштаба. Прямоугольник растёт
                   во все стороны, однако вправо его перекрывает заголовок, идущий
                   дальше в потоке: тап по названию должен по-прежнему открывать
                   переименование, а не сворачивать список. */
                className="relative inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors after:absolute after:-inset-2.5 after:content-[''] hover:bg-gray-100 hover:text-gray-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
              >
                <CollapseChevron isCollapsed={isBodyHidden} />
              </button>
            </Tooltip>
          )}

          {isEditing ? (
            <input
              autoFocus
              data-testid="list-title-input"
              className="text-xl font-bold w-full border dark:border-zinc-700 p-1 rounded-lg bg-gray-50 dark:bg-zinc-800 focus:bg-white dark:focus:bg-zinc-900 focus:ring-1 ring-gray-800 dark:ring-zinc-400 outline-none transition"
              value={editTitle}
              maxLength={50}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleConfirmRename();
                }
                if (e.key === "Escape") {
                  skipBlurRef.current = true;
                  setIsEditing(false);
                }
              }}
              onBlur={() => {
                if (skipBlurRef.current) {
                  skipBlurRef.current = false;
                  return;
                }
                void handleConfirmRename();
              }}
            />
          ) : isOwner && !isTemp ? (
            <div
              className="group inline-flex items-center gap-1 min-w-0 rounded-lg px-1 -mx-1 hover:bg-gray-100 dark:hover:bg-zinc-800 hover:ring-1 hover:ring-gray-300 dark:hover:ring-zinc-700 transition-colors cursor-pointer"
              onClick={() => {
                setIsEditing(true);
                setEditTitle(list.title);
              }}
            >
              <h2 className={`text-xl font-bold truncate ${listProgressState === "empty" ? "text-gray-500 dark:text-zinc-400" : listProgressState === "complete" ? "text-emerald-800 dark:text-emerald-200" : ""}`} data-testid="list-title"><Highlight text={list.title} query={searchQuery} /></h2>
              <span className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 dark:text-zinc-500 text-base flex-shrink-0">
                ✎
              </span>
            </div>
          ) : (
            <h2 className={`text-xl font-bold truncate ${listProgressState === "empty" ? "text-gray-500 dark:text-zinc-400" : listProgressState === "complete" ? "text-emerald-800 dark:text-emerald-200" : ""}`} data-testid="list-title"><Highlight text={list.title} query={searchQuery} /></h2>
          )}
        </div>

        {/* Заполненная заметка видна отдельно; создание пустой заметки находится в меню. */}
        {!isTemp && (
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Сводка «выполнено / всего». Стоит в шапке независимо от
                свёрнутости и на том же месте, чтобы не прыгать при
                сворачивании. Скрывается на время переименования: заголовок
                становится полем ввода, и ему нужна вся ширина. Числа со
                слэшем переводить нечего, локали получает только подпись для
                скринридера. */}
            {showItemsCounter && !isEditing && itemsCount > 0 && (
              <span
                data-testid="list-items-counter"
                aria-label={t("ariaItemsCounter", {
                  done: completedItemsCount,
                  total: itemsCount,
                })}
                className="mr-1 text-xs tabular-nums text-gray-400 dark:text-zinc-500"
              >
                {completedItemsCount} / {itemsCount}
              </span>
            )}

            {/* Заметка доступна и у свёрнутой карточки: она свойство списка
                целиком, как заголовок, и живёт выше скрытого тела. Пустую
                заметку по-прежнему создают из меню, поэтому кнопка появляется
                только когда текст есть. */}
            {!isEditing && list.note && (
              <ListNoteButton
                note={list.note}
                isOpen={isListNoteOpen}
                onToggle={toggleListNote}
              />
            )}

            {isOwner && isEditing ? (
                <>
                  <Tooltip label={commonT("save")}>
                    <button
                      type="button"
                      onMouseDown={() => { skipBlurRef.current = true; }}
                      onClick={() => void handleConfirmRename()}
                      className="hidden sm:inline-flex items-center justify-center w-6 h-6 rounded text-sm text-green-600 dark:text-green-500 hover:bg-green-50 dark:hover:bg-zinc-700 transition"
                    >
                      ✓
                    </button>
                  </Tooltip>
                  <Tooltip label={commonT("cancel")}>
                    <button
                      type="button"
                      onMouseDown={() => { skipBlurRef.current = true; }}
                      onClick={() => setIsEditing(false)}
                      className="inline-flex items-center justify-center w-6 h-6 rounded text-sm text-gray-400 dark:text-zinc-500 hover:bg-gray-100 dark:hover:bg-zinc-700 hover:text-gray-600 dark:hover:text-zinc-300 transition"
                    >
                      ✗
                    </button>
                  </Tooltip>
                </>
              ) : (
                <div ref={actionsMenuRef} className="relative">
                  {/* Свой `aria-label` подробнее подсказки: скринридер читает
                      кнопку вне контекста карточки, и название списка ему
                      нужно, а в подсказке оно рядом и так. Пока меню открыто,
                      подсказка не нужна — его пункты уже на экране. */}
                  <Tooltip
                    label={t("listActions")}
                    disabled={isActionsMenuOpen}
                  >
                    <button
                      ref={actionsMenuButtonRef}
                      type="button"
                      data-testid="list-menu-trigger"
                      aria-label={t("ariaListActions", { title: list.title })}
                      aria-haspopup="menu"
                      aria-expanded={isActionsMenuOpen}
                      aria-controls={`list-actions-${list.id}`}
                      onClick={(event) => {
                        setIsListNoteOpen(false);
                        // Координаты берём из самой кнопки: на момент клика меню
                        // ещё не отрисовано, измерять по нему нечего.
                        setActionsMenuAnchor(anchorFor(event.currentTarget));
                        setIsActionsMenuOpen((current) => !current);
                      }}
                      className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                        isActionsMenuOpen
                          ? "bg-gray-100 text-gray-900 dark:bg-zinc-800 dark:text-white"
                          : "text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
                      }`}
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

                  {isActionsMenuOpen && actionsMenuAnchor && (
                    <div
                      ref={actionsMenuPanelRef}
                      id={`list-actions-${list.id}`}
                      role="menu"
                      data-testid="list-menu"
                      style={{
                        top: actionsMenuAnchor.top,
                        bottom: actionsMenuAnchor.bottom,
                        right: actionsMenuAnchor.right,
                      }}
                      className="fixed z-40 min-w-48 rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg dark:border-zinc-700 dark:bg-zinc-800 dark:shadow-black/60"
                    >
                      {/* Дубль шеврона: меню — доступная с клавиатуры точка
                          входа ко всем действиям списка, и сворачивание не
                          должно быть исключением. */}
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="list-collapse-menu-item"
                        onClick={() => {
                          setIsActionsMenuOpen(false);
                          handleToggleCollapse();
                        }}
                        className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                      >
                        <CollapseChevron isCollapsed={isBodyHidden} />
                        {isBodyHidden ? t("expandAction") : t("collapseAction")}
                      </button>

                      {onMoveInGroup && (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="list-move-earlier"
                            disabled={!canMoveEarlier}
                            onClick={() => {
                              setIsActionsMenuOpen(false);
                              onMoveInGroup(list.id, "earlier");
                            }}
                            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-700"
                          >
                            <ArrowUp aria-hidden size={17} />
                            {t("moveEarlierAction")}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="list-move-later"
                            disabled={!canMoveLater}
                            onClick={() => {
                              setIsActionsMenuOpen(false);
                              onMoveInGroup(list.id, "later");
                            }}
                            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-700"
                          >
                            <ArrowDown aria-hidden size={17} />
                            {t("moveLaterAction")}
                          </button>
                        </>
                      )}

                      <div
                        role="separator"
                        className="my-1 h-px bg-gray-100 dark:bg-zinc-700"
                      />

                      {!list.note && (
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="list-note-add"
                          onClick={() => {
                            setIsActionsMenuOpen(false);
                            setActivePanel(null);
                            setIsListNoteOpen(true);
                          }}
                          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                        >
                          <NoteIcon size={17} />
                          {notesT("addListNote")}
                        </button>
                      )}

                      {/* Удаление заметки доступно всем, кто может её редактировать.
                          Пункт нейтральный: он затрагивает только заметку, а красный
                          акцент оставлен удалению самого списка. */}
                      {list.note && (
                        <button
                          type="button"
                          role="menuitem"
                          data-testid="list-note-delete"
                          onClick={() => {
                            setIsActionsMenuOpen(false);
                            setIsNoteDeleteOpen(true);
                          }}
                          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
                        >
                          <NoteRemoveIcon />
                          {notesT("deleteNote")}
                        </button>
                      )}

                      {/* Только для авторизованных: у гостя нет ни AI, ни
                          пространств, а `useCurrentSpaceId` вне провайдера
                          бросает исключение — поэтому пункт вынесен в
                          отдельный компонент, а не спрятан условием внутри. */}
                      {!isGuest && (
                        <ListAiToggleMenuItem
                          listId={list.id}
                          aiEnabled={aiEnabled}
                          onOptimistic={(next) => {
                            setIsActionsMenuOpen(false);
                            setAiEnabled(next);
                            // Открытая панель инсайта после выключения
                            // потеряла бы смысл.
                            if (!next && activePanel === "ai") setActivePanel(null);
                          }}
                          onRevert={setAiEnabled}
                        />
                      )}

                      {isOwner && (
                        <>
                          <div
                            role="separator"
                            className="my-1 h-px bg-gray-100 dark:bg-zinc-700"
                          />
                          <button
                            type="button"
                            role="menuitem"
                            data-testid="list-delete"
                            disabled={isDeleting}
                            onClick={() => {
                              setIsActionsMenuOpen(false);
                              onDelete(list);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40"
                          >
                            <TrashIcon />
                            {t("deleteListAction")}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            }
          </div>
        )}
      </div>

      {/* Общая заметка доступна владельцу, EDITOR-участникам и гостю.
          Стоит выше тела и потому видна у свёрнутой карточки: заметка относится
          к списку целиком, как заголовок, а не к его содержимому. Полный текст
          и редактор открываются диалогом изнутри `NotePanel` — если бы блок
          лежал в теле, `visibility: hidden` наследовался бы и в диалог. */}
      {!isTemp && (
        <ListNote
          listId={list.id}
          listTitle={list.title}
          note={list.note}
          noteVersion={list.noteVersion}
          searchQuery={searchQuery}
          isOpen={isListNoteOpen}
          onClose={() => setIsListNoteOpen(false)}
          isLastBlock={isBodyHidden}
        />
      )}

      {/* Тело карточки. Скрывается классом, а не размонтированием: открытая
          панель и черновик заметки переживают сворачивание, как и панели
          шаринга внутри. */}
      <motion.div
        id={bodyId}
        ref={bodyRef}
        // Содержимое остаётся смонтированным, поэтому его нужно убирать из
        // фокуса и дерева доступности вручную: без `inert` Tab уходил бы в
        // невидимую часть свёрнутой карточки.
        inert={isBodyHidden}
        // initial={false} обязателен: иначе каждая карточка проигрывала бы
        // разворачивание при первом рендере и после каждого realtime-обновления.
        initial={false}
        animate={{ height: isBodyHidden ? 0 : "auto", opacity: isBodyHidden ? 0 : 1 }}
        transition={collapseTransition}
        onAnimationStart={() => {
          isAnimatingBodyRef.current = true;
          const node = bodyRef.current;
          if (!node) return;
          // Пока высота меняется, содержимое обязано быть видно — иначе
          // сворачивать нечего, — но не должно вылезать за пределы тела.
          node.style.overflow = "hidden";
          node.style.visibility = "";
        }}
        onAnimationComplete={() => {
          isAnimatingBodyRef.current = false;
          applyRestingBodyStyle();
        }}
      >
        {/* Skeleton-заглушка для temp-списка */}
        {isTemp && (
          <div className="space-y-2 animate-pulse" aria-hidden>
            <div className="h-4 bg-gray-100 dark:bg-zinc-800 rounded w-3/4" />
            <div className="h-4 bg-gray-100 dark:bg-zinc-800 rounded w-1/2" />
            <div className="h-4 bg-gray-100 dark:bg-zinc-800 rounded w-2/3" />
          </div>
        )}

        {/* Список записей */}
        {!isTemp && (
          <SmartList
            items={list.items}
            listId={list.id}
            currentUserId={currentUserId}
            currentUserName={currentUserName}
            currentUserEmail={currentUserEmail}
            showAuthors={showAuthors}
            showItemNumbers={showItemNumbers}
            showItemsCounter={showItemsCounter}
            visibleItemIds={visibleItemIds}
            searchQuery={searchQuery}
          />
        )}

        {/* AI инсайт и форма совместного доступа — недоступны в гостевом режиме */}
        {!isTemp && !isGuest && (
          <div className="mt-4 pt-4 border-t border-gray-100 dark:border-zinc-700">
            {/* Если есть участники — кнопки вертикально (каждая над своей панелью).
                Иначе — на одной строке, панель полной шириной под ними. */}
            {isOwner && list.sharedWith.length > 0 ? (
              <div className="flex flex-col gap-2">
                <div>
                  <ShareListButton
                    isOpen={activePanel === "share"}
                    onToggle={() => togglePanel("share")}
                    sharedCount={list.sharedWith.length}
                  />
                  <div className={activePanel === "share" ? "block" : "hidden"}>
                    <ShareListForm listId={list.id} sharedWith={list.sharedWith} />
                  </div>
                </div>
                {aiEnabled && (
                  <div>
                    <AiInsightButton
                      isOpen={activePanel === "ai"}
                      onToggle={() => togglePanel("ai")}
                    />
                    <div className={activePanel === "ai" ? "block" : "hidden"}>
                      <AiInsight listId={list.id} />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div className="flex gap-2 flex-wrap">
                  {isOwner && (
                    <ShareListButton
                      isOpen={activePanel === "share"}
                      onToggle={() => togglePanel("share")}
                      sharedCount={0}
                    />
                  )}
                  {aiEnabled && (
                    <AiInsightButton
                      isOpen={activePanel === "ai"}
                      onToggle={() => togglePanel("ai")}
                    />
                  )}
                </div>
                {isOwner && (
                  <div className={activePanel === "share" ? "block" : "hidden"}>
                    <ShareListForm listId={list.id} sharedWith={list.sharedWith} />
                  </div>
                )}
                {aiEnabled && (
                  <div className={activePanel === "ai" ? "block" : "hidden"}>
                    <AiInsight listId={list.id} />
                  </div>
                )}
              </div>
            )}

            {/* Вложения — доступны любому участнику списка (владелец + sharedWith) */}
            <div className="mt-2">
              <AttachmentsButton
                isOpen={activePanel === "files"}
                onToggle={() => togglePanel("files")}
                count={list.files.length}
              />
              <div className={activePanel === "files" ? "block" : "hidden"}>
                <Attachments
                  listId={list.id}
                  files={list.files}
                  currentUserId={currentUserId}
                />
              </div>
            </div>
          </div>
        )}

        {/* Меню назначения в группу */}
        {!isTemp && (
          <div className="mt-3 pt-3 border-t border-gray-100 dark:border-zinc-700 flex items-center justify-between">
            <div className="relative" ref={groupMenuRef}>
              <Tooltip label={t("ariaGroupMenu")} disabled={isGroupMenuOpen}>
                <button
                  type="button"
                  data-testid="list-group-trigger"
                  onClick={() => setIsGroupMenuOpen((prev) => !prev)}
                  className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 transition-colors"
                >
                  {list.groups.length > 0 ? (
                    /* Бейджи групп — список состоит в группе */
                    <span className="flex items-center gap-1 flex-wrap">
                      {list.groups.map((g) => (
                        <span
                          key={g.id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300 border border-blue-200 dark:border-blue-800"
                        >
                          {g.name}
                        </span>
                      ))}
                      {/* Кнопка добавления в ещё одну группу — тот же стиль что "+" в GroupFilter */}
                      <span className="w-5 h-5 flex items-center justify-center rounded-full text-gray-400 dark:text-zinc-500 hover:bg-gray-100 dark:hover:bg-zinc-800 hover:text-gray-700 dark:hover:text-zinc-300 transition-colors text-sm leading-none">
                        +
                      </span>
                    </span>
                  ) : (
                    /* Иконка папки с плюсом — группа не назначена */
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        <line x1="12" y1="11" x2="12" y2="17" />
                        <line x1="9" y1="14" x2="15" y2="14" />
                      </svg>
                      {t("noGroup")}
                    </>
                  )}
                </button>
              </Tooltip>

              {/* Дропдаун со списком групп */}
              {isGroupMenuOpen && (
                <div className="absolute bottom-full left-0 mb-1 z-20 min-w-44 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg shadow-lg py-1">
                  {userGroups.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-gray-400 dark:text-zinc-500">
                      {t("noGroupsHint")}
                    </p>
                  ) : (
                    userGroups.map((group) => {
                      const inGroup = list.groups.some((g) => g.id === group.id);
                      return (
                        <button
                          key={group.id}
                          type="button"
                          data-testid="list-group-option"
                          data-group-id={group.id}
                          data-in-group={inGroup}
                          data-pending={pendingGroupId === group.id}
                          disabled={pendingGroupId !== null}
                          onClick={async () => {
                            if (pendingGroupId !== null) return;
                            setPendingGroupId(group.id);
                            try {
                              const success = await onToggleListGroup(
                                list.id,
                                group.id,
                                inGroup,
                              );
                              if (success) {
                                setIsGroupMenuOpen(false);
                              }
                            } finally {
                              setPendingGroupId(null);
                            }
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-zinc-200 hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors text-left disabled:cursor-wait disabled:opacity-60"
                        >
                          <span className={`w-4 h-4 flex-shrink-0 flex items-center justify-center rounded text-xs ${
                            inGroup
                              ? "bg-gray-800 dark:bg-zinc-200 text-white dark:text-zinc-900"
                              : "border border-gray-300 dark:border-zinc-600"
                          }`}>
                            {inGroup && "✓"}
                          </span>
                          <span className="truncate">{group.name}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Подпись владельца + кнопка Отписаться */}
        {!isOwner && (
          <div className="mt-4 pt-4 border-t border-gray-100 dark:border-zinc-700 flex items-center justify-between">
            <span className="text-xs text-gray-400">
              {t("owner", { name: list.owner.name || list.owner.email })}
            </span>
            <button
              type="button"
              data-testid="list-leave"
              disabled={isLeaving}
              onClick={() => onLeave(list)}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 4h3a2 2 0 0 1 2 2v14" />
                <path d="M2 20h3" />
                <path d="M13 20h9" />
                <path d="M10 12v.01" />
                <path d="M13 4.562v16.157a1 1 0 0 1-1.242.97L5 20V5.562a2 2 0 0 1 1.515-1.94l4-1A2 2 0 0 1 13 4.561Z" />
              </svg>
              {t("unsubscribe")}
            </button>
          </div>
        )}
      </motion.div>

      {isNoteDeleteOpen && (
        <DeleteNoteModal
          version={list.noteVersion}
          onSave={(draft, expectedVersion) =>
            api.updateListNote(list.id, draft, expectedVersion)
          }
          onDeleted={() => {
            setIsNoteDeleteOpen(false);
            setIsListNoteOpen(false);
          }}
          onCancel={() => setIsNoteDeleteOpen(false)}
        />
      )}
    </div>
  );
});

export default ListCard;
