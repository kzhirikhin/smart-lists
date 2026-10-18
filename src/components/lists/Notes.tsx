/**
 * @file Notes.tsx
 * @description Общие просмотрщик и редактор plain-text заметок, а также панель заметки списка.
 *
 * Редактор сохраняет текст только по явному действию пользователя — кнопкой или
 * Ctrl/Cmd+Enter. Одиночный Enter переносит строку: заметка многострочная по
 * смыслу. Версия, полученная при открытии, передаётся в API: если заметку уже
 * изменили в другой вкладке или другой участник, черновик остаётся на экране и
 * показывается выбор.
 *
 * Заметка до нескольких строк живёт прямо в карточке. Более длинная обрезается
 * и открывается в диалоге: карточка узкая, и 4000 символов дают больше двух
 * экранов текста, из-за чего одна запись вытесняет весь остальной список.
 * Решение принимается по фактическому переполнению, а не по длине текста —
 * на узком экране та же заметка занимает втрое больше строк.
 */

"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  // Под алиасом: без него React-тип затеняет DOM-овский `KeyboardEvent`,
  // на котором держатся глобальные слушатели Escape в этом же файле.
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import toast from "react-hot-toast";
import { useListsApi, type NoteActionResult } from "@/components/providers/ListsApiProvider";
import Highlight from "@/components/ui/Highlight";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Tooltip from "@/components/ui/Tooltip";
import { getNoteExcerpt, MAX_NOTE_LENGTH, normalizeNote } from "@/lib/notes";

/** Высота свёрнутой заметки в режиме чтения, px. Дальше текст обрезается. */
const COLLAPSED_NOTE_HEIGHT = 176;

/** Предел автоподбора высоты textarea во встроенном редакторе, px. */
const INLINE_EDITOR_HEIGHT = 240;

/**
 * Второстепенная кнопка панели заметки: закрыть, отменить, развернуть.
 *
 * Ховер меняет фон, рамку и цвет текста сразу: одного фона мало, потому что
 * подложка диалога светлее карточки в светлой теме и совпадает с `zinc-800`
 * в тёмной, и подсветка только фоном там незаметна.
 */
const SECONDARY_BUTTON_CLASS =
  "rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-500 transition-colors hover:border-gray-300 hover:bg-gray-100 hover:text-gray-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-200";

/** Основное действие панели заметки: сохранить, перейти к редактированию. */
const PRIMARY_BUTTON_CLASS =
  "rounded-md bg-gray-800 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-gray-700 dark:bg-zinc-200 dark:text-zinc-900 dark:hover:bg-white";

type Conflict = {
  note: string;
  version: number;
};

type EditorState = {
  draft: string;
  baseNote: string;
  baseVersion: number;
  conflict: Conflict | null;
};

type NoteSaveHandler = (note: string, expectedVersion: number) => Promise<NoteActionResult>;

type NoteEditorController = ReturnType<typeof useNoteEditor>;

type NoteEditorProps = {
  /** Общее состояние черновика: живёт выше редактора и переживает его пересоздание. */
  controller: NoteEditorController;
  onCancel: () => void;
  /** Редактор внутри диалога: textarea занимает всю высоту и не подстраивается под текст. */
  expanded?: boolean;
  /** Открыть тот же черновик в диалоге. Не передаётся, когда диалог уже открыт. */
  onExpand?: () => void;
  compact?: boolean;
};

type NotePanelProps = {
  note: string | null;
  version: number;
  /** Название списка или записи — заголовок диалога развёрнутой заметки. */
  title: string;
  onSave: NoteSaveHandler;
  onClose: () => void;
  compact?: boolean;
  searchQuery?: string;
};

type DeleteNoteModalProps = {
  /** Актуальная версия заметки: приходит из props владельца и обновляется по realtime. */
  version: number;
  onSave: NoteSaveHandler;
  /** Заметка удалена — владелец закрывает модал и панель заметки. */
  onDeleted: () => void;
  /** Отмена или неуспешное удаление — владелец закрывает только модал. */
  onCancel: () => void;
};

/** Иконка заметки; заполненная версия показывает, что текст уже существует. */
export function NoteIcon({
  filled = false,
  size = 14,
}: {
  filled?: boolean;
  size?: number;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      {filled && <line x1="8" y1="17" x2="13" y2="17" />}
    </svg>
  );
}

/** Иконка «раскрыть на весь экран» для перехода к диалогу заметки. */
function ExpandIcon({ size = 13 }: { size?: number }) {
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
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

/** Компактная кнопка заметки списка для правой части шапки карточки. */
export function ListNoteButton({
  note,
  isOpen,
  onToggle,
}: {
  note: string | null;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("Notes");
  const label = note ? t("listNote") : t("addListNote");

  return (
    <Tooltip label={label}>
      <button
        type="button"
        data-testid="list-note-toggle"
        onClick={onToggle}
        aria-expanded={isOpen}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
          isOpen || note
            ? "bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:text-indigo-300 dark:hover:bg-indigo-950/80"
            : "text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
        }`}
      >
        <NoteIcon filled={Boolean(note)} size={16} />
      </button>
    </Tooltip>
  );
}

/**
 * Сообщает, поместился ли текст в отведённую высоту.
 *
 * Проверяется фактическое переполнение, а не длина текста: короткая заметка из
 * множества переносов бывает выше длинной сплошной, а на узком экране границу
 * пересекает вдвое меньший текст. `ResizeObserver` ловит смену ширины карточки,
 * изменения самого текста приходят через `content`.
 */
function useOverflowRef<T extends HTMLElement>(enabled: boolean, content: unknown) {
  const ref = useRef<T>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) {
      setIsOverflowing(false);
      return;
    }

    const measure = () => {
      setIsOverflowing(element.scrollHeight > element.clientHeight + 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, content]);

  return [ref, isOverflowing] as const;
}

/**
 * Состояние черновика заметки: текст, ожидаемая версия, конфликт и сохранение.
 *
 * Состояние живёт выше самого редактора, потому что редактор показывается то
 * встроенно, то внутри диалога. Это разные места дерева, и при переключении
 * React пересоздаёт компонент — набранный текст пропал бы вместе с ним.
 */
function useNoteEditor({
  note,
  version,
  onSave,
  onSaved,
}: {
  note: string | null;
  version: number;
  onSave: NoteSaveHandler;
  onSaved: (note: string | null, version: number) => void;
}) {
  const t = useTranslations("Notes");
  const [state, setState] = useState<EditorState>({
    draft: note ?? "",
    baseNote: note ?? "",
    baseVersion: version,
    conflict: null,
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Свежие props приходят через Pusher/RSC. Чистый редактор синхронизируем,
  // а при наличии черновика сохраняем его и лишь отмечаем конфликт.
  useEffect(() => {
    if (version === state.baseVersion) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((current) => {
      if (current.draft === current.baseNote) {
        return {
          draft: note ?? "",
          baseNote: note ?? "",
          baseVersion: version,
          conflict: null,
        };
      }
      return {
        ...current,
        conflict: { note: note ?? "", version },
      };
    });
  }, [note, version, state.baseVersion]);

  const setDraft = useCallback((draft: string) => {
    setState((current) => ({ ...current, draft }));
  }, []);

  /** Выход из редактора без применения правок возвращает сохранённый текст. */
  const resetDraft = useCallback(() => {
    setState((current) => ({ ...current, draft: current.baseNote, conflict: null }));
    setError(null);
  }, []);

  /** Принять чужую версию, отказавшись от собственного черновика. */
  const takeConflictVersion = useCallback(() => {
    setState((current) =>
      current.conflict
        ? {
            draft: current.conflict.note,
            baseNote: current.conflict.note,
            baseVersion: current.conflict.version,
            conflict: null,
          }
        : current,
    );
  }, []);

  const save = useCallback(
    async (expectedVersion: number) => {
      if (isSaving) return;
      setIsSaving(true);
      setError(null);

      const result = await onSave(state.draft, expectedVersion);
      setIsSaving(false);

      if (result.success) {
        const savedNote = result.note === undefined ? normalizeNote(state.draft) : result.note;
        const savedVersion = result.noteVersion ?? expectedVersion;
        setState({
          draft: savedNote ?? "",
          baseNote: savedNote ?? "",
          baseVersion: savedVersion,
          conflict: null,
        });
        onSaved(savedNote ?? null, savedVersion);
        return;
      }

      if (result.error === "noteConflict") {
        setState((current) => ({
          ...current,
          conflict: {
            note: result.currentNote ?? "",
            version: result.currentVersion ?? expectedVersion,
          },
        }));
        return;
      }

      setError(result.error === "tooLong" ? t("tooLong") : t("saveFailed"));
    },
    [isSaving, onSave, onSaved, state.draft, t],
  );

  return {
    state,
    isDirty: state.draft !== state.baseNote,
    isSaving,
    error,
    setDraft,
    resetDraft,
    takeConflictVersion,
    save,
  };
}

/**
 * Диалог развёрнутой заметки.
 *
 * Рендерится порталом в `document.body`. Панель заметки живёт внутри строки
 * записи и карточки списка, а у обеих есть анимируемый framer-motion предок с
 * `transform`. Такой предок становится содержащим блоком для `position: fixed`,
 * и диалог позиционировался бы по карточке, а не по экрану.
 *
 * `closeOnBackdrop` выключается на время редактирования: случайный клик мимо
 * диалога не должен прерывать набор текста. Явные способы закрытия — крестик,
 * кнопки действий и Escape — остаются доступны всегда.
 */
function NoteModal({
  title,
  onClose,
  closeOnBackdrop = true,
  children,
}: {
  title: string;
  onClose: () => void;
  closeOnBackdrop?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("Notes");
  // Клик засчитываем только если нажатие тоже началось на подложке. Иначе
  // выделение текста мышью, законченное за пределами диалога, закрывало бы его.
  const pressStartedOnBackdrop = useRef(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Пока диалог открыт, фон не должен прокручиваться. Ширину исчезающего
  // скроллбара компенсируем padding-ом, иначе страница дёргается по горизонтали.
  useEffect(() => {
    const { body, documentElement } = document;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      const currentPaddingRight = parseFloat(getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${currentPaddingRight + scrollbarWidth}px`;
    }

    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
    };
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px] dark:bg-black/80"
      onMouseDown={(event) => {
        pressStartedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (!closeOnBackdrop) return;
        if (event.target !== event.currentTarget) return;
        if (!pressStartedOnBackdrop.current) return;
        onClose();
      }}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-white p-4 shadow-lg dark:border dark:border-zinc-700 dark:bg-zinc-800 dark:shadow-2xl dark:shadow-black/70"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="note-dialog"
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="shrink-0 text-indigo-500 dark:text-indigo-400">
            <NoteIcon filled size={16} />
          </span>
          <h3 className="min-w-0 truncate text-sm font-semibold">{title}</h3>
          <Tooltip label={t("close")}>
            <button
              type="button"
              data-testid="note-dialog-close"
              onClick={onClose}
              className="-mr-1 ml-auto shrink-0 rounded p-1 text-gray-400 transition-colors hover:text-gray-700 dark:hover:text-zinc-200"
            >
              ✕
            </button>
          </Tooltip>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Универсальный редактор заметки списка или записи. */
export function NoteEditor({
  controller,
  onCancel,
  onExpand,
  expanded = false,
  compact = false,
}: NoteEditorProps) {
  const t = useTranslations("Notes");
  const { state, isDirty, isSaving, error, setDraft, save, takeConflictVersion } = controller;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** Текст упёрся в предел высоты — есть смысл предлагать диалог. */
  const [isCapped, setIsCapped] = useState(false);

  // Встроенный редактор растёт по содержимому, но не выше предела: дальше
  // textarea прокручивается сама, иначе длинная заметка растягивает карточку.
  // В диалоге высоту задаёт flex-раскладка, подстраивать её под текст не нужно.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || expanded) return;
    textarea.style.height = "auto";
    const fullHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.min(fullHeight, INLINE_EDITOR_HEIGHT)}px`;
    setIsCapped(fullHeight > INLINE_EDITOR_HEIGHT);
  }, [state.draft, expanded]);

  // Переход между встроенным редактором и диалогом создаёт новую textarea,
  // поэтому каретку возвращаем в конец текста, а не в начало нового элемента.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }, []);

  /** Условие активности сохранения. Общее для кнопки и хоткея. */
  const canSave = !isSaving && (isDirty || Boolean(state.conflict));

  /**
   * Ctrl/Cmd+Enter — полный эквивалент кнопки «Сохранить»: та же версия, то же
   * условие активности. При открытом конфликте это, как и кнопка, повторная
   * попытка от устаревшей версии; перезапись остаётся отдельным осознанным
   * действием в блоке конфликта.
   *
   * Обработчик висит на textarea, а не на window: в диалоге уже есть глобальный
   * слушатель Escape, и второй глобальный хоткей срабатывал бы вне редактора.
   */
  const handleSaveShortcut = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    // Enter в процессе IME-набора подтверждает слово, а не сохраняет заметку.
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!canSave) return;
    void save(state.baseVersion);
  };

  return (
    <div
      className={`space-y-2 ${
        expanded ? "flex min-h-0 flex-1 flex-col" : compact ? "mt-2" : "mt-3"
      }`}
    >
      {/* Рамка и фокусное кольцо живут на обёртке, а не на textarea: внутрь
          рамки попадает и полоса перехода к диалогу. */}
      <div
        className={`rounded-lg border border-gray-200 bg-gray-50 transition focus-within:bg-white focus-within:ring-1 ring-gray-500 dark:border-zinc-700 dark:bg-zinc-800 dark:focus-within:bg-zinc-900 dark:ring-zinc-500 ${
          expanded ? "flex min-h-0 flex-1 flex-col" : ""
        }`}
      >
        <div className={`relative ${expanded ? "flex min-h-0 flex-1 flex-col" : ""}`}>
          <textarea
            ref={textareaRef}
            autoFocus
            data-testid="note-textarea"
            value={state.draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleSaveShortcut}
            rows={compact ? 3 : 5}
            maxLength={MAX_NOTE_LENGTH}
            placeholder={t("placeholder")}
            className={`w-full resize-none overflow-y-auto bg-transparent px-3 py-2 pb-7 text-sm text-gray-700 outline-none dark:text-zinc-200 ${
              expanded ? "min-h-[30vh] flex-1" : ""
            }`}
          />
          <span
            className={`absolute bottom-2 right-2 text-[10px] ${
              state.draft.length >= MAX_NOTE_LENGTH
                ? "font-medium text-red-500 dark:text-red-400"
                : "text-gray-400 dark:text-zinc-500"
            }`}
          >
            {state.draft.length}/{MAX_NOTE_LENGTH}
          </span>
        </div>

        {onExpand && isCapped && <ExpandRow label={t("expand")} onClick={onExpand} />}
      </div>

      {state.conflict && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300">
          <p>{t("conflict")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="note-conflict-load"
              onClick={takeConflictVersion}
              className="rounded-md border border-amber-300 px-2 py-1 hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/40"
            >
              {t("loadLatest")}
            </button>
            <button
              type="button"
              data-testid="note-conflict-overwrite"
              disabled={isSaving}
              onClick={() => void save(state.conflict?.version ?? state.baseVersion)}
              className="rounded-md bg-amber-700 px-2 py-1 text-white hover:bg-amber-800 disabled:opacity-50"
            >
              {t("overwrite")}
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        {/* Подсказка к хоткею. Показывается только при точном указателе:
            на тач-устройстве клавиш Ctrl и Cmd нет. Текст короткий, потому что
            во встроенном редакторе узкой карточки рядом стоят обе кнопки;
            полная формулировка живёт в подсказке кнопки сохранения. Своей у
            этой строки нет намеренно: `Tooltip` подписывает элемент через
            `aria-label`, а у неинтерактивного `span` такой подписи быть не
            должно — ARIA её там игнорирует. */}
        <span
          data-testid="note-save-shortcut"
          className="mr-auto hidden select-none text-[11px] text-gray-400 pointer-fine:inline dark:text-zinc-500"
        >
          {t("saveShortcutKeys")}
        </span>
        <button
          type="button"
          data-testid="note-cancel"
          onClick={onCancel}
          disabled={isSaving}
          className={`disabled:opacity-50 ${SECONDARY_BUTTON_CLASS}`}
        >
          {t("cancel")}
        </button>
        <Tooltip label={t("saveShortcut")} labelsTrigger={false}>
          <button
            type="button"
            data-testid="note-save"
            onClick={() => void save(state.baseVersion)}
            disabled={!canSave}
            className={`disabled:cursor-not-allowed disabled:opacity-50 ${PRIMARY_BUTTON_CLASS}`}
          >
            {isSaving ? t("saving") : t("save")}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * Переход к диалогу — нижняя полоса внутри рамки заметки.
 *
 * Не отдельная кнопка снаружи: третья кнопка не помещается в ряд действий узкой
 * карточки, а вынесенная над ним центрированная строка спорит с выключкой
 * действий вправо. Внутри рамки полоса читается как продолжение текста, и
 * снаружи остаётся ровно один ряд кнопок.
 */
function ExpandRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="note-expand"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-1.5 rounded-b-lg border-t border-gray-200 py-1.5 text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
    >
      <ExpandIcon />
      {label}
    </button>
  );
}

/** Действия режима чтения. Набор одинаков во встроенной панели и в диалоге. */
function NoteReadActions({ onClose, onEdit }: { onClose: () => void; onEdit: () => void }) {
  const t = useTranslations("Notes");

  return (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        data-testid="note-close"
        onClick={onClose}
        className={SECONDARY_BUTTON_CLASS}
      >
        {t("close")}
      </button>
      <button
        type="button"
        data-testid="note-edit"
        onClick={onEdit}
        className={`inline-flex items-center gap-1.5 ${PRIMARY_BUTTON_CLASS}`}
      >
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
        </svg>
        {t("edit")}
      </button>
    </div>
  );
}

/**
 * Заметка с отдельными режимами чтения и редактирования.
 * Существующий текст открывается без фокуса, а новая заметка — сразу в редакторе.
 *
 * Каждый режим показывается либо встроенно, либо в диалоге. Черновик и версия
 * общие для обоих мест, поэтому закрытие диалога с несохранённым текстом
 * возвращает его во встроенный редактор, а не теряет.
 */
export function NotePanel({
  note,
  version,
  title,
  onSave,
  onClose,
  compact = false,
  searchQuery = "",
}: NotePanelProps) {
  const t = useTranslations("Notes");
  const [isEditing, setIsEditing] = useState(!note);
  const [isExpanded, setIsExpanded] = useState(false);
  const [displayed, setDisplayed] = useState({ note, version });

  // Обновляем режим чтения и базовую версию редактора при внешнем изменении заметки.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDisplayed({ note, version });
  }, [note, version]);

  const controller = useNoteEditor({
    note: displayed.note,
    version: displayed.version,
    onSave,
    onSaved: (savedNote, savedVersion) => {
      setDisplayed({ note: savedNote, version: savedVersion });
      if (savedNote) {
        setIsEditing(false);
        return;
      }
      // Пустой текст удаляет заметку — показывать больше нечего.
      setIsExpanded(false);
      onClose();
    },
  });

  const [readRef, isClamped] = useOverflowRef<HTMLDivElement>(!isEditing, displayed.note);

  const cancelEdit = () => {
    controller.resetDraft();
    if (displayed.note) {
      setIsEditing(false);
      return;
    }
    setIsExpanded(false);
    onClose();
  };

  const noteText = (
    <div
      data-testid="note-text"
      className="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-700 dark:text-zinc-200"
    >
      <Highlight text={displayed.note ?? ""} query={searchQuery.trim()} />
    </div>
  );

  return (
    <>
      {isEditing
        ? !isExpanded && (
            <NoteEditor
              controller={controller}
              compact={compact}
              onCancel={cancelEdit}
              onExpand={() => setIsExpanded(true)}
            />
          )
        : (
          <div className={`${compact ? "mt-2" : "mt-3"} space-y-2`}>
            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
              <div className="relative">
                <div
                  ref={readRef}
                  style={{ maxHeight: COLLAPSED_NOTE_HEIGHT }}
                  className="overflow-hidden px-3 py-2"
                >
                  {noteText}
                </div>
                {/* Затухание вместо резкого обрыва: видно, что текст продолжается. */}
                {isClamped && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white to-transparent dark:from-zinc-900" />
                )}
              </div>

              {isClamped && (
                <ExpandRow label={t("showFull")} onClick={() => setIsExpanded(true)} />
              )}
            </div>

            {/* Удаление заметки живёт в меню действий списка или записи. */}
            <NoteReadActions onClose={onClose} onEdit={() => setIsEditing(true)} />
          </div>
        )}

      {isExpanded && (
        <NoteModal
          title={title}
          onClose={() => setIsExpanded(false)}
          closeOnBackdrop={!isEditing}
        >
          {isEditing ? (
            <NoteEditor controller={controller} expanded onCancel={cancelEdit} />
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">{noteText}</div>
              <div className="mt-3">
                <NoteReadActions
                  onClose={() => setIsExpanded(false)}
                  onEdit={() => setIsEditing(true)}
                />
              </div>
            </>
          )}
        </NoteModal>
      )}
    </>
  );
}

/** Иконка корзины для пунктов меню и кнопок удаления. */
export function TrashIcon({ size = 17 }: { size?: number }) {
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
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M8 6V4h8v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

/**
 * Иконка удаления заметки: тот же лист, что и у `NoteIcon`, но с перечёркнутым
 * содержимым. Отличается от корзины, чтобы пункт меню не путали с удалением
 * самого списка или записи.
 */
export function NoteRemoveIcon({ size = 17 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
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
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9.5" y1="13" x2="14.5" y2="18" />
      <line x1="14.5" y1="13" x2="9.5" y2="18" />
    </svg>
  );
}

/**
 * Подтверждение удаления заметки. Вызывается из меню действий списка или записи,
 * поэтому рендерится вне выпадающего меню — иначе закрытие меню сняло бы модал.
 *
 * Удаление — это сохранение пустого текста с ожидаемой версией, поэтому здесь
 * действует та же проверка optimistic concurrency, что и в редакторе.
 */
export function DeleteNoteModal({
  version,
  onSave,
  onDeleted,
  onCancel,
}: DeleteNoteModalProps) {
  const t = useTranslations("Notes");
  const [isDeleting, setIsDeleting] = useState(false);

  const deleteNote = useCallback(async () => {
    if (isDeleting) return;
    setIsDeleting(true);

    const result = await onSave("", version);
    setIsDeleting(false);

    if (result.success) {
      onDeleted();
      return;
    }

    if (result.error === "noteConflict") {
      // Заметку уже удалили в другом месте — цель достигнута.
      if (!result.currentNote) {
        onDeleted();
        return;
      }
      // Актуальный текст и версия придут через realtime; повтор удалит свежую заметку.
      toast.error(t("deleteConflict"));
      onCancel();
      return;
    }

    toast.error(t("deleteFailed"));
    onCancel();
  }, [isDeleting, onCancel, onDeleted, onSave, t, version]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isDeleting) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void deleteNote();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteNote, isDeleting, onCancel]);

  return (
    <ConfirmModal
      title={t("deleteNoteModal.title")}
      body={t("deleteNoteModal.body")}
      confirmLabel={t("deleteNoteModal.confirm")}
      cancelLabel={t("deleteNoteModal.cancel")}
      isConfirming={isDeleting}
      onConfirm={() => void deleteNote()}
      onCancel={() => {
        if (!isDeleting) onCancel();
      }}
    />
  );
}

/** Раскрывающаяся заметка всего списка. Доступна также в гостевом режиме. */
export function ListNote({
  listId,
  listTitle,
  note,
  noteVersion,
  searchQuery,
  isOpen,
  onClose,
  isLastBlock = false,
}: {
  listId: string;
  /** Название списка — заголовок диалога развёрнутой заметки. */
  listTitle: string;
  note: string | null;
  noteVersion: number;
  searchQuery: string;
  isOpen: boolean;
  onClose: () => void;
  /**
   * Последний видимый блок карточки — отступ снизу не нужен.
   * Так бывает у свёрнутой карточки: записи и панели под заметкой скрыты, и
   * `mb-4` отделял бы её от пустоты, ломая симметрию с отступом сверху.
   */
  isLastBlock?: boolean;
}) {
  const api = useListsApi();
  const query = searchQuery.trim();
  const noteMatches = Boolean(
    note && query && note.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );

  if (!isOpen && !noteMatches) return null;

  return (
    <div
      className={`${isLastBlock ? "" : "mb-4"} rounded-lg border border-gray-200 bg-gray-50/80 px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-800/50`}
    >
      {!isOpen && noteMatches && note && (
        <p className="text-xs leading-relaxed text-gray-600 dark:text-zinc-300">
          <Highlight text={getNoteExcerpt(note, query)} query={query} />
        </p>
      )}

      {isOpen && (
        <NotePanel
          note={note}
          version={noteVersion}
          title={listTitle}
          onSave={(draft, expectedVersion) => api.updateListNote(listId, draft, expectedVersion)}
          onClose={onClose}
          searchQuery={query}
        />
      )}
    </div>
  );
}
