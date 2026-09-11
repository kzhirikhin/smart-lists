import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import pg from "pg";

import {
  ALL_TABLE_PRIVILEGES,
  DATABASE_ROLES,
  EXPECTED_POLICIES,
  EXPECTED_ROUTINES,
  EXPECTED_TABLES,
  EXPECTED_TRIGGERS,
  GUARD_NAME,
  PROFILE_TABLES,
  RUNTIME_TABLE_PRIVILEGES,
  TENANT_TABLES,
  identifyEnforcementProfile,
} from "./database-role-contract.mjs";

const { Client } = pg;

// Модель профилей живёт в общем контракте: ею пользуется и configurator ролей,
// которому запрещено менять enforcement, но нельзя и падать из-за того, что
// оно уже включено. Реэкспорт сохраняет прежний путь импорта.
export { TENANT_TABLES, identifyEnforcementProfile };

export const ENFORCEMENT_OPERATIONS = {
  "enable-usage-canary": {
    allowedProfiles: ["disabled", "usage-canary"],
    targetProfile: "usage-canary",
  },
  "rollback-usage-canary": {
    allowedProfiles: ["usage-canary", "disabled"],
    targetProfile: "disabled",
  },
  "enable-list-item": {
    allowedProfiles: ["usage-canary", "list-item"],
    targetProfile: "list-item",
  },
  "rollback-list-item": {
    allowedProfiles: ["list-item", "usage-canary"],
    targetProfile: "usage-canary",
  },
  "enable-space-groups": {
    allowedProfiles: ["list-item", "space-groups"],
    targetProfile: "space-groups",
  },
  "rollback-space-groups": {
    allowedProfiles: ["space-groups", "list-item"],
    targetProfile: "list-item",
  },
  "enable-tenant-full": {
    allowedProfiles: ["space-groups", "tenant-full"],
    targetProfile: "tenant-full",
  },
  "rollback-tenant-full": {
    allowedProfiles: ["tenant-full", "space-groups"],
    targetProfile: "space-groups",
  },
};

const USAGE_POLICY_PREDICATE =
  '("userId" = NULLIF(current_setting(\'app.user_id\'::text, true), \'\'::text))';
const LIST_ACCESS_PREDICATE = "(app_list_access(id) IS NOT NULL)";
const LIST_SELECT_PREDICATE =
  '((("ownerId" = NULLIF(current_setting(\'app.user_id\'::text, true), \'\'::text)) AND ("spaceId" = NULLIF(current_setting(\'app.space_id\'::text, true), \'\'::text))) OR (app_list_access(id) IS NOT NULL))';
const ITEM_ACCESS_PREDICATE =
  '(app_list_access("listId") IS NOT NULL)';
const SPACE_GROUP_PREDICATE =
  '(("userId" = NULLIF(current_setting(\'app.user_id\'::text, true), \'\'::text)) AND ("spaceId" = NULLIF(current_setting(\'app.space_id\'::text, true), \'\'::text)))';
const LIST_GROUP_MEMBERSHIP_ACCESS_PREDICATE =
  '((EXISTS ( SELECT 1\n' +
  '   FROM "ListGroup" list_group\n' +
  '  WHERE ((list_group.id = "_ListGroupMembers"."B") AND (list_group."userId" = NULLIF(current_setting(\'app.user_id\'::text, true), \'\'::text)) AND (list_group."spaceId" = NULLIF(current_setting(\'app.space_id\'::text, true), \'\'::text))))) AND (app_list_access("A") IS NOT NULL))';
const LIST_ID_ACCESS_PREDICATE =
  '(app_list_access("listId") IS NOT NULL)';
const LIST_SHARE_DELETE_PREDICATE =
  '((app_list_access("listId") = \'OWNER\'::text) OR (("userId" = NULLIF(current_setting(\'app.user_id\'::text, true), \'\'::text)) AND ("spaceId" = NULLIF(current_setting(\'app.space_id\'::text, true), \'\'::text))))';
const ATTACHMENT_INSERT_PREDICATE =
  '((app_list_access("listId") IS NOT NULL) AND ("uploadedById" = NULLIF(current_setting(\'app.user_id\'::text, true), \'\'::text)) AND (status = \'PENDING\'::"AttachmentStatus") AND ("cleanupToken" IS NULL) AND ("cleanupRequestedById" IS NULL) AND ("cleanupStartedAt" IS NULL))';

const POLICY_PREDICATES = {
  UserDailyUsage: {
    SELECT: { qual: USAGE_POLICY_PREDICATE, withCheck: null },
    INSERT: { qual: null, withCheck: USAGE_POLICY_PREDICATE },
    UPDATE: {
      qual: USAGE_POLICY_PREDICATE,
      withCheck: USAGE_POLICY_PREDICATE,
    },
    DELETE: { qual: USAGE_POLICY_PREDICATE, withCheck: null },
  },
  List: {
    SELECT: { qual: LIST_SELECT_PREDICATE, withCheck: null },
    INSERT: {
      qual: null,
      withCheck:
        '(("ownerId" = NULLIF(current_setting(\'app.user_id\'::text, true), \'\'::text)) AND ("spaceId" = NULLIF(current_setting(\'app.space_id\'::text, true), \'\'::text)))',
    },
    UPDATE: {
      qual: LIST_ACCESS_PREDICATE,
      withCheck: LIST_ACCESS_PREDICATE,
    },
    DELETE: {
      qual: "(app_list_access(id) = 'OWNER'::text)",
      withCheck: null,
    },
  },
  Item: {
    SELECT: { qual: ITEM_ACCESS_PREDICATE, withCheck: null },
    INSERT: {
      qual: null,
      withCheck:
        '((app_list_access("listId") IS NOT NULL) AND ("addedById" = NULLIF(current_setting(\'app.user_id\'::text, true), \'\'::text)))',
    },
    UPDATE: {
      qual: ITEM_ACCESS_PREDICATE,
      withCheck: ITEM_ACCESS_PREDICATE,
    },
    DELETE: { qual: ITEM_ACCESS_PREDICATE, withCheck: null },
  },
  Space: {
    SELECT: { qual: USAGE_POLICY_PREDICATE, withCheck: null },
    INSERT: { qual: null, withCheck: USAGE_POLICY_PREDICATE },
    UPDATE: {
      qual: USAGE_POLICY_PREDICATE,
      withCheck: USAGE_POLICY_PREDICATE,
    },
    DELETE: { qual: USAGE_POLICY_PREDICATE, withCheck: null },
  },
  ListGroup: {
    SELECT: { qual: SPACE_GROUP_PREDICATE, withCheck: null },
    INSERT: { qual: null, withCheck: SPACE_GROUP_PREDICATE },
    UPDATE: {
      qual: SPACE_GROUP_PREDICATE,
      withCheck: SPACE_GROUP_PREDICATE,
    },
    DELETE: { qual: SPACE_GROUP_PREDICATE, withCheck: null },
  },
  _ListGroupMembers: {
    SELECT: { qual: LIST_GROUP_MEMBERSHIP_ACCESS_PREDICATE, withCheck: null },
    INSERT: {
      qual: null,
      withCheck: LIST_GROUP_MEMBERSHIP_ACCESS_PREDICATE,
    },
    UPDATE: {
      qual: LIST_GROUP_MEMBERSHIP_ACCESS_PREDICATE,
      withCheck: LIST_GROUP_MEMBERSHIP_ACCESS_PREDICATE,
    },
    DELETE: { qual: LIST_GROUP_MEMBERSHIP_ACCESS_PREDICATE, withCheck: null },
  },
  ListShare: {
    SELECT: { qual: LIST_ID_ACCESS_PREDICATE, withCheck: null },
    INSERT: {
      qual: null,
      withCheck: '(app_list_access("listId") = \'OWNER\'::text)',
    },
    DELETE: { qual: LIST_SHARE_DELETE_PREDICATE, withCheck: null },
  },
  Attachment: {
    SELECT: { qual: LIST_ID_ACCESS_PREDICATE, withCheck: null },
    INSERT: { qual: null, withCheck: ATTACHMENT_INSERT_PREDICATE },
    UPDATE: {
      qual: LIST_ID_ACCESS_PREDICATE,
      withCheck: LIST_ID_ACCESS_PREDICATE,
    },
    DELETE: { qual: LIST_ID_ACCESS_PREDICATE, withCheck: null },
  },
};

// Хешируется pg_proc.prosrc, а не форматированный pg_get_functiondef: так
// контракт не зависит от косметического форматирования конкретной версии
// PostgreSQL, но отклоняет любое изменение исполняемого тела helper/guard.
const ROUTINE_CONTRACTS = {
  "app_attachment_finish_maintenance(uuid[], boolean)": {
    language: "plpgsql",
    securityDefiner: true,
    volatility: "v",
    config: ["search_path=pg_catalog"],
    result: "integer",
    sourceSha256:
      "a9ae3b45e78967ab58b384ba66826e478dadd4bbec506e10fdec66907cf20407",
    runtimeExecute: true,
    publicExecute: false,
  },
  "app_attachment_prepare_maintenance(text)": {
    language: "plpgsql",
    securityDefiner: true,
    volatility: "v",
    config: ["search_path=pg_catalog"],
    result: 'TABLE("cleanupPayload" jsonb, "userCount" bigint)',
    sourceSha256:
      "ae801e45935fb2cd4edbec4c1bad0acdbe65789d272aa92c98b5815f7a290a6a",
    runtimeExecute: true,
    publicExecute: false,
  },
  "app_enforce_tenant_update_columns()": {
    language: "plpgsql",
    securityDefiner: false,
    volatility: "v",
    config: ["search_path=pg_catalog"],
    result: "trigger",
    sourceSha256:
      "a21b076c0e869d5b2c88db06bb62f195871da0bdba52972b2248dfd528cd2f50",
    runtimeExecute: false,
    publicExecute: false,
  },
  "app_list_access(text)": {
    language: "sql",
    securityDefiner: true,
    volatility: "s",
    config: ["search_path=pg_catalog"],
    result: "text",
    sourceSha256:
      "58881094ae21d97efbfcec950ee2b0a6461a25764f35c7bc2b3a940b25e2723f",
    runtimeExecute: true,
    publicExecute: false,
  },
};

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertSameValues(actual, expected, label) {
  const actualSorted = sorted(actual);
  const expectedSorted = sorted(expected);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(
      `${label} не совпадает. Ожидалось: ${expectedSorted.join(", ") || "∅"}; ` +
        `получено: ${actualSorted.join(", ") || "∅"}.`,
    );
  }
}

function fingerprint(hostname) {
  return createHash("sha256").update(hostname).digest("hex").slice(0, 12);
}

export function parseEnforcementArguments(args) {
  const allowedFlags = new Set(["--apply"]);
  const operationArguments = args.filter((argument) =>
    argument.startsWith("--operation="),
  );
  const unexpected = args.filter(
    (argument) =>
      !allowedFlags.has(argument) && !argument.startsWith("--operation="),
  );

  if (unexpected.length > 0) {
    throw new Error(`Неизвестные аргументы: ${unexpected.join(", ")}.`);
  }
  if (operationArguments.length !== 1) {
    throw new Error("Требуется ровно один аргумент --operation=<operation>.");
  }

  const operation = operationArguments[0].slice("--operation=".length);
  if (!Object.hasOwn(ENFORCEMENT_OPERATIONS, operation)) {
    throw new Error(`Неизвестная enforcement operation: ${operation}.`);
  }

  return { apply: args.includes("--apply"), operation };
}

export function resolveEnforcementTransition(operation, currentProfile) {
  const contract = ENFORCEMENT_OPERATIONS[operation];
  if (!contract) {
    throw new Error(`Неизвестная enforcement operation: ${operation}.`);
  }
  if (!contract.allowedProfiles.includes(currentProfile)) {
    throw new Error(
      `Операция ${operation} запрещена из профиля ${currentProfile}.`,
    );
  }
  return {
    targetProfile: contract.targetProfile,
    changed: currentProfile !== contract.targetProfile,
    tables: [...PROFILE_TABLES[contract.targetProfile]],
  };
}

function assertInputs(connectionString, expectedHost) {
  if (!connectionString) throw new Error("DIRECT_URL is required.");
  if (!expectedHost) throw new Error("EXPECTED_DATABASE_HOST is required.");

  const url = new URL(connectionString);
  const actualHost = url.hostname.toLowerCase();
  const normalizedExpected = expectedHost.trim().toLowerCase();
  if (actualHost !== normalizedExpected) {
    throw new Error("DIRECT_URL host does not match EXPECTED_DATABASE_HOST.");
  }
  if (actualHost.includes("-pooler")) {
    throw new Error("DIRECT_URL must use a direct endpoint, not a pooler.");
  }
  return url;
}

async function queryCatalog(client) {
  const connection = await client.query(`
    SELECT current_user AS current_user, session_user AS session_user
  `);
  const runtimeRole = await client.query(
    `SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
            rolreplication, rolbypassrls, rolconfig
     FROM pg_roles
     WHERE rolname = $1`,
    [DATABASE_ROLES.runtime],
  );
  const runtimeMemberships = await client.query(
    `SELECT parent.rolname AS granted_role
     FROM pg_auth_members membership
     JOIN pg_roles member ON member.oid = membership.member
     JOIN pg_roles parent ON parent.oid = membership.roleid
     WHERE member.rolname = $1
     ORDER BY parent.rolname`,
    [DATABASE_ROLES.runtime],
  );
  const runtimeBoundary = await client.query(
    `SELECT
       has_database_privilege($1, current_database(), 'CONNECT') AS connect,
       has_database_privilege($1, current_database(), 'CREATE') AS database_create,
       has_schema_privilege($1, 'public', 'USAGE') AS schema_usage,
       has_schema_privilege($1, 'public', 'CREATE') AS schema_create`,
    [DATABASE_ROLES.runtime],
  );
  const relations = await client.query(`
    SELECT relation.relname AS name,
           pg_get_userbyid(relation.relowner) AS owner,
           relation.relrowsecurity AS rls_enabled,
           relation.relforcerowsecurity AS rls_forced
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
    ORDER BY relation.relname
  `);
  const runtimePrivileges = await client.query(
    `SELECT relation.relname AS name,
            ARRAY(
              SELECT privilege
              FROM unnest($2::text[]) AS privilege
              WHERE has_table_privilege($1, relation.oid, privilege)
              ORDER BY privilege
            ) AS privileges
     FROM pg_class relation
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p')
     ORDER BY relation.relname`,
    [DATABASE_ROLES.runtime, ALL_TABLE_PRIVILEGES],
  );
  const routines = await client.query(
    `
    SELECT CASE routine.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
           routine.proname AS name,
           pg_get_function_identity_arguments(routine.oid) AS arguments,
           pg_get_userbyid(routine.proowner) AS owner,
           language.lanname AS language,
           routine.prosecdef AS security_definer,
           routine.provolatile AS volatility,
           routine.proconfig AS config,
           pg_get_function_result(routine.oid) AS result,
           routine.prosrc AS source,
           has_function_privilege($1, routine.oid, 'EXECUTE') AS runtime_execute,
           COALESCE((
             SELECT bool_or(acl.grantee = 0 AND acl.privilege_type = 'EXECUTE')
             FROM aclexplode(
               COALESCE(routine.proacl, acldefault('f', routine.proowner))
             ) AS acl
           ), false) AS public_execute
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    JOIN pg_language language ON language.oid = routine.prolang
    WHERE namespace.nspname = 'public'
    ORDER BY name, arguments
  `,
    [DATABASE_ROLES.runtime],
  );
  const policies = await client.query(`
    SELECT format(
             '%s:%s:%s:%s:%s',
             tablename, policyname, cmd, permissive, array_to_string(roles, ',')
           ) AS signature,
           tablename,
           policyname,
           cmd,
           qual,
           with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  `);
  const triggers = await client.query(`
    SELECT relation.relname AS table_name,
           trigger.tgname AS name,
           routine.proname AS function_name,
           trigger.tgenabled AS enabled
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_proc routine ON routine.oid = trigger.tgfoid
    WHERE namespace.nspname = 'public'
      AND NOT trigger.tgisinternal
    ORDER BY relation.relname, trigger.tgname
  `);

  return {
    connection: connection.rows[0],
    runtimeRole: runtimeRole.rows[0],
    runtimeMemberships: runtimeMemberships.rows,
    runtimeBoundary: runtimeBoundary.rows[0],
    relations: relations.rows,
    runtimePrivileges: runtimePrivileges.rows,
    routines: routines.rows,
    policies: policies.rows,
    triggers: triggers.rows,
  };
}

function assertPolicyPredicates(policies) {
  for (const [table, commands] of Object.entries(POLICY_PREDICATES)) {
    const tablePolicies = policies.filter(
      (policy) => policy.tablename === table,
    );
    const byCommand = Object.fromEntries(
      tablePolicies.map((policy) => [policy.cmd, policy]),
    );

    for (const [command, expected] of Object.entries(commands)) {
      const actual = byCommand[command];
      if (
        actual?.qual !== expected.qual ||
        actual?.with_check !== expected.withCheck
      ) {
        throw new Error(`${table} ${command} policy predicate не совпадает.`);
      }
    }
  }
}

function assertRoutineContracts(routines) {
  const bySignature = Object.fromEntries(
    routines.map((routine) => [
      `${routine.name}(${routine.arguments})`,
      routine,
    ]),
  );

  for (const [signature, expected] of Object.entries(ROUTINE_CONTRACTS)) {
    const actual = bySignature[signature];
    const sourceSha256 = actual?.source
      ? createHash("sha256").update(actual.source).digest("hex")
      : null;
    if (
      actual?.language !== expected.language ||
      actual?.security_definer !== expected.securityDefiner ||
      actual?.volatility !== expected.volatility ||
      JSON.stringify(actual?.config ?? []) !== JSON.stringify(expected.config) ||
      actual?.result !== expected.result ||
      sourceSha256 !== expected.sourceSha256 ||
      actual?.runtime_execute !== expected.runtimeExecute ||
      actual?.public_execute !== expected.publicExecute
    ) {
      throw new Error(`Routine ${signature} не соответствует enforcement contract.`);
    }
  }
}

function assertCatalog(catalog) {
  if (
    catalog.connection?.session_user !== DATABASE_ROLES.migrator ||
    catalog.connection?.current_user !== DATABASE_ROLES.owner
  ) {
    throw new Error(
      "Enforcement requires smartlists_migrator with current role smartlists_owner.",
    );
  }

  const role = catalog.runtimeRole;
  if (
    !role?.rolcanlogin ||
    role.rolsuper ||
    role.rolinherit ||
    role.rolcreaterole ||
    role.rolcreatedb ||
    role.rolreplication ||
    role.rolbypassrls ||
    role.rolconfig !== null
  ) {
    throw new Error("Runtime role attributes do not match the restricted contract.");
  }
  if (catalog.runtimeMemberships.length !== 0) {
    throw new Error("Runtime role unexpectedly inherits another role.");
  }
  const boundary = catalog.runtimeBoundary;
  if (
    !boundary?.connect ||
    boundary.database_create ||
    !boundary.schema_usage ||
    boundary.schema_create
  ) {
    throw new Error("Runtime database/schema boundary does not match the contract.");
  }

  assertSameValues(
    catalog.relations.map((relation) => relation.name),
    EXPECTED_TABLES,
    "Таблицы public",
  );
  if (
    catalog.relations.some(
      (relation) =>
        relation.owner !== DATABASE_ROLES.owner || relation.rls_forced,
    )
  ) {
    throw new Error("Table ownership либо FORCE RLS не совпадает с контрактом.");
  }

  const actualPrivileges = Object.fromEntries(
    catalog.runtimePrivileges.map((relation) => [
      relation.name,
      sorted(relation.privileges),
    ]),
  );
  const expectedPrivileges = Object.fromEntries(
    Object.entries(RUNTIME_TABLE_PRIVILEGES).map(([table, privileges]) => [
      table,
      sorted(privileges),
    ]),
  );
  if (JSON.stringify(actualPrivileges) !== JSON.stringify(expectedPrivileges)) {
    throw new Error("Runtime table privileges do not match the contract.");
  }

  assertSameValues(
    catalog.routines.map(
      (routine) => `${routine.kind}:${routine.name}(${routine.arguments})`,
    ),
    EXPECTED_ROUTINES,
    "Routines public",
  );
  if (catalog.routines.some((routine) => routine.owner !== DATABASE_ROLES.owner)) {
    throw new Error("Routine ownership does not match the contract.");
  }
  assertRoutineContracts(catalog.routines);
  assertSameValues(
    catalog.policies.map((policy) => policy.signature),
    EXPECTED_POLICIES,
    "Policies public",
  );
  assertPolicyPredicates(catalog.policies);

  const expectedTriggerDefinitions = EXPECTED_TRIGGERS.map((trigger) =>
    trigger.split(":").slice(0, 3).join(":"),
  );
  assertSameValues(
    catalog.triggers.map(
      (trigger) =>
        `${trigger.table_name}:${trigger.name}:${trigger.function_name}`,
    ),
    expectedTriggerDefinitions,
    "Triggers public",
  );
  assertSameValues(
    catalog.triggers
      .filter((trigger) => trigger.name !== GUARD_NAME)
      .map(
        (trigger) =>
          `${trigger.table_name}:${trigger.name}:${trigger.function_name}:${trigger.enabled}`,
      ),
    EXPECTED_TRIGGERS.filter(
      (trigger) => !trigger.includes(`:${GUARD_NAME}:`),
    ),
    "Always-on triggers public",
  );
}

function profileFromCatalog(catalog) {
  const tenantSet = new Set(TENANT_TABLES);
  const unexpectedRls = catalog.relations
    .filter((relation) => relation.rls_enabled && !tenantSet.has(relation.name))
    .map((relation) => relation.name);
  if (unexpectedRls.length > 0) {
    throw new Error(
      `RLS неожиданно включён вне tenant-контура: ${unexpectedRls.join(", ")}.`,
    );
  }

  const rlsEnabled = catalog.relations
    .filter((relation) => tenantSet.has(relation.name) && relation.rls_enabled)
    .map((relation) => relation.name);
  const guardsEnabled = catalog.triggers
    .filter(
      (trigger) =>
        trigger.name === GUARD_NAME && trigger.enabled !== "D",
    )
    .map((trigger) => {
      if (trigger.enabled !== "O" || trigger.name !== GUARD_NAME) {
        throw new Error(
          `Неожиданное состояние trigger ${trigger.table_name}:${trigger.enabled}.`,
        );
      }
      return trigger.table_name;
    });

  return identifyEnforcementProfile(rlsEnabled, guardsEnabled);
}

async function setProfile(client, currentProfile, targetProfile) {
  const currentTables = new Set(PROFILE_TABLES[currentProfile]);
  const targetTables = new Set(PROFILE_TABLES[targetProfile]);
  for (const table of TENANT_TABLES) {
    if (currentTables.has(table) === targetTables.has(table)) continue;

    const identifier = client.escapeIdentifier(table);
    const guardIdentifier = client.escapeIdentifier(GUARD_NAME);
    const action = targetTables.has(table) ? "ENABLE" : "DISABLE";
    await client.query(`ALTER TABLE public.${identifier} ${action} ROW LEVEL SECURITY`);
    await client.query(
      `ALTER TABLE public.${identifier} ${action} TRIGGER ${guardIdentifier}`,
    );
  }
}

export async function configureTenantEnforcement({
  args = process.argv.slice(2),
  connectionString = process.env.DIRECT_URL,
  expectedHost = process.env.EXPECTED_DATABASE_HOST,
} = {}) {
  const { apply, operation } = parseEnforcementArguments(args);
  const url = assertInputs(connectionString, expectedHost);
  const client = new Client({ connectionString });
  await client.connect();

  let transactionOpen = false;
  try {
    await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
    transactionOpen = true;
    if (apply) {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('smartlists_tenant_enforcement', 0))",
      );
    }

    const beforeCatalog = await queryCatalog(client);
    assertCatalog(beforeCatalog);
    const beforeProfile = profileFromCatalog(beforeCatalog);
    const transition = resolveEnforcementTransition(operation, beforeProfile);

    if (apply && transition.changed) {
      await setProfile(client, beforeProfile, transition.targetProfile);
      const changedCatalog = await queryCatalog(client);
      assertCatalog(changedCatalog);
      const changedProfile = profileFromCatalog(changedCatalog);
      if (changedProfile !== transition.targetProfile) {
        throw new Error("Post-change enforcement profile does not match target.");
      }
      await client.query("COMMIT");
      transactionOpen = false;
    } else {
      await client.query("ROLLBACK");
      transactionOpen = false;
    }

    const afterCatalog = await queryCatalog(client);
    assertCatalog(afterCatalog);
    const afterProfile = profileFromCatalog(afterCatalog);
    const expectedAfter = apply ? transition.targetProfile : beforeProfile;
    if (afterProfile !== expectedAfter) {
      throw new Error("Committed enforcement profile does not match expectation.");
    }

    const result = {
      mode: apply ? "apply" : "plan",
      operation,
      endpointFingerprint: fingerprint(url.hostname),
      beforeProfile,
      targetProfile: transition.targetProfile,
      afterProfile,
      changed: apply && transition.changed,
      rlsEnabled: [...PROFILE_TABLES[afterProfile]],
      guardsEnabled: [...PROFILE_TABLES[afterProfile]],
      forcedRls: [],
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedUrl === import.meta.url) {
  configureTenantEnforcement().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
