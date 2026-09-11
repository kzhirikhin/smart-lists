import { createHash } from "node:crypto";

import pg from "pg";

import {
  ALL_TABLE_PRIVILEGES,
  DATABASE_ROLES,
  EXPECTED_DOMAINS,
  EXPECTED_ENUM_TYPES,
  EXPECTED_POLICIES,
  EXPECTED_ROUTINE_DEFINITIONS,
  EXPECTED_ROUTINES,
  EXPECTED_SEQUENCES,
  EXPECTED_TABLES,
  EXPECTED_VIEWS,
  RUNTIME_EXECUTE_ROUTINES,
  RUNTIME_TABLE_PRIVILEGES,
  assertTriggerInventory,
} from "./database-role-contract.mjs";

const { Client } = pg;
const VALID_SCOPES = new Set(["migration", "backup", "all"]);
const apply = process.argv.includes("--apply");
const rotateMigratorPassword = process.argv.includes(
  "--rotate-migrator-password",
);
const rotateBackupPassword = process.argv.includes("--rotate-backup-password");
const scopeArgument = process.argv.find((argument) =>
  argument.startsWith("--scope="),
);
const scope = scopeArgument?.slice("--scope=".length) ?? "all";

const adminConnectionString = process.env.DIRECT_URL;
const expectedHost = process.env.EXPECTED_DATABASE_HOST;
const migratorPassword = process.env.MIGRATOR_ROLE_PASSWORD;
const backupPassword = process.env.BACKUP_ROLE_PASSWORD;

function fingerprint(hostname) {
  return createHash("sha256").update(hostname).digest("hex").slice(0, 12);
}

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

function assertPassword(password, label) {
  if (!password || password.length < 32) {
    throw new Error(`${label} должен содержать не менее 32 символов.`);
  }
}

function assertInputs() {
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`Неизвестный scope: ${scope}.`);
  }
  if (!adminConnectionString) {
    throw new Error("DIRECT_URL is required.");
  }
  if (!expectedHost) {
    throw new Error("EXPECTED_DATABASE_HOST is required.");
  }

  const adminUrl = new URL(adminConnectionString);
  if (adminUrl.hostname !== expectedHost) {
    throw new Error("DIRECT_URL host does not match EXPECTED_DATABASE_HOST.");
  }
  if (adminUrl.hostname.includes("-pooler.")) {
    throw new Error("DIRECT_URL must use a direct endpoint, not a pooler.");
  }
  if (apply && (scope === "migration" || scope === "all")) {
    assertPassword(migratorPassword, "MIGRATOR_ROLE_PASSWORD");
  }
  if (apply && (scope === "backup" || scope === "all")) {
    assertPassword(backupPassword, "BACKUP_ROLE_PASSWORD");
  }
  return adminUrl;
}

async function role(client, name) {
  const result = await client.query(
    `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
            rolcanlogin, rolreplication, rolbypassrls, rolconfig
     FROM pg_roles
     WHERE rolname = $1`,
    [name],
  );
  return result.rows[0];
}

async function membershipsAsMember(client, name) {
  const result = await client.query(
    `SELECT parent.rolname AS granted_role,
            grantor.rolname AS grantor,
            membership.admin_option,
            membership.inherit_option,
            membership.set_option
     FROM pg_auth_members membership
     JOIN pg_roles parent ON parent.oid = membership.roleid
     JOIN pg_roles member ON member.oid = membership.member
     JOIN pg_roles grantor ON grantor.oid = membership.grantor
     WHERE member.rolname = $1
     ORDER BY granted_role, grantor, admin_option, inherit_option, set_option`,
    [name],
  );
  return result.rows;
}

async function membersOfRole(client, name) {
  const result = await client.query(
    `SELECT member.rolname AS member
     FROM pg_auth_members membership
     JOIN pg_roles parent ON parent.oid = membership.roleid
     JOIN pg_roles member ON member.oid = membership.member
     WHERE parent.rolname = $1
     ORDER BY member`,
    [name],
  );
  return result.rows.map((row) => row.member);
}

async function databaseRoleSettings(client, name) {
  const result = await client.query(
    `SELECT database.datname AS database,
            setting
     FROM pg_db_role_setting role_setting
     JOIN pg_roles role ON role.oid = role_setting.setrole
     LEFT JOIN pg_database database ON database.oid = role_setting.setdatabase
     CROSS JOIN unnest(role_setting.setconfig) AS setting
     WHERE role.rolname = $1
     ORDER BY database, setting`,
    [name],
  );
  return result.rows.map(
    (row) => `${row.database ?? "*"}:${row.setting}`,
  );
}

async function membershipsToRole(client, member, parent) {
  const memberships = await membershipsAsMember(client, member);
  return memberships.filter(
    (membership) => membership.granted_role === parent,
  );
}

function assertSafeRoleAttributes(actual, expected, label) {
  if (!actual) throw new Error(`${label} не существует.`);
  for (const [attribute, value] of Object.entries(expected)) {
    if (actual[attribute] !== value) {
      throw new Error(`${label}: неожиданный атрибут ${attribute}.`);
    }
  }
}

async function inventory(client) {
  const relations = await client.query(`
    SELECT relation.relname AS name,
           relation.relkind AS kind,
           pg_get_userbyid(relation.relowner) AS owner
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'S', 'v', 'm')
    ORDER BY kind, name
  `);
  const types = await client.query(`
    SELECT type.typname AS name,
           type.typtype AS kind,
           pg_get_userbyid(type.typowner) AS owner
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'public'
      AND type.typtype IN ('e', 'd')
    ORDER BY kind, name
  `);
  const routines = await client.query(`
    SELECT routine.proname AS name,
           CASE routine.prokind
             WHEN 'p' THEN 'procedure'
             ELSE 'function'
           END AS kind,
           pg_get_function_identity_arguments(routine.oid) AS arguments,
           pg_get_userbyid(routine.proowner) AS owner
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
    ORDER BY name, arguments
  `);
  return {
    tables: relations.rows.filter((row) => ["r", "p"].includes(row.kind)),
    sequences: relations.rows.filter((row) => row.kind === "S"),
    views: relations.rows.filter((row) => ["v", "m"].includes(row.kind)),
    enums: types.rows.filter((row) => row.kind === "e"),
    domains: types.rows.filter((row) => row.kind === "d"),
    routines: routines.rows,
  };
}

async function securityInventory(client) {
  const policies = await client.query(`
    SELECT format(
             '%s:%s:%s:%s:%s',
             tablename,
             policyname,
             cmd,
             permissive,
             array_to_string(roles, ',')
           ) AS policy
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  `);
  const triggers = await client.query(`
    SELECT relation.relname AS "table",
           trigger.tgname AS name,
           routine.proname AS "function",
           trigger.tgenabled AS enabled
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_proc routine ON routine.oid = trigger.tgfoid
    WHERE namespace.nspname = 'public'
      AND NOT trigger.tgisinternal
    ORDER BY relation.relname, trigger.tgname
  `);
  const relations = await client.query(`
    SELECT relation.relname AS name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind = 'r'
      AND relation.relrowsecurity
    ORDER BY relation.relname
  `);
  return {
    policies: policies.rows.map((row) => row.policy),
    triggers: triggers.rows,
    rlsEnabled: relations.rows.map((row) => row.name),
  };
}

// Возвращает профиль арендной изоляции. Менять его этот скрипт не вправе —
// это отдельный gate, — но и падать из-за того, что он уже включён, не должен:
// именно так ротация паролей операционных ролей оказалась неисполнимой на
// production, где enforcement включён с самого rollout.
async function assertSecurityInventory(client) {
  const actual = await securityInventory(client);
  assertSameValues(actual.policies, EXPECTED_POLICIES, "Policies");
  return assertTriggerInventory(actual.triggers, actual.rlsEnabled);
}

function assertInventory(actual) {
  assertSameValues(actual.tables.map((row) => row.name), EXPECTED_TABLES, "Таблицы");
  assertSameValues(
    actual.sequences.map((row) => row.name),
    EXPECTED_SEQUENCES,
    "Sequences",
  );
  assertSameValues(actual.views.map((row) => row.name), EXPECTED_VIEWS, "Views");
  assertSameValues(
    actual.enums.map((row) => row.name),
    EXPECTED_ENUM_TYPES,
    "Enum-типы",
  );
  assertSameValues(actual.domains.map((row) => row.name), EXPECTED_DOMAINS, "Domains");
  assertSameValues(
    actual.routines.map(
      (row) => `${row.kind}:${row.name}(${row.arguments})`,
    ),
    EXPECTED_ROUTINES,
    "Routines",
  );
}

async function runtimeSnapshot(client) {
  const runtime = await role(client, DATABASE_ROLES.runtime);
  assertSafeRoleAttributes(runtime, {
    rolsuper: false,
    rolinherit: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolcanlogin: true,
    rolreplication: false,
    rolbypassrls: false,
  }, "Runtime role");
  assertSameValues(
    (await membershipsAsMember(client, DATABASE_ROLES.runtime)).map(
      (membership) => membership.granted_role,
    ),
    [],
    "Runtime memberships",
  );

  const boundary = await client.query(
    `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS database_connect,
            has_database_privilege($1, current_database(), 'CREATE') AS database_create,
            has_schema_privilege($1, 'public', 'USAGE') AS schema_usage,
            has_schema_privilege($1, 'public', 'CREATE') AS schema_create`,
    [DATABASE_ROLES.runtime],
  );
  if (
    !boundary.rows[0].database_connect ||
    boundary.rows[0].database_create ||
    !boundary.rows[0].schema_usage ||
    boundary.rows[0].schema_create
  ) {
    throw new Error("Runtime database/schema boundary does not match the contract.");
  }
  const tables = {};
  for (const table of EXPECTED_TABLES) {
    const result = await client.query(
      `SELECT privilege
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       CROSS JOIN unnest($2::text[]) AS privilege
       WHERE namespace.nspname = 'public'
         AND relation.relname = $1
         AND has_table_privilege($3, relation.oid, privilege)`,
      [table, ALL_TABLE_PRIVILEGES, DATABASE_ROLES.runtime],
    );
    tables[table] = sorted(result.rows.map((row) => row.privilege));
    assertSameValues(
      tables[table],
      RUNTIME_TABLE_PRIVILEGES[table],
      `Runtime privileges on ${table}`,
    );
  }
  const routines = {};
  for (const routine of EXPECTED_ROUTINE_DEFINITIONS) {
    const signature =
      `public.${routine.name}(${routine.identityArguments})`;
    const result = await client.query(
      `SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS execute`,
      [DATABASE_ROLES.runtime, signature],
    );
    routines[signature] = result.rows[0]?.execute === true;
    const expectedExecute = RUNTIME_EXECUTE_ROUTINES.some(
      (allowed) =>
        allowed.kind === routine.kind &&
        allowed.name === routine.name &&
        allowed.identityArguments === routine.identityArguments,
    );
    if (routines[signature] !== expectedExecute) {
      throw new Error(`Runtime EXECUTE на ${signature} не совпадает с контрактом.`);
    }
  }
  return { boundary: boundary.rows[0], tables, routines };
}

function assertRuntimeUnchanged(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Runtime boundary or ACL changed during operational role cutover.");
  }
}

async function assertExistingRolesAreSafe(client, database, adminRole) {
  const owner = await role(client, DATABASE_ROLES.owner);
  const migrator = await role(client, DATABASE_ROLES.migrator);
  const backup = await role(client, DATABASE_ROLES.backup);
  if (owner) {
    assertSafeRoleAttributes(owner, {
      rolsuper: false,
      rolinherit: true,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: false,
      rolreplication: false,
      rolbypassrls: false,
    }, "Existing owner role");
    assertSameValues(
      (await membershipsAsMember(client, DATABASE_ROLES.owner)).map(
        (membership) => membership.granted_role,
      ),
      [],
      "Owner memberships",
    );
    assertSameValues(owner.rolconfig ?? [], [], "Owner global settings");
    assertSameValues(
      await databaseRoleSettings(client, DATABASE_ROLES.owner),
      [],
      "Owner database settings",
    );
    assertSameValues(
      [...new Set(await membersOfRole(client, DATABASE_ROLES.owner))],
      [adminRole, ...(migrator ? [DATABASE_ROLES.migrator] : [])],
      "Owner members",
    );
    const adminMemberships = await membershipsToRole(
      client,
      adminRole,
      DATABASE_ROLES.owner,
    );
    const actualAdminMemberships = adminMemberships.map(
      (membership) =>
        `${membership.grantor}:${membership.admin_option}:` +
        `${membership.inherit_option}:${membership.set_option}`,
    );
    const directGrant =
      `${adminRole}:false:false:true`;
    const allowedProfiles = [
      [directGrant],
      [directGrant, "cloud_admin:true:false:false"],
      [directGrant, "postgres:true:false:false"],
    ].map(sorted);
    if (
      !allowedProfiles.some(
        (profile) =>
          JSON.stringify(profile) ===
          JSON.stringify(sorted(actualAdminMemberships)),
      )
    ) {
      throw new Error("Owner admin membership does not match the contract.");
    }
  }
  if (migrator) {
    assertSafeRoleAttributes(migrator, {
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: true,
      rolreplication: false,
      rolbypassrls: false,
    }, "Existing migrator role");
    const memberships = await membershipsAsMember(client, DATABASE_ROLES.migrator);
    if (
      memberships.length !== 1 ||
      memberships[0].granted_role !== DATABASE_ROLES.owner ||
      memberships[0].admin_option ||
      memberships[0].inherit_option ||
      !memberships[0].set_option
    ) {
      throw new Error("Existing migrator membership does not match the contract.");
    }
    assertSameValues(migrator.rolconfig ?? [], [], "Migrator global settings");
    assertSameValues(
      await databaseRoleSettings(client, DATABASE_ROLES.migrator),
      [`${database}:role=${DATABASE_ROLES.owner}`],
      "Migrator database settings",
    );
  }
  if (backup) {
    assertSafeRoleAttributes(backup, {
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: true,
      rolreplication: false,
      rolbypassrls: true,
    }, "Existing backup role");
    assertSameValues(
      (await membershipsAsMember(client, DATABASE_ROLES.backup)).map(
        (membership) => membership.granted_role,
      ),
      [],
      "Backup memberships",
    );
    assertSameValues(backup.rolconfig ?? [], [], "Backup global settings");
    assertSameValues(
      await databaseRoleSettings(client, DATABASE_ROLES.backup),
      [],
      "Backup database settings",
    );
  }
  return { ownerExists: Boolean(owner), migratorExists: Boolean(migrator), backupExists: Boolean(backup) };
}

async function assertOwnershipSources(client, actual, adminRole, databaseOwner) {
  const allowedOwners = new Set([adminRole, DATABASE_ROLES.owner]);
  const [schema] = (
    await client.query(
      `SELECT pg_get_userbyid(nspowner) AS owner
       FROM pg_namespace
       WHERE nspname = 'public'`,
    )
  ).rows;
  if (
    schema.owner !== adminRole &&
    schema.owner !== DATABASE_ROLES.owner &&
    !(schema.owner === "pg_database_owner" && databaseOwner === adminRole)
  ) {
    throw new Error(`Unexpected owner ${schema.owner} for schema public.`);
  }
  const objects = Object.entries(actual).flatMap(([kind, rows]) =>
      rows.map((row) => ({ kind, name: row.name, owner: row.owner })),
    );
  for (const object of objects) {
    if (!allowedOwners.has(object.owner)) {
      throw new Error(
        `Unexpected owner ${object.owner} for ${object.kind} ${object.name}.`,
      );
    }
  }
  return [
    { kind: "schema", name: "public", owner: schema.owner },
    ...objects,
  ];
}

async function createOrRotateLoginRole(
  client,
  { name, password, rotate, bypassRls, exists },
) {
  const identifier = client.escapeIdentifier(name);
  if (!exists) {
    assertPassword(password, `${name} password`);
    await client.query(
      `CREATE ROLE ${identifier} LOGIN PASSWORD ${client.escapeLiteral(password)} ` +
        `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION ` +
        (bypassRls ? "BYPASSRLS" : "NOBYPASSRLS"),
    );
  } else if (rotate) {
    assertPassword(password, `${name} password`);
    await client.query(
      `ALTER ROLE ${identifier} PASSWORD ${client.escapeLiteral(password)}`,
    );
  }
}

async function applyMigrationRoles(client, context) {
  const ownerIdentifier = client.escapeIdentifier(DATABASE_ROLES.owner);
  const migratorIdentifier = client.escapeIdentifier(DATABASE_ROLES.migrator);
  const adminIdentifier = client.escapeIdentifier(context.adminRole);
  const databaseIdentifier = client.escapeIdentifier(context.database);

  if (!context.roles.ownerExists) {
    await client.query(
      `CREATE ROLE ${ownerIdentifier} NOLOGIN NOSUPERUSER NOCREATEDB ` +
        "NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS",
    );
  }
  await client.query(
    `GRANT ${ownerIdentifier} TO ${adminIdentifier} ` +
      "WITH ADMIN FALSE, SET TRUE, INHERIT FALSE",
  );
  await createOrRotateLoginRole(client, {
    name: DATABASE_ROLES.migrator,
    password: migratorPassword,
    rotate: rotateMigratorPassword,
    bypassRls: false,
    exists: context.roles.migratorExists,
  });
  await client.query(
    `GRANT ${ownerIdentifier} TO ${migratorIdentifier} ` +
      "WITH ADMIN FALSE, SET TRUE, INHERIT FALSE",
  );
  await client.query(
    `ALTER ROLE ${migratorIdentifier} IN DATABASE ${databaseIdentifier} ` +
      `SET role TO ${ownerIdentifier}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON DATABASE ${databaseIdentifier} FROM ${migratorIdentifier}`,
  );
  await client.query(
    `GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${migratorIdentifier}`,
  );

  const transfer = async (owner, sql) => {
    if (owner === context.adminRole) await client.query(sql);
  };
  const schemaOwner = context.ownership.find(
    (object) => object.kind === "schema" && object.name === "public",
  ).owner;
  if (
    schemaOwner === context.adminRole ||
    (schemaOwner === "pg_database_owner" &&
      context.databaseOwner === context.adminRole)
  ) {
    await client.query(`ALTER SCHEMA public OWNER TO ${ownerIdentifier}`);
  }
  for (const row of context.inventory.tables) {
    await transfer(
      row.owner,
      `ALTER TABLE public.${client.escapeIdentifier(row.name)} OWNER TO ${ownerIdentifier}`,
    );
  }
  for (const row of context.inventory.sequences) {
    await transfer(
      row.owner,
      `ALTER SEQUENCE public.${client.escapeIdentifier(row.name)} OWNER TO ${ownerIdentifier}`,
    );
  }
  for (const row of context.inventory.views) {
    const command = row.kind === "m" ? "ALTER MATERIALIZED VIEW" : "ALTER VIEW";
    await transfer(
      row.owner,
      `${command} public.${client.escapeIdentifier(row.name)} OWNER TO ${ownerIdentifier}`,
    );
  }
  for (const row of [...context.inventory.enums, ...context.inventory.domains]) {
    await transfer(
      row.owner,
      `ALTER TYPE public.${client.escapeIdentifier(row.name)} OWNER TO ${ownerIdentifier}`,
    );
  }
  for (const row of context.inventory.routines) {
    const command =
      row.kind === "procedure" ? "ALTER PROCEDURE" : "ALTER FUNCTION";
    await transfer(
      row.owner,
      `${command} public.${client.escapeIdentifier(row.name)}(${row.arguments}) ` +
        `OWNER TO ${ownerIdentifier}`,
    );
  }

  await client.query(`SET LOCAL ROLE ${ownerIdentifier}`);
  await client.query(
    `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${migratorIdentifier}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${migratorIdentifier}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${migratorIdentifier}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM ${migratorIdentifier}`,
  );
  for (const objectType of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} IN SCHEMA public ` +
        `REVOKE ALL PRIVILEGES ON ${objectType} FROM ${client.escapeIdentifier(DATABASE_ROLES.runtime)}`,
    );
  }
  // Function EXECUTE для PUBLIC является глобальным default privilege.
  // Schema-specific REVOKE не перекрывает его и создавал бы ложный контроль.
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} ` +
      "REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
  );
  await client.query("RESET ROLE");
}

async function applyBackupRole(client, context) {
  const backupIdentifier = client.escapeIdentifier(DATABASE_ROLES.backup);
  const ownerIdentifier = client.escapeIdentifier(DATABASE_ROLES.owner);
  const databaseIdentifier = client.escapeIdentifier(context.database);
  if (!(await role(client, DATABASE_ROLES.owner))) {
    throw new Error("Backup scope requires an existing smartlists_owner role.");
  }
  await createOrRotateLoginRole(client, {
    name: DATABASE_ROLES.backup,
    password: backupPassword,
    rotate: rotateBackupPassword,
    bypassRls: true,
    exists: context.roles.backupExists,
  });
  await client.query(
    `REVOKE ALL PRIVILEGES ON DATABASE ${databaseIdentifier} FROM ${backupIdentifier}`,
  );
  await client.query(`GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${backupIdentifier}`);
  await client.query(`SET LOCAL ROLE ${ownerIdentifier}`);
  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${backupIdentifier}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${backupIdentifier}`);
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${backupIdentifier}`,
  );
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${backupIdentifier}`);
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${backupIdentifier}`,
  );
  await client.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${backupIdentifier}`);
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM ${backupIdentifier}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} IN SCHEMA public ` +
      `GRANT SELECT ON TABLES TO ${backupIdentifier}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} IN SCHEMA public ` +
      `GRANT SELECT ON SEQUENCES TO ${backupIdentifier}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} IN SCHEMA public ` +
      `REVOKE EXECUTE ON FUNCTIONS FROM ${backupIdentifier}`,
  );
  await client.query("RESET ROLE");
}

async function verifyOwnership(client, expectedProfile) {
  const actual = await inventory(client);
  assertInventory(actual);
  const profile = await assertSecurityInventory(client);
  if (profile !== expectedProfile) {
    throw new Error(
      `Профиль арендной изоляции изменился: было ${expectedProfile}, ` +
        `стало ${profile}.`,
    );
  }
  for (const rows of Object.values(actual)) {
    for (const row of rows) {
      if (row.owner !== DATABASE_ROLES.owner) {
        throw new Error(`Ownership verification failed for ${row.name}.`);
      }
    }
  }
  const schema = await client.query(
    `SELECT pg_get_userbyid(nspowner) AS owner
     FROM pg_namespace
     WHERE nspname = 'public'`,
  );
  if (schema.rows[0].owner !== DATABASE_ROLES.owner) {
    throw new Error("public schema ownership verification failed.");
  }
}

async function verifyDefaultPrivileges(client, expectBackup) {
  const result = await client.query(
    `SELECT COALESCE(namespace.nspname, '*') AS schema,
            defaults.defaclobjtype AS object_type,
            CASE
              WHEN privileges.grantee = 0 THEN 'PUBLIC'
              ELSE grantee.rolname
            END AS grantee,
            privileges.privilege_type,
            privileges.is_grantable
     FROM pg_default_acl defaults
     JOIN pg_roles owner ON owner.oid = defaults.defaclrole
     LEFT JOIN pg_namespace namespace ON namespace.oid = defaults.defaclnamespace
     CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privileges
     LEFT JOIN pg_roles grantee ON grantee.oid = privileges.grantee
     WHERE owner.rolname = $1
     ORDER BY schema, object_type, grantee, privilege_type`,
    [DATABASE_ROLES.owner],
  );
  const actual = result.rows.map((row) =>
    `${row.schema}:${row.object_type}:${row.grantee}:` +
      `${row.privilege_type}:${row.is_grantable}`,
  );
  const expected = [
    `*:f:${DATABASE_ROLES.owner}:EXECUTE:false`,
    ...(expectBackup
      ? [
          `public:S:${DATABASE_ROLES.backup}:SELECT:false`,
          `public:r:${DATABASE_ROLES.backup}:SELECT:false`,
        ]
      : []),
  ];
  assertSameValues(actual, expected, "Owner default privileges");
}

async function verifyMigrator(connectionString, expectedProfile) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const connection = await client.query(
      "SELECT session_user AS session_user, current_user AS current_user",
    );
    if (
      connection.rows[0].session_user !== DATABASE_ROLES.migrator ||
      connection.rows[0].current_user !== DATABASE_ROLES.owner
    ) {
      throw new Error("Migrator session/current user contract failed.");
    }
    await verifyOwnership(client, expectedProfile);
  } finally {
    await client.end();
  }
}

async function verifyBackup(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const attributes = await role(client, DATABASE_ROLES.backup);
    assertSafeRoleAttributes(attributes, {
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: true,
      rolreplication: false,
      rolbypassrls: true,
    }, "Backup verification role");
    if ((await membershipsAsMember(client, DATABASE_ROLES.backup)).length !== 0) {
      throw new Error("Backup verification found unexpected membership.");
    }
    const boundary = await client.query(`
      SELECT has_database_privilege(current_user, current_database(), 'CONNECT') AS database_connect,
             has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
             has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
             has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create
    `);
    if (
      !boundary.rows[0].database_connect ||
      boundary.rows[0].database_create ||
      !boundary.rows[0].schema_usage ||
      boundary.rows[0].schema_create
    ) {
      throw new Error("Backup database/schema boundary does not match the contract.");
    }
    for (const table of EXPECTED_TABLES) {
      const result = await client.query(
        `SELECT privilege
         FROM pg_class relation
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         CROSS JOIN unnest($2::text[]) AS privilege
         WHERE namespace.nspname = 'public'
           AND relation.relname = $1
           AND has_table_privilege(current_user, relation.oid, privilege)`,
        [table, ALL_TABLE_PRIVILEGES],
      );
      assertSameValues(
        result.rows.map((row) => row.privilege),
        ["SELECT"],
        `Backup privileges on ${table}`,
      );
    }
    for (const routine of EXPECTED_ROUTINE_DEFINITIONS) {
      const signature =
        `public.${routine.name}(${routine.identityArguments})`;
      const result = await client.query(
        `SELECT has_function_privilege(
           current_user,
           $1::regprocedure,
           'EXECUTE'
         ) AS execute`,
        [signature],
      );
      if (result.rows[0]?.execute) {
        throw new Error(`Backup неожиданно имеет EXECUTE на ${signature}.`);
      }
    }
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const adminUrl = assertInputs();
  if (!apply) {
    console.log(JSON.stringify({
      mode: "plan-only",
      scope,
      endpointFingerprint: fingerprint(adminUrl.hostname),
      roles: DATABASE_ROLES,
      inventory: {
        tables: EXPECTED_TABLES,
        enumTypes: EXPECTED_ENUM_TYPES,
        sequences: EXPECTED_SEQUENCES,
        views: EXPECTED_VIEWS,
        routines: EXPECTED_ROUTINES,
        domains: EXPECTED_DOMAINS,
      },
      invariants: [
        "database owner remains unchanged",
        "runtime ACL and role attributes remain unchanged",
        "unexpected object, owner, role attribute or membership aborts apply",
        "tenant enforcement profile remains unchanged",
        "credentials are never printed",
      ],
    }, null, 2));
    return;
  }

  const client = new Client({ connectionString: adminConnectionString });
  await client.connect();
  let context;
  try {
    await client.query("BEGIN");
    const connection = (
      await client.query(
        `SELECT current_database() AS database,
                current_user AS "adminRole",
                pg_get_userbyid(database.datdba) AS "databaseOwner"
         FROM pg_database database
         WHERE database.datname = current_database()`,
      )
    ).rows[0];
    const actualInventory = await inventory(client);
    assertInventory(actualInventory);
    const enforcementProfile = await assertSecurityInventory(client);
    const roles = await assertExistingRolesAreSafe(
      client,
      connection.database,
      connection.adminRole,
    );
    const ownership = await assertOwnershipSources(
      client,
      actualInventory,
      connection.adminRole,
      connection.databaseOwner,
    );
    const runtimeBefore = await runtimeSnapshot(client);
    context = {
      ...connection,
      inventory: actualInventory,
      roles,
      ownership,
      runtimeBefore,
      enforcementProfile,
    };

    if (scope === "migration" || scope === "all") {
      await applyMigrationRoles(client, context);
    }
    if (scope === "backup" || scope === "all") {
      await applyBackupRole(client, context);
    }

    assertRuntimeUnchanged(runtimeBefore, await runtimeSnapshot(client));
    // Профиль сверяется независимо от scope: применение backup-роли проходит
    // мимо verifyOwnership, но затрагивает ту же базу.
    const enforcementAfter = await assertSecurityInventory(client);
    if (enforcementAfter !== enforcementProfile) {
      throw new Error(
        `Профиль арендной изоляции изменился: было ${enforcementProfile}, ` +
          `стало ${enforcementAfter}.`,
      );
    }
    if (scope === "migration" || scope === "all") {
      await verifyOwnership(client, enforcementProfile);
    }
    await verifyDefaultPrivileges(
      client,
      scope === "backup" || scope === "all" || roles.backupExists,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  if (scope === "migration" || scope === "all") {
    const url = new URL(adminConnectionString);
    url.username = DATABASE_ROLES.migrator;
    url.password = migratorPassword;
    await verifyMigrator(url.toString(), context.enforcementProfile);
  }
  if (scope === "backup" || scope === "all") {
    const url = new URL(adminConnectionString);
    url.username = DATABASE_ROLES.backup;
    url.password = backupPassword;
    await verifyBackup(url.toString());
  }

  console.log(JSON.stringify({
    mode: "applied-and-verified",
    scope,
    endpointFingerprint: fingerprint(adminUrl.hostname),
    databaseOwnerChanged: false,
    runtimeContractChanged: false,
    enforcementProfile: context.enforcementProfile,
    enforcementProfileChanged: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
