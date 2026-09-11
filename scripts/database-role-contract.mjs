export const DATABASE_ROLES = {
  owner: "smartlists_owner",
  migrator: "smartlists_migrator",
  runtime: "smartlists_runtime",
  backup: "smartlists_backup",
};

export const EXPECTED_TABLES = [
  "Account",
  "AllowedEmail",
  "AppSetting",
  "Attachment",
  "AuditEvent",
  "Item",
  "List",
  "ListGroup",
  "ListShare",
  "Session",
  "Space",
  "User",
  "UserDailyUsage",
  "VerificationToken",
  "_ListGroupMembers",
  "_prisma_migrations",
];

export const EXPECTED_ENUM_TYPES = [
  "AttachmentStatus",
  "AuditEventAction",
  "AuditEventSource",
  "FileCategory",
  "ListShareRole",
];

// Новая sequence, view, routine или domain требует явного решения об ownership
// и правах. Пустые списки являются частью fail-closed inventory, а не пропуском.
export const EXPECTED_SEQUENCES = [];
export const EXPECTED_VIEWS = [];
// Формат routines: `function:name(identity arguments)` или
// `procedure:name(identity arguments)`, чтобы ALTER-команда не угадывала тип.
export const EXPECTED_ROUTINE_DEFINITIONS = [
  {
    kind: "function",
    name: "app_attachment_finish_maintenance",
    identityArguments: "uuid[], boolean",
  },
  {
    kind: "function",
    name: "app_attachment_prepare_maintenance",
    identityArguments: "text",
  },
  {
    kind: "function",
    name: "app_audit_global_admin_change",
    identityArguments: "",
  },
  {
    kind: "function",
    name: "app_enforce_tenant_update_columns",
    identityArguments: "",
  },
  {
    kind: "function",
    name: "app_list_access",
    identityArguments: "text",
  },
  {
    kind: "function",
    name: "app_prune_audit_events",
    identityArguments: "",
  },
  {
    kind: "function",
    name: "app_write_audit_event",
    identityArguments: '"AuditEventAction", text, text, text, text',
  },
];
export const RUNTIME_EXECUTE_ROUTINES = EXPECTED_ROUTINE_DEFINITIONS.filter(
  (routine) =>
    ![
      "app_audit_global_admin_change",
      "app_enforce_tenant_update_columns",
      "app_prune_audit_events",
    ].includes(routine.name),
);
export const EXPECTED_ROUTINES = EXPECTED_ROUTINE_DEFINITIONS.map(
  (routine) =>
    `${routine.kind}:${routine.name}(${routine.identityArguments})`,
);
export const EXPECTED_DOMAINS = [];

// Policies адресованы PUBLIC, потому что operational login-роли не создаются
// миграциями. Без table GRANT они не дают доступа, а только сужают его.
export const EXPECTED_POLICIES = [
  "Attachment:app_attachment_delete:DELETE:PERMISSIVE:public",
  "Attachment:app_attachment_insert:INSERT:PERMISSIVE:public",
  "Attachment:app_attachment_select:SELECT:PERMISSIVE:public",
  "Attachment:app_attachment_update:UPDATE:PERMISSIVE:public",
  "Item:app_item_delete:DELETE:PERMISSIVE:public",
  "Item:app_item_insert:INSERT:PERMISSIVE:public",
  "Item:app_item_select:SELECT:PERMISSIVE:public",
  "Item:app_item_update:UPDATE:PERMISSIVE:public",
  "List:app_list_delete:DELETE:PERMISSIVE:public",
  "List:app_list_insert:INSERT:PERMISSIVE:public",
  "List:app_list_select:SELECT:PERMISSIVE:public",
  "List:app_list_update:UPDATE:PERMISSIVE:public",
  "ListGroup:app_list_group_delete:DELETE:PERMISSIVE:public",
  "ListGroup:app_list_group_insert:INSERT:PERMISSIVE:public",
  "ListGroup:app_list_group_select:SELECT:PERMISSIVE:public",
  "ListGroup:app_list_group_update:UPDATE:PERMISSIVE:public",
  "ListShare:app_list_share_delete:DELETE:PERMISSIVE:public",
  "ListShare:app_list_share_insert:INSERT:PERMISSIVE:public",
  "ListShare:app_list_share_select:SELECT:PERMISSIVE:public",
  "Space:app_space_delete:DELETE:PERMISSIVE:public",
  "Space:app_space_insert:INSERT:PERMISSIVE:public",
  "Space:app_space_select:SELECT:PERMISSIVE:public",
  "Space:app_space_update:UPDATE:PERMISSIVE:public",
  "UserDailyUsage:app_user_daily_usage_delete:DELETE:PERMISSIVE:public",
  "UserDailyUsage:app_user_daily_usage_insert:INSERT:PERMISSIVE:public",
  "UserDailyUsage:app_user_daily_usage_select:SELECT:PERMISSIVE:public",
  "UserDailyUsage:app_user_daily_usage_update:UPDATE:PERMISSIVE:public",
  "_ListGroupMembers:app_list_group_membership_delete:DELETE:PERMISSIVE:public",
  "_ListGroupMembers:app_list_group_membership_insert:INSERT:PERMISSIVE:public",
  "_ListGroupMembers:app_list_group_membership_select:SELECT:PERMISSIVE:public",
  "_ListGroupMembers:app_list_group_membership_update:UPDATE:PERMISSIVE:public",
];

// Состояние в конце строки: O — enabled, D — disabled. Для аудит-триггеров это
// требование, для guard-ов арендной изоляции — лишь состояние в профиле
// `disabled`: они включаются по одному отдельным gate, и их фактическое
// состояние сверяется с профилем rollout (см. assertTriggerInventory), а не с
// этим списком. Тождество триггеров при этом сверяется строго по нему.
export const EXPECTED_TRIGGERS = [
  "AllowedEmail:app_audit_global_admin_change:app_audit_global_admin_change:O",
  "AppSetting:app_audit_global_admin_change:app_audit_global_admin_change:O",
  "Attachment:app_tenant_update_columns_guard:app_enforce_tenant_update_columns:D",
  "Item:app_tenant_update_columns_guard:app_enforce_tenant_update_columns:D",
  "List:app_tenant_update_columns_guard:app_enforce_tenant_update_columns:D",
  "ListGroup:app_tenant_update_columns_guard:app_enforce_tenant_update_columns:D",
  "ListShare:app_tenant_update_columns_guard:app_enforce_tenant_update_columns:D",
  "Space:app_tenant_update_columns_guard:app_enforce_tenant_update_columns:D",
  "UserDailyUsage:app_tenant_update_columns_guard:app_enforce_tenant_update_columns:D",
  "_ListGroupMembers:app_tenant_update_columns_guard:app_enforce_tenant_update_columns:D",
];

export const GUARD_NAME = "app_tenant_update_columns_guard";

export const TENANT_TABLES = [
  "Space",
  "List",
  "ListShare",
  "ListGroup",
  "_ListGroupMembers",
  "Item",
  "Attachment",
  "UserDailyUsage",
];

// Ступени rollout арендной изоляции. RLS и guard-триггеры включаются только
// вместе и только целыми ступенями: промежуточное состояние означает, что
// переход не довели до конца, и любой configurator обязан остановиться.
export const PROFILE_TABLES = {
  disabled: [],
  "usage-canary": ["UserDailyUsage"],
  "list-item": ["UserDailyUsage", "List", "Item"],
  "space-groups": [
    "UserDailyUsage",
    "List",
    "Item",
    "Space",
    "ListGroup",
    "_ListGroupMembers",
  ],
  "tenant-full": [
    "UserDailyUsage",
    "List",
    "Item",
    "Space",
    "ListGroup",
    "_ListGroupMembers",
    "ListShare",
    "Attachment",
  ],
};

function sortedValues(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertMatchingValues(actual, expected, label) {
  const actualSorted = sortedValues(actual);
  const expectedSorted = sortedValues(expected);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(
      `${label} не совпадает. Ожидалось: ${expectedSorted.join(", ") || "∅"}; ` +
        `получено: ${actualSorted.join(", ") || "∅"}.`,
    );
  }
}

export function identifyEnforcementProfile(rlsEnabled, guardsEnabled) {
  const actualRls = sortedValues(rlsEnabled);
  const actualGuards = sortedValues(guardsEnabled);

  for (const [profile, tables] of Object.entries(PROFILE_TABLES)) {
    const expected = sortedValues(tables);
    if (
      JSON.stringify(actualRls) === JSON.stringify(expected) &&
      JSON.stringify(actualGuards) === JSON.stringify(expected)
    ) {
      return profile;
    }
  }

  throw new Error(
    "Текущее состояние RLS/guards не соответствует известному rollout-профилю: " +
      `RLS=${actualRls.join(", ") || "∅"}; ` +
      `guards=${actualGuards.join(", ") || "∅"}.`,
  );
}

// Сверяет инвентарь триггеров и возвращает профиль rollout, в котором база
// находится сейчас. Тождество триггеров и состояние аудит-триггеров жёсткие;
// состояние guard-ов свободно ровно настолько, насколько его допускает набор
// известных профилей. Прежний контракт вместо этого требовал, чтобы guard-ы
// были всегда выключены, и потому запрещал любую работу с ролями на базе,
// где арендная изоляция уже включена, — то есть на production.
export function assertTriggerInventory(triggers, rlsEnabledTables) {
  assertMatchingValues(
    triggers.map(
      (trigger) => `${trigger.table}:${trigger.name}:${trigger.function}`,
    ),
    EXPECTED_TRIGGERS.map((trigger) =>
      trigger.split(":").slice(0, 3).join(":"),
    ),
    "Триггеры",
  );
  assertMatchingValues(
    triggers
      .filter((trigger) => trigger.name !== GUARD_NAME)
      .map(
        (trigger) =>
          `${trigger.table}:${trigger.name}:${trigger.function}:${trigger.enabled}`,
      ),
    EXPECTED_TRIGGERS.filter((trigger) => !trigger.includes(`:${GUARD_NAME}:`)),
    "Состояние always-on триггеров",
  );

  const guardsEnabled = [];
  for (const trigger of triggers.filter(
    (trigger) => trigger.name === GUARD_NAME,
  )) {
    if (trigger.enabled === "D") continue;
    // Состояния R и A меняют поведение триггера при репликации и в сессиях с
    // session_replication_role, поэтому неизвестное состояние — это отказ.
    if (trigger.enabled !== "O") {
      throw new Error(
        `Неожиданное состояние guard-триггера ${trigger.table}: ${trigger.enabled}.`,
      );
    }
    guardsEnabled.push(trigger.table);
  }

  const tenantTables = new Set(TENANT_TABLES);
  const unexpectedRls = rlsEnabledTables.filter(
    (table) => !tenantTables.has(table),
  );
  if (unexpectedRls.length > 0) {
    throw new Error(
      `RLS неожиданно включён вне tenant-контура: ${unexpectedRls.join(", ")}.`,
    );
  }

  return identifyEnforcementProfile(
    rlsEnabledTables.filter((table) => tenantTables.has(table)),
    guardsEnabled,
  );
}

export const RUNTIME_TABLE_PRIVILEGES = {
  Account: ["SELECT", "INSERT"],
  AllowedEmail: ["SELECT"],
  AppSetting: ["SELECT"],
  Attachment: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  AuditEvent: [],
  Item: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  List: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  ListGroup: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  ListShare: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  Session: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  Space: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  User: ["SELECT", "INSERT", "UPDATE"],
  UserDailyUsage: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  VerificationToken: [],
  _ListGroupMembers: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  _prisma_migrations: [],
};

export const ALL_TABLE_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
];
