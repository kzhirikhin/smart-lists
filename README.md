# Smart Lists

Smart Lists is a localized web application for personal and shared lists. It supports spaces, groups, realtime updates, notes, attachments and AI insights, plus a separate guest mode that requires no sign-up.

**Live app:** [smart-lists-iota.vercel.app](https://smart-lists-iota.vercel.app/)

## Features

- personal space plus up to five additional spaces per user;
- lists with groups, search, optimistic updates and completion tracking;
- collaborative list editing by invitation;
- realtime sync across members, tabs and devices via Pusher;
- text notes for lists and individual items, protected against version conflicts;
- private S3 attachments: PNG, JPEG, TXT and PDF;
- AI insights over list content and its notes;
- guest mode that stores data only in `localStorage`;
- `ru`, `vi`, `en`, `ja` locales with automatic language detection;
- responsive interface, light and dark themes.

## Tech stack

- Next.js 16 App Router, React 19, TypeScript;
- Tailwind CSS 4, Framer Motion, Lucide React;
- Auth.js v5 with Google OAuth;
- Prisma 7 with the node-postgres driver adapter, and PostgreSQL;
- next-intl, Zod, Pino;
- Pusher, AWS S3, an external FastAPI service for AI;
- Vitest, Playwright.

## Requirements

- Node.js `^20.19`, `^22.12` or `>=24`;
- npm;
- PostgreSQL;
- a Google OAuth application;
- for the full production feature set: Pusher, AWS S3 and the separately deployed insights service.

## Local setup

1. Create a `.env` file in the repository root and fill in the required variables:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/smart_lists
DIRECT_URL=postgresql://user:password@localhost:5432/smart_lists

AUTH_SECRET=replace-with-a-strong-random-secret
AUTH_URL=http://localhost:3000
AUTH_GOOGLE_ID=google-client-id
AUTH_GOOGLE_SECRET=google-client-secret
```

`DATABASE_URL` and `DIRECT_URL` may be identical locally. In a cloud environment the first one usually uses a pooled connection for the PrismaPg runtime adapter, while the second is loaded by `prisma.config.ts` and used by Prisma CLI for migrations.

If the migration role deliberately lacks `CREATEDB` — as it does here, so that no owner-level credential sits on a development machine — then `prisma migrate dev` cannot create its shadow database and needs one supplied:

```env
SHADOW_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/smartlists_shadow
```

That address points at the throwaway container from `docker-compose.test.yml`, which creates the database on every start; bring it up with `npm run test:integration:db` before authoring a migration. The value is not a secret, but it is dangerous in a different way: Prisma **wipes** the database it names before every run. `prisma.config.ts` therefore accepts a loopback address only and refuses a value equal to the working one.

The runtime pool is deliberately limited to five connections per application instance, with finite connection and idle timeouts. This avoids inheriting node-postgres defaults that are unsafe for an unbounded number of serverless instances.

> Important: the root `.env` is **development** configuration. The Prisma CLI reads its variables from there, so production connection strings must never land in this file. Production values live only in the hosting provider's environment variables and in GitHub Secrets. This is not limited to the database: Pusher and S3 also use separate resources in development. See [Environment separation](#environment-separation).

2. Install dependencies. The `postinstall` hook generates Prisma Client and
therefore expects `DIRECT_URL` to be available from the `.env` created above:

```bash
npm ci
```

No database connection is opened during client generation.

For Google OAuth, add the callback URL:

```text
http://localhost:3000/api/auth/callback/google
```

3. For realtime, add Pusher credentials:

```env
PUSHER_APP_ID=pusher-app-id
PUSHER_SECRET=pusher-secret
NEXT_PUBLIC_PUSHER_KEY=pusher-key
NEXT_PUBLIC_PUSHER_CLUSTER=pusher-cluster
```

4. For attachments, configure a private S3 bucket and CORS for direct browser uploads:

```env
S3_BUCKET_NAME=private-bucket-name
S3_REGION=ap-southeast-1
S3_ACCESS_KEY_ID=aws-access-key
S3_SECRET_ACCESS_KEY=aws-secret-key
```

Where the platform can issue an OIDC token — Vercel does — the static pair is replaced by a role, and no long-lived key exists on that path at all:

```env
S3_ROLE_ARN=arn:aws:iam::accountid:role/role-name
```

A role, when present, wins over a key pair, so both can coexist during a cutover and the deployment still exercises federation; removing `S3_ROLE_ARN` is the rollback. A malformed ARN fails startup rather than falling back to the key pair, because the dangerous outcome is not a broken deployment but a working one that everybody believes has already left long-lived keys behind.

5. AI insights are intentionally unavailable in Local and Preview. Production
uses Google identity federation rather than a shared static secret. Configure
the service URL and the non-secret federation identifiers only in the Vercel
Production environment. The service URL is validated before every outbound
request: it must be an HTTPS Cloud Run address of this service, with no
credentials, port, path, query or fragment. Anything else is treated as "not
configured" and no request leaves the runtime:

```env
INSIGHTS_SERVICE_URL=https://insights-api-123456789012.us-central1.run.app
GCP_PROJECT_NUMBER=123456789012
GCP_WORKLOAD_IDENTITY_POOL_ID=vercel
GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID=production
GCP_SERVICE_ACCOUNT_EMAIL=vercel-insights-invoker@example-project.iam.gserviceaccount.com
```

The application exchanges Vercel's OIDC token for a short-lived Google ID
token. Cloud Run and the service validate that token independently. Do not add
an `INSIGHTS_SERVICE_SECRET`; it has been removed from the protocol.

The optional `LOG_LEVEL` sets the Pino level; the default is `info`.

6. Apply the existing migrations:

```bash
npx prisma migrate deploy
```

7. Add an allowed Google email to the `AllowedEmail` table. Without a whitelist entry, sign-in is rejected. Prisma Studio is convenient for local setup:

```bash
npx prisma studio
```

8. If needed, enable guest sign-in by creating a row in the `AppSetting` table:

| Field | Value |
| --- | --- |
| `key` | `guestModeEnabled` |
| `value` | `true` |

Any other value, or a missing row, disables guest sign-in. Guest data is not erased from the browser in that case.

9. Start the application:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The root route redirects to a locale and, after sign-in, to the last selected space.

## Access modes

An authenticated user gets server-side storage, spaces, sharing, realtime, attachments and AI. Sign-in is permitted only for email addresses listed in `AllowedEmail`.

Guest mode requires no account. Lists, items, groups and notes are stored in the current browser's `localStorage`. This data is not synchronized and is not migrated into an account automatically.

## How it works

- The main authenticated route is `/{locale}/spaces/{spaceId}`.
- Server Components load data directly through Prisma.
- Client components use a single `ListsApi`: a server implementation backed by PostgreSQL, or a guest implementation backed by `localStorage`.
- Mutations run as Server Actions with session, space and permission checks plus Zod validation.
- The originating tab receives an updated RSC payload from the Action's response; other tabs and members receive a Pusher `refresh` event.
- Attachments are uploaded straight to S3 via presigned POST and become visible only after a server-side `HeadObject` check.

## Security architecture

Three principles shape the security-relevant design decisions: defense in depth, least privilege, and a CI pipeline that holds no production credentials.

### Defense in depth

No single check is treated as sufficient. A request crosses several independent layers, and each one is able to reject it on its own.

**Transport and browser surface.** Every response carries a fixed set of security headers — `X-Frame-Options: DENY` against clickjacking, `nosniff`, a restrictive `Referrer-Policy`, a `Permissions-Policy` that switches off camera, microphone and geolocation, and a one-year HSTS — declared once in [`next.config.ts`](next.config.ts#L6-L17).

**Two authentication gates.** A valid Google account is not enough by itself: the `signIn` callback additionally requires the address to be present in the `AllowedEmail` table, and denies the login otherwise — see [`src/auth.ts`](src/auth.ts#L77-L88). The whitelist lives in the database, so access can be revoked without a deploy.

**Authorization folded into the query.** Access checks are not a separate `if` that a future change might forget. The `listInSpaceWhere` filter is merged directly into the Prisma `where` clause, so fetching the data and proving the right to it are the same query — a list that is neither owned nor shared within that exact space simply does not come back. See [`src/lib/spaces.ts`](src/lib/spaces.ts#L40-L64).

**Client-supplied identifiers are never trusted.** A Server Action re-verifies the session, resolves `spaceId` from the form against spaces actually owned by the user, validates the payload with Zod's `safeParse`, and only then touches the database — with `ownerId` taken from the session rather than the request. [`addItem`](src/app/actions/index.ts#L95-L140) is a representative example of the whole chain; client-side validation exists purely for UX.

**Attachments are verified twice.** The presigned POST policy makes S3 itself reject a file whose size or content type is outside the allowed range, before a single byte is stored ([`src/lib/s3.ts`](src/lib/s3.ts#L105-L122)). On confirmation the server does not take the client's word for what was uploaded: `HeadObject` supplies the actual size and type, they are re-validated, and only an atomic `PENDING → UPLOADED` transition makes the file visible — see [`src/app/actions/attachments.ts`](src/app/actions/attachments.ts). Object keys are generated server-side as `lists/{listId}/{uuid}.ext`, which keeps user-supplied file names out of the key and rules out path traversal ([`src/lib/s3.ts`](src/lib/s3.ts#L80-L87)). Stale pending rows and their uploaded S3 objects are cleaned together; a failed object deletion restores the metadata so a later request can retry it.

**AI output is untrusted.** Raw HTML is never enabled, and Markdown URLs are rendered as plain text rather than clickable links. This prevents list content from using prompt injection to turn a model response into a phishing link shown under the application's identity.

**Realtime is authorized per channel.** Pusher subscriptions pass through an endpoint that permits exactly one channel per user — their own `private-user-<id>` — and answers 403 for anything else ([`src/app/api/pusher/auth/route.ts`](src/app/api/pusher/auth/route.ts#L36-L40)).

**Logging discipline.** User identifiers are written through `hashId`, and secrets, tokens and private content never reach the logs.

### Least privilege

Every component holds the narrowest set of rights that still lets it do its job.

**Storage.** The bucket is private and has no public URLs at all; downloads are issued as presigned GET links with a five-minute TTL. Each environment has its own IAM role, scoped to the `lists/*` prefix, and dev and production permissions are deliberately kept identical — if dev were broader, a key outside `lists/` would pass in one environment and fail in the other. Nothing holds a long-lived key any more: the deployed application obtains short-lived credentials by exchanging a Vercel OIDC token, each role trusts exactly one environment's token subject, and the access keys that preceded this have been deleted rather than left dormant.

The buckets also refuse the account that owns them. A bucket policy denies reading, writing, listing and version deletion to every principal except the application's own role and the account root — so administrative credentials, which exist for operating the account rather than for reading user data, do not reach the files. The same shape covers the backup bucket, where database dumps carry users' Google tokens and nothing but the backup role needs to write. Being resource-based, none of it can be undone by granting oneself broader IAM permissions; recovery goes through the root user, and that path was rehearsed on a throwaway bucket before either policy was applied.

**Secrets stay on the server.** Only `NEXT_PUBLIC_*` variables reach the browser bundle: the client gets the Pusher key, while the Pusher secret and the AWS keys remain server-side. Modules that read privileged state are marked `import "server-only"` ([`src/lib/spaces.ts`](src/lib/spaces.ts#L1)), which turns an accidental client import into a build error rather than a leak.

**Roles are separated by capability.** Ownership operations — deleting, renaming, managing access — keep an explicit `ownerId === session.user.id` condition, while content editing is available to members according to `ListShare`.

**Guest mode is minimal by construction.** Guest data never leaves the browser, and the guest flag is an httpOnly cookie whose issuance the server re-checks against `AppSetting`, so a client cannot forge its way in when guest mode is off.

**Rights are bounded in time and volume, too.** Presigned links expire in five minutes, AI insights are capped per user per UTC day, and `npm run build` deliberately has no migration step. Schema changes are applied only by the explicitly enabled release jobs. See [Limits](#limits).

### Separated CI/CD credentials

Regular CI checks never receive production credentials. Database release credentials are isolated in GitHub Environments and are unavailable to pull requests and branch checks.

**No real secrets in CI.** The checks job runs with deliberately non-functional runtime and public placeholder values because imported application modules validate their environment and Next inlines `NEXT_PUBLIC_*` at build time — the build never opens a database connection and receives no `DIRECT_URL` ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). The CI token is restricted to `permissions: contents: read`. The separate Preview proxy sync has `contents: write`, receives no repository secrets outside its guarded migration step, runs only after a successful `main` push CI, and pushes explicitly to `preview` ([`.github/workflows/sync-preview.yml`](.github/workflows/sync-preview.yml)).

**CI checks do not deploy or migrate.** A separate reusable database-release job can run only after every check for the same `main` SHA, and remains fail-closed disabled until `ENABLE_PRODUCTION_MIGRATION=true` is configured. Preview has the same opt-in guard and migrates before pushing its stable proxy branch. Both jobs verify the exact direct database host before invoking Prisma.

**Test databases are ephemeral and guarded.** Integration and E2E jobs run against throwaway PostgreSQL service containers. On top of that, global setup refuses to run when the target database name does not contain `test`, so a typo cannot point `migrate deploy` or `TRUNCATE` at a real database; the escape hatch is an explicit `ALLOW_NON_TEST_DB=1` ([`test/integration/global-setup.ts`](test/integration/global-setup.ts)).

**Every real database credential has a narrow workflow.** The scheduled backup keeps its repository secret for direct `pg_dump` access ([`.github/workflows/backup.yml`](.github/workflows/backup.yml)). Production and Preview migrations use separate `DIRECT_URL` secrets in their matching GitHub Environments. None are passed to dependency installation, pull requests, or ordinary CI jobs.

Environment isolation is the other half of this story and is described in [Environment separation](#environment-separation).

## Project structure

```text
messages/                  ru, vi, en, ja translations
prisma/
  schema.prisma            PostgreSQL models
  migrations/              migration history
src/
  app/
    [locale]/              localized pages
    actions/               Server Actions
    api/                   Auth.js and Pusher auth endpoints
  components/
    guest/                 guest screen
    lists/                 lists, items and related features
    providers/             ListsApi, themes and settings
    spaces/                spaces
    ui/                    shared UI components
  i18n/                    next-intl configuration
  lib/                     Prisma, S3, Pusher and domain helpers
  auth.ts                  Auth.js
  proxy.ts                 locale middleware for Next.js 16
test/
  integration/             Server Action and access-control tests
  e2e/                     Playwright user flows
```

## Environment separation

Development must not be able to reach production. Authentication and the three external services that can modify live data are split between environments.

| Environment | Authentication | Database | Pusher | S3 |
| --- | --- | --- | --- | --- |
| Production | production secret and Google client | Neon production branch | production app | production bucket |
| Preview (Vercel) | preview secret and Google client | `dev` branch | dev app | dev bucket |
| Local | values from the local `.env` | `dev` branch | dev app | dev bucket |

The AI service is a deliberate exception to environment parity: only Production
has `INSIGHTS_SERVICE_URL` and the Google federation configuration. Preview and
Local do not call the service at all. The federation rule independently admits
only the Vercel `production` environment, so adding the URL alone elsewhere is
not enough to gain access.

### Preview authentication

Vercel gives every Git branch a stable branch URL, but Google OAuth requires an exact callback and does not accept a wildcard for arbitrary preview branches. Auth.js therefore uses the permanent `preview` branch as a redirect proxy for every Preview deployment.

The `preview` branch is infrastructure, not a feature-development branch. Keep it available; after a successful CI run on `main`, [the sync workflow](.github/workflows/sync-preview.yml) merges the tested commit when authentication routes, Auth.js, proxy runtime dependencies, or deployment configuration changed. Ordinary UI changes do not redeploy the proxy. Its stable URL is:

```text
https://smart-lists-git-preview-kirills-projects-ed9814e1.vercel.app
```

The Preview Google OAuth client registers exactly this callback:

```text
https://smart-lists-git-preview-kirills-projects-ed9814e1.vercel.app/api/auth/callback/google
```

Vercel defines the following variable for the Preview environment only:

```env
AUTH_REDIRECT_PROXY_URL=https://smart-lists-git-preview-kirills-projects-ed9814e1.vercel.app/api/auth
```

Auth.js appends the provider callback path and securely returns the browser to the Preview deployment that initiated sign-in. This flow requires all Preview deployments and the proxy branch to share the same **Preview-only** `AUTH_SECRET`. Production has a different `AUTH_SECRET` and a different Google OAuth client; never expose either production credential to Preview.

### Database

The development environment is a separate Neon branch. It was originally created from the main one, and no longer is: production data stays in production. The rule is written as an outcome rather than a prohibition on copying, because copying is not the only way data arrives — Preview runs against this same branch, so anyone who signs in there creates rows in it simply by using the application. What keeps the branch free of other people's data is therefore the whitelist: every address in `AllowedEmail` belongs to the maintainer, and the moment one does not, the assumption behind the local `.env` no longer holds.

Should production data ever need examining outside production, it goes to a separate environment with its own protection, not to a developer's machine.

- production `DATABASE_URL` remains in Vercel, while migration `DIRECT_URL`
  credentials are scoped to the dedicated GitHub Environments and backup
  workflow;
- the local `.env` holds the dev branch connection strings;
- production migrations run in the guarded GitHub release job, and Vercel
  promotion waits for its required `Production database migration` check;
- Preview migrations run before the stable proxy branch is pushed;
- migrations are developed against the dev branch with `npx prisma migrate dev`;
- the dev branch is not refreshed from the main one; test data is created in it directly.

To check which database the current environment is connected to, look at the host in `DATABASE_URL`: every Neon branch has its own endpoint identifier.

### File storage

The key risk behind splitting S3: the database stores only object keys, while the files themselves exist in a single copy. While the bucket was shared, deleting an attachment in development erased the production file.

- the dev bucket is served by a separate IAM role, assumed by Preview deployments through OIDC federation; local development currently has no S3 credentials at all, so attachments are switched off there;
- its policy mirrors the production one and is limited to the `lists/*` prefix — permissions must match across environments, otherwise a key outside `lists/` passes locally and fails in production;
- the dev bucket's CORS allows `http://localhost:3000` and preview addresses; the production bucket allows only the production domain.

After the dev branch is recreated, older attachments will not open locally: the rows point at objects in the production bucket that do not exist in the dev one. This is expected. Deleting such an attachment targets a non-existent key in the dev bucket and leaves the production file untouched.

### Realtime

Notifications go to personal channels of the form `private-user-<id>`, and user IDs are identical in the copied database. On a shared Pusher app, local changes were refreshing the tabs of production users, so development has its own app. The cluster is the same for both: key and cluster are bound together, and a mismatch prevents the client from connecting.

## Testing

The test suite runs on three levels. Static checks and unit tests need neither a database nor secrets; the other two levels use a local PostgreSQL container.

```bash
npm run lint                  # ESLint
npm run typecheck             # tsc --noEmit
npm test                      # Vitest unit tests

npm run test:integration:db   # start the test database (Docker)
npm run test:integration      # Server Action and access-control tests

npm run test:e2e:db           # start the E2E database (Docker)
npm run test:e2e              # Playwright user flows
```

Unit tests live next to their subject as `src/lib/*.test.ts`; integration tests are in `test/integration/*.int.test.ts` and E2E specs in `test/e2e/*.e2e.ts`. Test selectors rely on `data-testid` rather than visible text, which is translated into four languages. E2E specs run in parallel under their own users, so they do not truncate tables between tests and filter every query by their own identifiers.

The same three levels run in GitHub Actions on every branch and pull request. Behaviour that automated tests do not cover — OAuth, Pusher, attachments and AI — is verified manually.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:integration` | Run integration tests against the test database |
| `npm run test:e2e` | Run Playwright E2E tests |
| `npm run build` | Build the production bundle without migrations (safe locally) |
| `npm run migrate:deploy` | Apply existing migrations to the current `DIRECT_URL` |
| `npm start` | Serve a built production bundle |
| `npx prisma migrate dev` | Create and apply a migration during schema development |
| `npx prisma studio` | Open a UI for the current database |

> `npm run build` and `prisma generate` deliberately work without `DIRECT_URL`. Database credentials are supplied only to guarded release jobs or an explicitly invoked migration command.

## Limits

- additional spaces: at most 5 per user;
- list or item note: up to 4000 characters;
- attachment: up to 10 MiB;
- attachments: up to 5 per list and up to 20 per uploading user;
- AI insights: up to 15 requests per user per UTC day.

## Deployment

The project targets Vercel and uses the `sin1` region. Vercel runs the ordinary `npm run build`; database migrations run separately in GitHub Actions. The required `Production database migration` Deployment Check holds production promotion until the migration job for the same SHA succeeds. Preview follows the same ordering by migrating before its stable proxy branch is pushed.

Before a production deploy:

1. configure all required environment variables;
2. make sure the matching GitHub Environment contains the guarded direct migration connection and expected database host;
3. allow the production origin in Google OAuth, Pusher and the S3 CORS configuration;
4. verify that PostgreSQL and, if those features are enabled, the insights service are reachable;
5. run `npm run lint` and a production build in a safe environment.

Never publish `.env`, database credentials, OAuth secrets, the Pusher secret or
AWS keys. The AI path has no shared static secret; its GCP identifiers are not
credentials, but they should still remain scoped to the Production environment
to avoid misleading configuration.

## Documentation for agents

- `AGENTS.md` — mandatory rules for working in this repository;
- `PROJECT_MEMORY.md` — current architecture, invariants and key decisions;
- `THREAT_MODEL.md` — the current security status, trust boundaries,
  assumptions, accepted risks and security backlog;
- `CLAUDE.md` — imports the shared instructions for Claude Code.
