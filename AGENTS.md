# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. It is the single source
of truth for how the project is built; `CLAUDE.md` and other tool-specific files only add to it.

## The project

Gateweave Guard is security in one place for teams on Cloudflare. It is meant to read an account's
Cloudflare Security Insights, aggregates of its zones' WAF and bot activity, and the lockfiles of
its repositories (checked against OSV), and to turn each finding into a
[Gateweave Track](https://github.com/gateweavehq/track) issue or a fix pull request from
[Gateweave Agents](https://github.com/gateweavehq/agents). It only reads. It is part of
[Gateweave](https://gateweave.com), next to [Gateweave ID](https://github.com/gateweavehq/id) and
[Gateweave Mail](https://github.com/gateweavehq/mail). Everything ships as one Worker.

It is early. Today it has accounts (sign-up, sign-in, password reset, an account page, sign-in
through an OpenID Connect provider), workspaces with members and invitations, a deployment owner
who decides who may make an account, and connections: admins connect a Cloudflare account or a
GitHub repository with a token, sealed under `SECRETS_KEY`, and scans (daily, and on "Scan now")
turn Security Insights and vulnerable dependencies into findings that members read and admins
dismiss. Daily counts of each zone's WAF and bot activity (a Traffic page, and a finding when a day
spikes) are stored as aggregates only. Track issues and Agents pull requests from findings, email and
an MCP server (`/mcp`, OAuth sign-in as the person, six tools) are built too.

Read [docs/architecture.md](docs/architecture.md) before changing auth, the deployment's sign-up
rules, anything about connections, sealing and scans, or how D1 is asked ("When a query of D1
fails").

## Repository map

| Path              | What lives there                                                          |
| ----------------- | ------------------------------------------------------------------------- |
| `apps/web`        | The Worker: TanStack Start UI, Better Auth, rate limiting, email, D1      |
| `packages/scan`   | What scans read: Security Insights, zone traffic, GitHub, lockfiles, OSV  |
| `docs/`           | Architecture and self-hosting                                             |
| `scripts/`        | Repository tooling (`doctor`)                                             |
| `.claude/skills/` | Step-by-step playbooks for recurring tasks (plain Markdown, any agent)    |
| `wrangler.jsonc`  | The Worker's config, at the root because the Deploy button reads it there |

`packages/scan` talks to Cloudflare, GitHub and OSV with nothing but `fetch`, so it is tested in
Node against recorded answers. Keep Worker bindings, D1 and sealing out of it: `apps/web` opens a
token, passes it in, and writes what comes back (`apps/web/src/server/connections/`). The Worker
reaches the three services through `CLOUDFLARE_API_URL`, `GITHUB_API_URL` and `OSV_API_URL` when
they are set, which is how its tests serve recorded answers (`apps/web/test/upstreams.ts`). Add
another package only when code stands on its own the same way, not before.

Wrangler commands that use the build output (`deploy`, `versions upload`, `preview`) must run
from the repository root, where the build leaves its pointer next to `wrangler.jsonc`. Use
`pnpm wrangler …`, which does that.

## Commands

Requirements: Node.js 24 (see `.node-version`; 22+ works) and pnpm 12. Run from the repository
root unless noted.

| Command           | Purpose                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `pnpm install`    | Install dependencies                                                         |
| `pnpm doctor`     | Check the local toolchain and setup, with fixes for anything missing         |
| `pnpm dev:setup`  | One-time: create `.dev.vars` and migrate the local D1 database               |
| `pnpm dev`        | Run the app on http://localhost:4760 (Workers, D1 and Durable Objects local) |
| `pnpm check`      | Biome lint and format check (`pnpm format` fixes most findings)              |
| `pnpm typecheck`  | Type-check every package (regenerates Wrangler and route types first)        |
| `pnpm test`       | Run every test suite                                                         |
| `pnpm build`      | Production build                                                             |
| `pnpm verify`     | Everything CI runs: check, typecheck, test, build                            |
| `pnpm run deploy` | Build, apply D1 migrations, deploy                                           |
| `pnpm wrangler`   | The pinned Wrangler, run from the repository root                            |

Gateweave's products use the 47xx ports locally: Guard is 476x (dev 4760, preview 4761). Never
pick a port in the 3000s.

Scope a command to one package with `pnpm --filter <name> <script>`, for example
`pnpm --filter @gateweave/guard-web test`. Run `pnpm verify` before you consider a change done.

Gateweave Cloud's environments are in `wrangler.jsonc`: `staging` (a separate Worker at
`guard-staging.gateweave.com`) and `cloud` (`guard.gateweave.com`, which a release deploys with
`CLOUDFLARE_ENV=cloud`). Both keep their data in the EU and run their Workers near their database.
Bindings are not inherited, so each environment repeats them: a binding added at the top level
goes into both, and `test/wrangler-config.test.ts` checks they match.

## Invariants

These are load-bearing. Breaking one breaks users' data or security, usually silently.

1. **Guard only reads.** Whatever it connects to, a Cloudflare account or a repository, it asks
   for the least access that reads, and it never changes a setting, a rule or a file there by
   itself. A change to either is made by a person, or by an agent a person asked, in another
   product.
2. **Tokens are sealed at rest and never logged or shown again.** A credential for an account or a
   repository is encrypted before it is written (`apps/web/src/server/secrets.ts`, under
   `SECRETS_KEY`; without a usable key connecting is refused), opened only inside a scan or a
   check, and pages see at most its last four characters (`token_hint`). Never log one, return one
   or put one in an error, and never store one anywhere but `connection.token_sealed`.
3. **Traffic data is stored as aggregates only.** Counts by rule, action, country, host and time
   (`traffic_count`). Never an IP address, a user agent or a request path, however briefly, never in
   a log and never in a query: `packages/scan/src/traffic.ts` names the few fields it asks Cloudflare
   for, and two tests fail if one that identifies a visitor appears.
   **A rule's expression is never stored either.** Protection reads a zone's custom WAF rules, and an
   expression can hold the customer's own secrets (a header value, an address in a skip rule). It is
   left out of the schemas in `packages/scan/src/protection.ts`, so it is stripped at the boundary,
   and no column holds it; tests fail if one is stored, returned or shown.
4. **Workspaces are private.** Every server function that reads or changes workspace data checks
   the caller's membership in D1 first (`currentMember` in `apps/web/src/server/access.ts`, or
   `findMembership` for `/mcp`, which takes an OAuth access token and never a session cookie).
   Non-members get the same "not found" as a missing workspace.
5. **Server code never reaches the browser bundle.** In server functions, import server modules
   dynamically inside the handler, as `apps/web/src/lib/session.ts` does.
6. **One Better Auth instance per isolate, built on first use** (`getAuth()`). workerd forbids
   I/O in global scope, and `test/startup-logs.test.ts` fails if a cold start logs an error.
7. **Admin rights are granted, never assumed.** What only owners and admins may do is decided
   with `isAdminRole` (`apps/web/src/lib/roles.ts`), which names the roles that may. Never compare
   a role with `member`: a role added later would be an admin without anyone granting it.
8. **A workspace keeps an owner**, in the database as well as in the endpoints: two triggers on
   `member` (`apps/web/migrations/0001_owner_triggers.sql`) refuse the change that would leave
   none.
9. **One account runs the deployment, and sign-up follows its rules.** The first account owns it.
   While sign-up is closed, an account needs the owner's list or an invitation, in the hook
   (`mayMakeAccount`) and in the database (`user_needs_a_way_in`), and the owner's account stays
   (`deployment_keeps_its_owner`). Everything under `/deployment/` is the owner's alone and asks for
   a recent sign-in. See "Who owns a deployment" in `docs/architecture.md`.
10. **Migrations are append-only.** Generate them with Drizzle Kit and commit them. Never edit a
    migration that has been merged. Follow `.claude/skills/schema-change/SKILL.md`.
11. **Secrets stay local.** Never commit `.dev.vars` or print its contents.
12. **A statement's text holds no value.** Everything that asks D1 goes through `createDb`, which
    logs a failed statement's text and throws an error without it ("When a query of D1 fails" in
    `docs/architecture.md`), for what is asked of the binding through `db.$client` as well. So
    values are bound: no `sql.raw` and no hand-written statement with anything in its text but the
    code's own words, and nothing reaches `env.DB` but through `createDb`. Never read a database
    error's message to decide an answer, and never show or log Drizzle's own error or D1's. An
    answer that depends on a trigger having refused asks `refusedBy`, one that depends on a
    unique index asks `refusedByUnique`, and a trigger that refuses with new words is added to
    `REFUSALS`, all in `apps/web/src/server/db/query-failure.ts`. A failure that is neither is
    never answered as if it were.

## Code style

- TypeScript is strict, with `noUncheckedIndexedAccess`. Avoid `any` and non-null assertions.
- Biome formats: tabs, 100 columns, double quotes. Don't hand-format; run `pnpm format`.
- Validate untrusted input at the boundary with zod. Inside, trust the types.
- Prefer `#private` fields, named exports and small modules. Default exports only where a
  framework requires them.
- Comments explain why, not what. Match the tone and density of the file you are editing.
- User-facing strings of a screen live in one object near the top of its module (`TEXT`), and
  dates and numbers are formatted with `Intl` (`apps/web/src/lib/dates.ts`, `numbers.ts`), so a
  screen can be translated later without an i18n library and without hunting for its words. New
  screens do this; the ones that came from Mail still have theirs inline.
- Generated files are not edited by hand: `routeTree.gen.ts`, `worker-configuration.d.ts`,
  `apps/web/src/server/db/auth-schema.ts` (`pnpm --filter @gateweave/guard-web auth:schema`), and
  everything under `apps/web/migrations/` except custom migrations
  (`drizzle-kit generate --custom`, such as `0001_owner_triggers.sql`).
- Dependencies are pinned to exact versions. Shared ones go in the `catalog:` of
  `pnpm-workspace.yaml`. `drizzle-orm` stays on 0.45: the 1.0 migration format does not work
  with Wrangler's D1 migrations.
- UI code copied into the repository (components, blocks, hooks) must come from an MIT or
  Apache-2.0 source, such as shadcn/ui, Magic UI or SmoothUI. Note the source and keep its
  copyright notice in a comment at the top of the file. Paid or restricted kits (Aceternity UI,
  shadcn.io blocks, shadcnstudio Pro) cannot ship in an AGPL repository.

## Code shared with the other Gateweave products

Auth, rate limiting, email, the deployment's sign-up rules, the Worker test harness and the UI
primitives came from [gateweavehq/mail](https://github.com/gateweavehq/mail) and
[gateweavehq/agents](https://github.com/gateweavehq/agents), which took them from
[gateweavehq/track](https://github.com/gateweavehq/track), and are owned here now, the way
shadcn/ui components are. When you fix a bug in one of them, check whether the others have the
same bug, especially in auth and rate limiting. They become shared packages only when it is worth
the cost.

## Testing

- Test behavior through public APIs, not internals.
- `apps/web` has unit tests in `src/` and Worker tests in `test/`. The Worker tests build the app
  and run it in workerd through Miniflare, with every outbound request failing as a deployed
  Worker's request to its own hostname does; see `test/guard-worker.ts`. Cloudflare, GitHub and
  OSV are stand-ins with answers shaped as the real ones, and tests change their state between
  scans (`test/upstreams.ts`, `test/connections-world.ts`); the hourly scan is run with
  `runScheduled(isolate, "0 * * * *")`.
- There are no browser tests yet. A later step adds Guard's own (Playwright, against the
  production build). Until then, check a page you changed in a browser (`run-locally`).
- Every bug fix gets a test that fails without the fix. Never weaken or skip a test to make a
  change pass.

## Git and pull requests

- `main` is protected: changes land through pull requests with a green `check`, squash or rebase
  merged. Branch from `main` as `feat/…`, `fix/…`, `docs/…` or `chore/…`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), with a
  scope when it helps: `fix(web): keep the workspace menu open on mobile`. Explain why in the
  body.
- Commits, pull requests, comments and release notes carry no AI attribution: no
  `Co-authored-by` trailer naming an AI, no "Generated with" line and no session link. If your
  tool adds them, take them out before you push, and out of the message of a squash merge,
  which GitHub fills from the commits. History already merged stays as it is.
- Fill in the pull request template.
- Follow `.claude/skills/open-pull-request/SKILL.md` for the full flow.
- Pull requests leave `CHANGELOG.md` alone, so parallel branches do not conflict there. A
  maintainer adds each version's entry when releasing.

## Playbooks

Each folder in `.claude/skills/` holds a `SKILL.md` for a recurring task. They are plain Markdown,
so any agent can follow them:

| Skill               | Use it to                                                  |
| ------------------- | ---------------------------------------------------------- |
| `schema-change`     | Change the D1 schema with a migration                      |
| `run-locally`       | Start the app and check a change in a real browser         |
| `open-pull-request` | Take a change from a branch to a merged-ready pull request |
