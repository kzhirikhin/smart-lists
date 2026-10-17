// @ts-expect-error Node 24 исполняет этот модуль без bundler и требует расширение .ts.
import { activePolicy, activeRunSchema } from "./active-policy.ts";

/** Только закрытая схема/числа/enum. Findings находятся в отдельных отчётах
 * по фазам/источнику и никогда не объединяются с passive CI baseline. */
export function renderManual(raw: unknown) {
  const run = activeRunSchema.parse(raw);
  const lines = ["# Ручной двухэтапный ZAP", "", `Статус: **${run.status}**.`,
    `SHA: ${run.revision ?? "unknown"}; dirty: ${run.dirty ?? "unknown"}; начало UTC: ${run.startedAt ?? "unknown"}.`,
    `Фаза A: ${run.phaseA}; фаза B: ${run.phaseB}; учебная мишень: ${run.control}.`,
    `Пассивные запросы: ${run.passive?.requests ?? "unknown"}; очередь: ${run.passive?.pending ?? "unknown"}; неполные сценарии: ${run.passive?.failedScenarios.join(", ") || "нет"}.`,
    `Последний шаг: ${run.step ?? "precondition"}.`,
    `Последний API: ${run.lastApi ?? "unknown"}; отказ API: ${run.apiCode ?? "нет"}.`,
    `Запросы active: ${run.requests}/${activePolicy.maxRequests}; отклонено gate: ${run.rejected}; время: ${run.durationMs} ms.`,
    `Правила: ${activePolicy.rules.join(", ")}; сила LOW; один поток; query/multipart.`,
    `Причины: ${run.reasons.join(", ") || "нет"}.`, "",
    "| Роль | Action | Попытки | Изменённое поле | Успешные мутации | Сессия до/после | Правило: запросы |", "|---|---|---|---|---|---|---|",
    ...run.targets.map(target => `| ${target.role} | ${target.operation} | ${target.requests} | ${target.mutations} | ${target.successfulMutations} | ${target.sessionBefore}/${target.sessionAfter} | ${(target.rules ?? []).map(rule => `${rule.id}: ${rule.requests} (${rule.state})`).join(", ")} |`),
    "", "Фаза A — phase-a.html. Фаза B — phase-b-active.html и phase-b-passive.html (если подготовлены).",
    "Отсутствие active-находок не подтверждает безопасность остальных Actions/ролей/векторов.",
    "Нулевой счётчик запросов правила не означает его проверку на данном входе.",
    "Шлюз фиксирует session/Origin и служебные поля; этот профиль не проверяет CORS, CSRF или обход авторизации.",
    ...(run.control ? ["Учебная мишень отделена от Smart Lists. Результат нельзя приписывать приложению.", `Контрольная XSS обнаружена: ${run.controlFound}.`] : []), ""];
  const summary = lines.join("\n");
  const escaped = summary.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return { json: `${JSON.stringify(run, null, 2)}\n`, summary, html: `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Ручной ZAP</title><style>body{font:16px system-ui;margin:2rem}pre{white-space:pre-wrap}</style><pre>${escaped}</pre></html>` };
}
