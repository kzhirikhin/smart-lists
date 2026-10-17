/** Явный начальный набор; не инвентарь всех возможностей приложения. */
export const scenarios = [
  { id: "public-en", file: "zap/locales.e2e.ts", title: "ZAP публичная локаль en", auth: false, posts: 0 },
  { id: "public-ru", file: "zap/locales.e2e.ts", title: "ZAP публичная локаль ru", auth: false, posts: 0 },
  { id: "public-vi", file: "zap/locales.e2e.ts", title: "ZAP публичная локаль vi", auth: false, posts: 0 },
  { id: "public-ja", file: "zap/locales.e2e.ts", title: "ZAP публичная локаль ja", auth: false, posts: 0 },
  { id: "guest", file: "e2e/guest.e2e.ts", title: "гость работает со списками, и они переживают перезагрузку", auth: false, posts: 1 },
  { id: "session", file: "e2e/smoke.e2e.ts", title: "сессия из базы открывает пространство пользователя", auth: true, posts: 0 },
  { id: "list-create", file: "e2e/lists.e2e.ts", title: "созданный список переживает перезагрузку", auth: true, posts: 1, actions: ["createList"] },
  { id: "list-rename", file: "e2e/lists.e2e.ts", title: "список переименовывается по клику на название", auth: true, posts: 1, actions: ["renameList"] },
  { id: "list-delete", file: "e2e/lists.e2e.ts", title: "удаление списка требует подтверждения", auth: true, posts: 1, actions: ["deleteList"] },
  { id: "item-create", file: "e2e/items.e2e.ts", title: "запись добавляется и переживает перезагрузку", auth: true, posts: 1, actions: ["addItem"] },
  { id: "item-rename", file: "e2e/items.e2e.ts", title: "запись переименовывается по клику на название", auth: true, posts: 1, actions: ["renameItem"] },
  { id: "item-delete", file: "e2e/items.e2e.ts", title: "удаление записи требует подтверждения", auth: true, posts: 1, actions: ["deleteItem"] },
  { id: "notes", file: "e2e/notes.e2e.ts", title: "заметка списка сохраняется и переживает перезагрузку", auth: true, posts: 1, actions: ["updateListNote"] },
  { id: "spaces-switch", file: "e2e/spaces.e2e.ts", title: "переключение пространства меняет URL и набор списков", auth: true, posts: 0 },
  { id: "spaces-create", file: "e2e/spaces.e2e.ts", title: "новое пространство создаётся и сразу открывается", auth: true, posts: 1, actions: ["createSpace"] },
  { id: "groups", file: "e2e/groups.e2e.ts", title: "группа создаётся и фильтрует списки", auth: true, posts: 1, actions: ["createGroup", "addListToGroup"] },
  { id: "groups-isolation", file: "e2e/groups.e2e.ts", title: "активная группа переживает перезагрузку и не течёт в другое пространство", auth: true, posts: 0 },
  { id: "list-order", file: "e2e/list-ordering.e2e.ts", title: "меню меняет тот же плоский порядок, а поиск скрывает DnD", auth: true, posts: 1, actions: ["moveListInGroup"] },
  { id: "search", file: "e2e/search.e2e.ts", title: "поиск находит по названию записи и подсвечивает совпадение", auth: true, posts: 0 },
  { id: "order", file: "e2e/ordering.e2e.ts", title: "пункты меню двигают запись вверх и вниз", auth: true, posts: 1, actions: ["moveItem"] },
  { id: "share", file: "e2e/sharing.e2e.ts", title: "получатель видит список и может менять содержимое, но не владеть им", auth: true, posts: 1, secondContext: true, actions: ["shareList"] },
  { id: "revoke", file: "e2e/sharing.e2e.ts", title: "владелец отзывает доступ", auth: true, posts: 1, secondContext: true, actions: ["removeSharedUser"] },
] as const;

export function scenarioFor(file: string, title: string) {
  const normalized = file.replaceAll("\\", "/");
  return scenarios.find((scenario) => normalized.endsWith(`/test/${scenario.file}`) && scenario.title === title);
}
