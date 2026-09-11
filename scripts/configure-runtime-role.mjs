import pg from "pg";
import { createHash } from "node:crypto";

import {
  ALL_TABLE_PRIVILEGES,
  DATABASE_ROLES,
  EXPECTED_POLICIES,
  EXPECTED_ROUTINE_DEFINITIONS,
  EXPECTED_ROUTINES,
  EXPECTED_TABLES,
  RUNTIME_EXECUTE_ROUTINES,
  RUNTIME_TABLE_PRIVILEGES,
  assertTriggerInventory,
} from "./database-role-contract.mjs";

const { Client } = pg;

const RUNTIME_ROLE = DATABASE_ROLES.runtime;

const apply = process.argv.includes("--apply");
const rotatePassword = process.argv.includes("--rotate-password");
const adminConnectionString = process.env.DIRECT_URL;
const expectedHost = process.env.EXPECTED_DATABASE_HOST;
const runtimePassword = process.env.RUNTIME_ROLE_PASSWORD;

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
      `${label} не совпадает. Ожидалось: ${expectedSorted.join(", ")}; ` +
        `получено: ${actualSorted.join(", ")}.`,
    );
  }
}

function assertInputs() {
  if (!adminConnectionString) {
    throw new Error("DIRECT_URL is required.");
  }
  if (!expectedHost) {
    throw new Error("EXPECTED_DATABASE_HOST is required.");
  }
  if (apply && !runtimePassword) {
    throw new Error("RUNTIME_ROLE_PASSWORD is required.");
  }

  const adminUrl = new URL(adminConnectionString);
  if (adminUrl.hostname !== expectedHost) {
    throw new Error("DIRECT_URL host does not match EXPECTED_DATABASE_HOST.");
  }
  if (adminUrl.hostname.includes("-pooler.")) {
    throw new Error("DIRECT_URL must use a direct Neon endpoint, not a pooler.");
  }
  if (runtimePassword && runtimePassword.length < 32) {
    throw new Error("RUNTIME_ROLE_PASSWORD must contain at least 32 characters.");
  }

  return adminUrl;
}

async function listPublicTables(client) {
  const result = await client.query(`
    SELECT relation.relname AS name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
    ORDER BY relation.relname
  `);
  return result.rows.map((row) => row.name);
}

async function listPublicRoutines(client) {
  const result = await client.query(`
    SELECT CASE routine.prokind
             WHEN 'p' THEN 'procedure'
             ELSE 'function'
           END AS kind,
           routine.proname AS name,
           pg_get_function_identity_arguments(routine.oid) AS arguments
    FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
    ORDER BY name, arguments
  `);
  return result.rows.map(
    (row) => `${row.kind}:${row.name}(${row.arguments})`,
  );
}

async function listPublicPolicies(client) {
  const result = await client.query(`
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
  return result.rows.map((row) => row.policy);
}

// Права на объекты выдаёт их владелец. Пока схему создал сам admin, владелец —
// он; после передачи владения контрактной роли объектами владеет она, а admin
// состоит в ней без наследования (`inherit_option = false` и на локальной
// тестовой базе, и на production), поэтому обязан делать `SET ROLE`. Владелец
// определяется по факту, а не по предположению о стадии, — иначе скрипт
// работает ровно в одной из двух и молча ломается при переходе.
// Владелец определяется по таблицам, а не по схеме: до передачи владения схема
// public принадлежит псевдороли `pg_database_owner`, и сравнивать её с ролью
// таблиц бессмысленно. Неоднородное владение таблицами — отказ: при нём часть
// GRANT прошла бы, а часть нет.
async function resolvePublicObjectOwner(client) {
  const owners = await client.query(`
    SELECT DISTINCT pg_get_userbyid(relation.relowner) AS owner
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind = 'r'
    ORDER BY owner
  `);
  if (owners.rowCount !== 1) {
    throw new Error(
      "Владение таблицами public неоднородно или таблиц нет: " +
        `${owners.rows.map((row) => row.owner).join(", ") || "∅"}.`,
    );
  }
  return owners.rows[0].owner;
}

// Триггеры и включённость RLS читаются вместе: состояние guard-ов имеет смысл
// только в паре с RLS, потому что профиль rollout определяется обоими.
async function listPublicTriggers(client) {
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
    triggers: triggers.rows,
    rlsEnabled: relations.rows.map((row) => row.name),
  };
}

async function assertExistingRuntimeRoleIsRestricted(client) {
  const roleResult = await client.query(
    `SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
            rolreplication, rolbypassrls
     FROM pg_roles
     WHERE rolname = $1`,
    [RUNTIME_ROLE],
  );
  const role = roleResult.rows[0];

  if (
    !role?.rolcanlogin ||
    role.rolsuper ||
    role.rolinherit ||
    role.rolcreaterole ||
    role.rolcreatedb ||
    role.rolreplication ||
    role.rolbypassrls
  ) {
    throw new Error(
      "Existing runtime role has unsafe attributes; refusing to change it automatically.",
    );
  }

  const membershipResult = await client.query(
    `SELECT 1
     FROM pg_auth_members membership
     JOIN pg_roles member ON member.oid = membership.member
     WHERE member.rolname = $1`,
    [RUNTIME_ROLE],
  );
  if (membershipResult.rowCount !== 0) {
    throw new Error(
      "Existing runtime role has memberships; refusing to change it automatically.",
    );
  }
}

async function verifyRuntimeRole(connectionString) {
  const runtimeClient = new Client({ connectionString });
  await runtimeClient.connect();

  try {
    await runtimeClient.query("BEGIN READ ONLY");

    const roleResult = await runtimeClient.query(`
      SELECT current_user AS role, rolsuper, rolcreaterole, rolcreatedb,
             rolreplication, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
    `);
    const role = roleResult.rows[0];
    if (!role || role.role !== RUNTIME_ROLE) {
      throw new Error("Runtime verification connected under an unexpected role.");
    }
    if (
      role.rolsuper ||
      role.rolcreaterole ||
      role.rolcreatedb ||
      role.rolreplication ||
      role.rolbypassrls
    ) {
      throw new Error("Runtime role has a forbidden role attribute.");
    }

    const membershipResult = await runtimeClient.query(`
      SELECT parent.rolname
      FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles parent ON parent.oid = membership.roleid
      WHERE member.rolname = current_user
    `);
    if (membershipResult.rowCount !== 0) {
      throw new Error("Runtime role unexpectedly inherits another role.");
    }

    const boundaryResult = await runtimeClient.query(`
      SELECT
        has_database_privilege(current_user, current_database(), 'CONNECT') AS connect,
        has_database_privilege(current_user, current_database(), 'CREATE') AS create_database,
        has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
        has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create
    `);
    const boundary = boundaryResult.rows[0];
    if (
      !boundary.connect ||
      boundary.create_database ||
      !boundary.schema_usage ||
      boundary.schema_create
    ) {
      throw new Error("Runtime database/schema boundary does not match the contract.");
    }

    for (const table of EXPECTED_TABLES) {
      const privilegeResult = await runtimeClient.query(
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
        privilegeResult.rows.map((row) => row.privilege),
        RUNTIME_TABLE_PRIVILEGES[table],
        `Права runtime на ${table}`,
      );
    }

    for (const routine of EXPECTED_ROUTINE_DEFINITIONS) {
      const signature =
        `public.${routine.name}(${routine.identityArguments})`;
      const privilegeResult = await runtimeClient.query(
        `SELECT has_function_privilege(
           current_user,
           $1::regprocedure,
           'EXECUTE'
         ) AS execute`,
        [signature],
      );
      const expectedExecute = RUNTIME_EXECUTE_ROUTINES.some(
        (allowed) =>
          allowed.kind === routine.kind &&
          allowed.name === routine.name &&
          allowed.identityArguments === routine.identityArguments,
      );
      if (privilegeResult.rows[0]?.execute !== expectedExecute) {
        throw new Error(
          `Runtime EXECUTE на ${signature} не совпадает с контрактом.`,
        );
      }
    }

    await runtimeClient.query("ROLLBACK");
  } catch (error) {
    await runtimeClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await runtimeClient.end();
  }
}

async function main() {
  const adminUrl = assertInputs();

  if (!apply) {
    console.log(JSON.stringify({
      mode: "plan-only",
      role: RUNTIME_ROLE,
      endpointFingerprint: fingerprint(adminUrl.hostname),
      tablePrivileges: RUNTIME_TABLE_PRIVILEGES,
      routineExecute: RUNTIME_EXECUTE_ROUTINES,
      denied: [
        "database CREATE",
        "schema CREATE",
        "ownership",
        "role membership",
        "BYPASSRLS",
        "CREATEROLE",
        "CREATEDB",
        "REPLICATION",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
        "all privileges on _prisma_migrations",
      ],
    }, null, 2));
    return;
  }

  const client = new Client({ connectionString: adminConnectionString });
  await client.connect();

  let roleCreated = false;
  let appliedProfile;
  try {
    await client.query("BEGIN");

    assertSameValues(
      await listPublicTables(client),
      EXPECTED_TABLES,
      "Набор таблиц public",
    );
    assertSameValues(
      await listPublicRoutines(client),
      EXPECTED_ROUTINES,
      "Набор routines public",
    );
    assertSameValues(
      await listPublicPolicies(client),
      EXPECTED_POLICIES,
      "Набор policies public",
    );
    // Состояние guard-триггеров сверяется с профилем rollout, а не с
    // константой: на production арендная изоляция включена, и жёсткая сверка
    // делала бы ротацию runtime-пароля неисполнимой ровно там (A89).
    const triggerCatalog = await listPublicTriggers(client);
    const enforcementProfile = assertTriggerInventory(
      triggerCatalog.triggers,
      triggerCatalog.rlsEnabled,
    );

    const roleResult = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [RUNTIME_ROLE],
    );
    const roleIdentifier = client.escapeIdentifier(RUNTIME_ROLE);
    const passwordLiteral = client.escapeLiteral(runtimePassword);

    if (roleResult.rowCount === 0) {
      await client.query(
        `CREATE ROLE ${roleIdentifier} LOGIN PASSWORD ${passwordLiteral} ` +
          "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
      );
      roleCreated = true;
    } else {
      await assertExistingRuntimeRoleIsRestricted(client);
      if (rotatePassword) {
        await client.query(
          `ALTER ROLE ${roleIdentifier} PASSWORD ${passwordLiteral}`,
        );
      }
    }

    const databaseResult = await client.query(
      "SELECT current_database() AS database, current_user AS owner_role",
    );
    const databaseIdentifier = client.escapeIdentifier(
      databaseResult.rows[0].database,
    );
    const ownerIdentifier = client.escapeIdentifier(
      databaseResult.rows[0].owner_role,
    );

    await client.query(
      `REVOKE ALL PRIVILEGES ON DATABASE ${databaseIdentifier} FROM ${roleIdentifier}`,
    );
    await client.query(
      `GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${roleIdentifier}`,
    );
    // Права уровня БД остаются за admin: базой контрактная роль не владеет.
    // Всё, что ниже, — объектное, и выдаётся от имени владельца.
    const objectOwner = await resolvePublicObjectOwner(client);
    const assumeOwner = objectOwner !== databaseResult.rows[0].owner_role;
    if (assumeOwner) {
      await client.query(`SET ROLE ${client.escapeIdentifier(objectOwner)}`);
    }

    await client.query(
      `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${roleIdentifier}`,
    );
    await client.query(`GRANT USAGE ON SCHEMA public TO ${roleIdentifier}`);
    await client.query(
      `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${roleIdentifier}`,
    );
    await client.query(
      `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${roleIdentifier}`,
    );
    await client.query(
      `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM ${roleIdentifier}`,
    );

    for (const [table, privileges] of Object.entries(RUNTIME_TABLE_PRIVILEGES)) {
      if (privileges.length === 0) continue;
      await client.query(
        `GRANT ${privileges.join(", ")} ON TABLE ${client.escapeIdentifier(table)} ` +
          `TO ${roleIdentifier}`,
      );
    }

    for (const routine of RUNTIME_EXECUTE_ROUTINES) {
      if (routine.kind !== "function") {
        throw new Error("Runtime configurator поддерживает только functions.");
      }
      await client.query(
        `GRANT EXECUTE ON FUNCTION public.${client.escapeIdentifier(routine.name)}` +
          `(${routine.identityArguments}) TO ${roleIdentifier}`,
      );
    }

    if (assumeOwner) {
      await client.query("RESET ROLE");
    }

    // Здесь речь о будущих объектах самого admin, поэтому выполняется от него
    // и после RESET ROLE: `FOR ROLE` требует членства в названной роли.
    for (const objectType of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} IN SCHEMA public ` +
          `REVOKE ALL PRIVILEGES ON ${objectType} FROM ${roleIdentifier}`,
      );
    }

    const afterCatalog = await listPublicTriggers(client);
    const enforcementAfter = assertTriggerInventory(
      afterCatalog.triggers,
      afterCatalog.rlsEnabled,
    );
    if (enforcementAfter !== enforcementProfile) {
      throw new Error(
        `Профиль арендной изоляции изменился: было ${enforcementProfile}, ` +
          `стало ${enforcementAfter}.`,
      );
    }
    appliedProfile = enforcementProfile;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  const runtimeUrl = new URL(adminConnectionString);
  runtimeUrl.username = RUNTIME_ROLE;
  runtimeUrl.password = runtimePassword;
  await verifyRuntimeRole(runtimeUrl.toString());

  console.log(JSON.stringify({
    mode: "applied-and-verified",
    role: RUNTIME_ROLE,
    roleCreated,
    endpointFingerprint: fingerprint(adminUrl.hostname),
    enforcementProfile: appliedProfile,
    enforcementProfileChanged: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
