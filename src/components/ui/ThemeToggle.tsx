"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";

import Tooltip from "@/components/ui/Tooltip";

export function ThemeToggle() {
  const t = useTranslations("Common");
  // resolvedTheme содержит фактическую тему ("light"/"dark"), в отличие от theme,
  // который при defaultTheme="system" может быть равен "system" и ломать переключение.
  const { resolvedTheme, setTheme } = useTheme();
  // Первый клиентский рендер совпадает с SSR; тема доступна после гидратации.
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    // Одноразовый переход после mount сохраняет SSR-placeholder без скачка размеров.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  if (!mounted) {
    // Return a placeholder of exactly the same size to avoid layout shift
    return <div className="w-10 h-10" />;
  }

  const isDark = resolvedTheme === "dark";
  // Подпись называет тему, в которую переключит нажатие, а не текущую: иконка
  // показывает состояние, а подсказка — результат действия.
  const label = isDark ? t("themeLight") : t("themeDark");

  return (
    <Tooltip label={label}>
      <button
        onClick={() => setTheme(isDark ? "light" : "dark")}
        className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
      >
        {isDark ? (
          <Moon className="w-6 h-6 text-gray-200" />
        ) : (
          <Sun className="w-6 h-6 text-gray-700" />
        )}
      </button>
    </Tooltip>
  );
}
