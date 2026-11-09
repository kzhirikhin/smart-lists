"use client";

import { useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import toast from "react-hot-toast";
import Tooltip from "@/components/ui/Tooltip";
import Highlight from "@/components/ui/Highlight";
import { MAX_ITEM_STATE_LENGTH } from "@/lib/item-state";
import type { ActionResult } from "@/components/providers/ListsApiProvider";

/** Отдельный черновик не смешивает краткое состояние с названием и заметкой. */
export default function ItemState({ value, editing, onEdit, onClose, onSave, query }: {
  value: string | null;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
  onSave: (value: string) => Promise<ActionResult>;
  query: string;
}) {
  const t = useTranslations("ItemState");
  const commonT = useTranslations("Common");
  const [draft, setDraft] = useState(value ?? "");
  const [saving, startSaving] = useTransition();
  const savingRef = useRef(false);

  function save() {
    if (savingRef.current) return;
    const next = draft.trim();
    if (next === (value ?? "")) { onClose(); return; }
    savingRef.current = true;
    startSaving(async () => {
      try {
        const result = await onSave(next);
        if (result.success) onClose();
        else toast.error(t("error"));
      } catch {
        toast.error(t("error"));
      } finally {
        savingRef.current = false;
      }
    });
  }

  if (editing) return (
    <form className="mb-1.5 flex min-w-0 items-center gap-1" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <input
        autoFocus
        aria-label={t("label")}
        data-testid="item-state-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
          if (event.key === "Escape" && !savingRef.current) {
            event.preventDefault(); onClose();
          }
        }}
        maxLength={MAX_ITEM_STATE_LENGTH}
        placeholder={t("placeholder")}
        disabled={saving}
        className="w-full min-w-0 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs font-normal text-gray-700 outline-none focus:ring-1 focus:ring-gray-500 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300"
      />
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip label={commonT("save")}>
          <button
            data-testid="item-state-save"
            aria-label={commonT("save")}
            type="submit"
            disabled={saving}
            className="inline-flex items-center justify-center w-6 h-6 rounded text-sm text-green-600 dark:text-green-500 hover:bg-green-50 dark:hover:bg-zinc-700 transition disabled:opacity-50"
          >
            ✓
          </button>
        </Tooltip>
        <Tooltip label={commonT("cancel")}>
          <button
            data-testid="item-state-cancel"
            aria-label={commonT("cancel")}
            type="button"
            disabled={saving}
            onClick={onClose}
            className="inline-flex items-center justify-center w-6 h-6 rounded text-sm text-gray-400 dark:text-zinc-500 hover:bg-gray-100 dark:hover:bg-zinc-700 hover:text-gray-600 dark:hover:text-zinc-300 transition disabled:opacity-50"
          >
            ✗
          </button>
        </Tooltip>
      </div>
    </form>
  );

  if (!value) return null;
  return (
    <button
      type="button"
      data-testid="item-state-text"
      aria-label={t("edit") + ": " + value}
      onClick={() => { setDraft(value); onEdit(); }}
      className="mb-1 block max-w-full rounded text-left text-xs font-normal leading-relaxed text-gray-600 [overflow-wrap:anywhere] hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 dark:text-zinc-400 dark:hover:text-zinc-200"
    >
      <Highlight text={value} query={query} />
    </button>
  );
}
