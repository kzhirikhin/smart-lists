/**
 * @file AiInsight.tsx
 * @description AI-инсайт для карточки списка.
 *
 * Экспортирует два компонента:
 *   - `AiInsightButton` — кнопка-триггер (управляется снаружи через `isOpen`/`onToggle`).
 *   - `AiInsight`       — панель с полем вопроса и результатом анализа.
 */

"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { getListInsight } from "@/app/actions/insights";
import { useCurrentSpaceId } from "@/components/spaces/SpaceContext";
import SafeMarkdown from "@/components/lists/SafeMarkdown";

/** Пропсы кнопки-триггера. */
type AiInsightButtonProps = {
  isOpen: boolean;
  onToggle: () => void;
};

/** Кнопка-пилюля для раскрытия панели AI-инсайта. */
export function AiInsightButton({ isOpen, onToggle }: AiInsightButtonProps) {
  const t = useTranslations("AiInsight");

  return (
    <button
      type="button"
      data-testid="ai-insight-button"
      onClick={onToggle}
      className={`inline-flex items-center gap-2 text-xs font-semibold px-3 py-1.5 rounded-full border transition-all duration-200 ${
        isOpen
          ? "bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-700/50 dark:text-indigo-400"
          : "bg-white border-gray-200 text-gray-500 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-indigo-700/50 dark:hover:text-indigo-400 dark:hover:bg-indigo-900/30"
      }`}
    >
      {/* Иконка искры */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="w-3.5 h-3.5 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z" />
      </svg>
      {t("button")}
      {/* Шеврон */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}

type AiInsightProps = {
  /** ID списка — используется для получения данных из БД на сервере. */
  listId: string;
};

/**
 * Панель AI-инсайта: поле вопроса, кнопка анализа, результат.
 * Рендерится только когда активна (управляется снаружи).
 */
export default function AiInsight({ listId }: AiInsightProps) {
  const t = useTranslations("AiInsight");
  const locale = useLocale();
  const spaceId = useCurrentSpaceId();

  const [userMessage, setUserMessage] = useState("");
  const [insight, setInsight] = useState<string | null>(null);
  const [notesContext, setNotesContext] = useState<{
    includedItemNotes: number;
    omittedItemNotes: number;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async () => {
    setInsight(null);
    setNotesContext(null);
    setError(null);
    setIsLoading(true);

    const result = await getListInsight(
      listId,
      userMessage.trim() || undefined,
      spaceId,
      locale,
    );

    setIsLoading(false);

    if (result.error === "rateLimitError") {
      setError(t("rateLimitError"));
    } else if (result.error === "aiDisabled") {
      // Кнопку в этот момент уже должны были скрыть, но состояние могло
      // измениться в другой вкладке между открытием панели и нажатием.
      setError(t("disabledError"));
    } else if (result.error) {
      setError(t("error"));
    } else if (result.insight) {
      setInsight(result.insight);
      setNotesContext(result.notesContext ?? null);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      {/* Куда уходят данные. Строка постоянная, а не всплывающая подсказка:
          она адресована в том числе участнику, который список не создавал и
          про отправку содержимого узнать больше неоткуда. */}
      <p
        data-testid="ai-privacy-notice"
        className="text-[11px] leading-snug text-gray-500 dark:text-zinc-500"
      >
        {t("privacyNotice")}
      </p>

      {/* Поле вопроса */}
      <div className="relative">
        <textarea
          value={userMessage}
          onChange={(e) => setUserMessage(e.target.value)}
          placeholder={t("placeholder")}
          rows={2}
          maxLength={500}
          className="w-full text-xs border border-gray-200 dark:border-zinc-700 rounded-lg px-2.5 py-2 pb-6 bg-gray-50 dark:bg-zinc-800 text-gray-700 dark:text-zinc-300 placeholder:text-gray-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 ring-gray-400 dark:ring-zinc-500 resize-none transition"
        />
        <div
          className={`absolute bottom-2 right-2 text-[10px] ${
            userMessage.length >= 500
              ? "text-red-500 dark:text-red-400 font-medium"
              : "text-gray-400 dark:text-zinc-500"
          }`}
        >
          {userMessage.length}/500
        </div>
      </div>

      {/* Кнопка запроса — полная ширина */}
      <button
        type="button"
        onClick={() => void handleAnalyze()}
        disabled={isLoading}
        className="w-full text-xs px-3 py-1.5 rounded-lg bg-gray-800 dark:bg-zinc-200 text-white dark:text-zinc-900 hover:bg-gray-700 dark:hover:bg-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5 font-medium"
      >
        {isLoading ? (
          <>
            {/* Спиннер */}
            <svg
              className="animate-spin"
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            {t("analyzing")}
          </>
        ) : (
          t("analyze")
        )}
      </button>

      {/* Результат — инсайт */}
      {insight && (
        <div className="text-xs text-gray-600 dark:text-zinc-300 leading-relaxed bg-gray-50 dark:bg-zinc-800 rounded-lg px-3 py-2.5 border border-gray-100 dark:border-zinc-700">
          <SafeMarkdown>{insight}</SafeMarkdown>
          {notesContext && (notesContext.includedItemNotes > 0 || notesContext.omittedItemNotes > 0) && (
            <p className="mt-2 border-t border-gray-200 pt-2 text-[10px] text-gray-400 dark:border-zinc-700 dark:text-zinc-500">
              {t("notesContext", {
                included: notesContext.includedItemNotes,
                omitted: notesContext.omittedItemNotes,
              })}
            </p>
          )}
        </div>
      )}

      {/* Ошибка */}
      {error && (
        <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
