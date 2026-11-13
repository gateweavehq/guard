# Architecture

How Gateweave Guard is built today, and the shape it is planned to take. This file changes with
the code.

## What exists

One Worker (`apps/web`), the same shape as Gateweave Track, Gateweave Agents and Gateweave Mail:

- **TanStack Start** renders pages on the server and hydrates them in the browser. Server
  functions are the API: each one checks the session and, for workspace data, the caller's
  membership before doing anything.
- **Better Auth** owns accounts, sessions, workspaces (its organizations), members, roles and
  invitations, stored in **D1**. There is one Better Auth instance per isolate, built on first
  use, because workerd forbids I/O in global scope. It can also sign people in through an OpenID
  Connect provider, and through GitHub: see "Signing in through a provider" below.
- **Rate limits** on sign-in, password reset, invitations and email are counted in a
  `RateLimiter` Durable Object per client address or recipient, so they hold across isolates and
  locations. Everything else is limited in memory per isolate. Every Worker reaches another zone
  from one address, `2a06:98c0:3600::103`, so a request with that address and a `cf-worker` header
  is counted by the zone it names, which Cloudflare sets and a sender cannot change
  (`workers-address.ts`). Better Auth counts a request before anything in it can step in, so the
  request is changed before it gets there.
- **Email** goes through Cloudflare Email Service when `EMAIL_FROM` is set: password reset,
  verification and invitations. Without it, invitations are links to share.
- **What is past its time** goes once a day, on a Cron Trigger every deployment inherits from
  `wrangler.jsonc` (`apps/web/src/server/db/prune.ts`). Better Auth removes a session or a
  verification only when something looks it up, so those nobody comes back for would otherwise
  stay, with the address and browser a session holds, and invitations with the address they were
  sent to. The privacy policy states these, so a change there is a change to it.
- **Security headers** go on every answer, and a page also gets a policy that names its scripts by
  a nonce of that response (`security-headers.ts`). Nothing is framed and no host is allowed by
  default; a member's picture may come from GitHub or the sign-in provider's own host.
- **Origin checks.** A request that changes something from a browser must carry this deployment's
  own `Origin`, which Better Auth checks for its routes.

What a workspace shows today is the shell and no more: a page each for **Findings** and
**Connections**, which say honestly that there is nothing yet, **Settings** (members, invitations,
the workspace itself) and, for whoever runs the deployment, **Server**. Nothing in Guard reads
from a Cloudflare account or a repository yet.

### Words and numbers

Every user-facing string of a screen sits in one object (`TEXT`) near the top of its module, and
dates and numbers go through `Intl` (`apps/web/src/lib/dates.ts`, `numbers.ts`), so that
translating a screen is a matter of one place and no library. The new screens (Findings,
Connections, Server and the navigation) do this. The screens that came from Mail (sign-in, the
account page, members) still have their strings inline, and move over when they are translated.

### Where the data lives

Gateweave Cloud keeps its data in the EU. Its D1 databases were created in the `eu` jurisdiction,
and `DURABLE_OBJECT_JURISDICTION=eu` keeps the Durable Objects there, so the rate limits' objects,
which are named after hashed addresses, stay beside them (`apps/web/src/server/jurisdiction.ts`).
An unknown jurisdiction fails loudly rather than count in no jurisdiction at all: the operator
asked for their data to stay somewhere. Each Cloud environment runs its Worker near its database
(`placement` in `wrangler.jsonc`: Warsaw for production, Milan for staging, as `served_by_colo`
showed when each database was made), because every query goes to the database's one primary.
Self-hosters set neither and get Cloudflare's defaults.

### Who owns a deployment

**One account runs the deployment, and decides who else may make an account.** A row in
`deployment` (one row, `id` = 1) names the owner (`owner_id`), says whether sign-up is `open` or
`closed`, and whether the sign-in provider is trusted (`trust_provider`). A second table,
`sign_up_allow`, is the owner's list. `apps/web/src/server/auth/deployment.ts` asks, and the
triggers in `0002_sign_up_hold.sql` hold it. It came from Gateweave Agents, with its tests, and is
owned here now.

- **A new deployment is open.** Its first account becomes the owner
  (`first_account_owns_deployment`). D1 runs writes one at a time, so there is only one first. The
  owner closes sign-up on the Server page.
- **Closed means an address needs a way in.** The first account of a deployment with none; an
  address on the list, or at a domain on it; an address with a pending, unexpired invitation to a
  workspace, from any workspace's admin; or, where the owner trusts the provider, an account made
  through it. GitHub is never trusted that way. People who already have an account sign in as ever.
- **The list holds an address, lowercased, or a domain written with a leading `@`.** A domain
  covers addresses at exactly that domain, which is the part after the last `@`, and not its
  subdomains. Entries are checked with zod at the owner's endpoint
  (`apps/web/src/lib/sign-up-allow.ts`). A note of at most 200 characters is the owner's own. At
  most 5,000 entries, which the endpoint says and the trigger `sign_up_allow_is_capped` holds.
  Taking an entry off lets no more people in; an account it already made stays. It names people
  who may have no account, so it is personal data.
- **Every path that makes an account asks.** `databaseHooks.user.create.before` in
  `auth/config.ts` covers email and password sign-up, GitHub, the sign-in provider and accepting
  an invitation. `mayMakeAccount` is the one function that decides. A `before` hook on
  `/sign-up/email` asks first, so that "that address is taken" does not tell a stranger which
  addresses have an account.
- **The database refuses the rest.** The trigger `user_needs_a_way_in` has the same rule for a path
  that forgets to ask, and a missing `deployment` row counts as closed. Whether an account comes
  from the provider is known only when its sign-in is linked, which is after the row is written,
  so the hook writes a pass for the address in `sign_up_pass`, good for a minute, and only where
  the owner trusts the provider. With trust on, the trigger lets an insert through only while an
  unexpired pass exists.
- **The refusal says one thing for every address:** "This server takes new accounts by invitation.
  Ask whoever runs it to invite you." With `SIGN_UP_REQUEST_URL` set to an https address, the
  sign-in pages add "Ask for access", which leads there.
- **Everything the owner does needs a recent sign-in** and is the owner's alone: anyone else gets
  the same 404 as for a path that does not exist (`/deployment/*` in `deployment.ts`).
- **The owner's account stays while sign-up is closed.** Without it nobody could open sign-up or
  change the list. `deployment_keeps_its_owner` holds it, and deleting an account says so. While
  sign-up is open the account may go, and ownership passes to the earliest account left
  (`deployment_hands_over_its_owner`).

### Workspaces

Workspaces are Better Auth organizations. Members have a role: `owner`, `admin` or `member`.
What only owners and admins may do is decided with `isAdminRole` (`apps/web/src/lib/roles.ts`),
never by comparing a role with `member`. A role this version does not know counts as a member's,
the least there is. Every server function that touches a workspace starts at `currentMember`, and
a non-member gets the same "not found" as a missing workspace.

Two triggers on `member` (`apps/web/migrations/0001_owner_triggers.sql`) make sure a workspace
keeps an owner however a row comes to change, because the plugin and the account deletion endpoint
both count owners and then act, and two owners leaving at once could each see the other still
there. They let go of a workspace that is being deleted, which is why
`beforeDeleteOrganization` deletes the organization row first and its members follow by cascade.

### Signing in through a provider

With `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` set, Guard is a client of an OpenID
Connect provider, through Better Auth's `generic-oauth` plugin
(`apps/web/src/server/auth/oidc-sign-in.ts`). What comes out of it is an account row and an
ordinary session, so nothing past the sign-in page knows the difference. Gateweave Track,
Agents and Mail have the same code, and the same reasons.

- **Discovery waits until someone needs it.** The plugin's `init` waits for the provider's discovery
  document with no time limit, and every request to a new isolate waits for `init`, so a slow
  provider would stop password sign-in and every session check. Guard replaces `init` so that each
  isolate starts as the plugin does after a failed discovery, which it retries, within 10 seconds,
  for a request that names the provider. That sets a field of the plugin's that is not public, so an
  upgrade that moves it fails the tests rather than the deployment.
- **Linking is never assumed.** The provider is not in `trustedProviders`, so an existing account
  links only when the provider says the address is verified and Guard's account has verified it
  too. Anything but a JSON `true` in `email_verified` counts as unverified.
- **Guard keeps no tokens of the sign-in.** It signs people in and never acts for them at the
  provider, so the account hook clears them all, and the ID token too, as soon as it has served its
  purpose. The same goes for signing in with GitHub. (Tokens for the accounts and repositories
  Guard will read are another matter, and come with sealing, below.)
- **The provider can end sessions.** `POST /api/auth/backchannel-logout/oidc` takes a logout token,
  checked against the provider's keys: issuer, audience, at most 5 minutes old, the logout event and
  no nonce. A session row keeps the `sid` of the ID token it came from (`session.oidc_sid`, never
  sent to the browser). Once a token has arrived it is seen through with `waitUntil`, even if the
  provider stops waiting.
- **Signing out of Guard stays in Guard.**

### Deleting an account

People delete their own account on `/settings/account`, through `POST /api/auth/account/delete`
(`apps/web/src/server/auth/delete-account.ts`). Better Auth's `/delete-user` stays off: it lets
someone with a password through without it.

- **What it asks for.** A session from the last day, and the password if the account has one.
  Better Auth's `/unlink-account` is disabled, because it removes a password on a recent session
  alone. So are the other routes it offers any session and the app has no use for. The list is
  `disabledPaths` in `apps/web/src/server/auth/config.ts`, and
  `apps/web/src/server/auth/routes.test.ts` fails when an upgrade adds a route to what answers, so
  someone decides about it.
- **A workspace keeps an owner.** The only owner of a workspace is refused and told which.
- **The deployment keeps its owner while sign-up is closed.** See "Who owns a deployment".
- **D1 goes in one batch:** the user is deleted and the invitations addressed to them are taken.
  Foreign keys take the sessions, sign-ins, memberships and the invitations they sent. A trigger's
  refusal leaves everything in place.

### Changing a name or password

People change both on `/settings/account`, through Better Auth's `/update-user` and
`/change-password`, and what stands behind either may be a stolen cookie. The rules are in
`apps/web/src/server/auth/account-changes.ts` and the hooks of `config.ts`.

- **A rename takes a name and nothing else:** 1 to 100 characters once trimmed, which sign-up keeps
  to as well. The route would otherwise set a picture too, whose address everyone in someone's
  workspaces fetches. It allows ten a minute.
- **A new password needs the current one,** at five tries a minute from one client address, and
  sends the person an email, which may be how they first hear that someone else has it.
- **Tries at a password are also held per person,** since a stolen cookie can be sent from many
  addresses (`apps/web/src/server/auth/password-tries.ts`). This and deleting an account share an
  allowance of 10 at once, refilling over an hour, within 30 that refill over a day. Only a request
  with a session for that account spends it, so nobody can lock a person out with their address
  alone, and signing in is not part of it.
- **It ends every session,** whatever the request asks, since whoever knew the old password may be
  why it is changing and may be the one asking.

## Not built yet

This is where it is going, and it may change. What is above stays as it is: one Worker for the UI,
the API and auth, with D1 for accounts and workspaces.

- **Connections.** A Cloudflare account, read through an API token, and a GitHub repository.
  Guard only reads from both: it never changes a setting or a repository by itself.
- **Findings** from three sources: Cloudflare Security Insights, aggregates of WAF and bot
  activity per zone, and dependency vulnerabilities, from lockfiles checked against OSV.
- **Traffic data is stored as aggregates only**: counts by rule, action, country and time. Never
  an IP address, a user agent or a request path.
- **Sealing connection tokens.** A token Guard is given is sealed at rest, and never logged or
  shown again, in a step of its own. Until it lands, nothing stores a token.
- **A finding becomes a Gateweave Track issue**, or a fix pull request from Gateweave Agents.
- **An MCP server**, so agents can read findings.
