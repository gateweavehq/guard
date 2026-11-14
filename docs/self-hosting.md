# Self-hosting

Gateweave Guard runs on your own Cloudflare account as one Worker. It is early: today it has
accounts, workspaces with members and invitations, connections to Cloudflare accounts and GitHub
repositories, and the findings their scans make. It uses:

- a D1 database for accounts, sessions, the list of workspaces, who runs the deployment, and the
  workspaces' connections (their tokens sealed), scans and findings;
- a Durable Object that counts rate limits, one per client address or recipient;
- optionally, Cloudflare Email Service, to send password resets, verification and invitations.

You need a Cloudflare account with the **Workers Paid** plan. Sign-in takes more CPU than the Free
plan gives a request, and Email Sending is a Paid feature.

There are two ways to deploy: the button, which also sets up deploys on every push, or the
command line.

## Deploy with the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gateweavehq/guard)

The repository is private until its first release, so the button works once it is public. It copies
the repository to your GitHub or GitLab account and connects the copy to Workers Builds, so every
push to its main branch deploys. On the form:

- **Git account** is the first field, the account the copy goes to.
- **Project name** names the Worker. It answers on `<project name>.<your subdomain>.workers.dev`.
- **D1 database**: choose **+ Create new** and give it a name. The form picks an existing database
  when one in your account has the name in `wrangler.jsonc` (`gateweave-guard`), so check it
  before you deploy.
- **BETTER_AUTH_SECRET** signs sessions. Use a long random string, for example from
  `openssl rand -base64 32`, and keep it secret. Changing it later signs everyone out.
- **SECRETS_KEY** seals the tokens of connections, and is not on the form, since it is optional:
  add it afterwards (see [Connections and SECRETS_KEY](#connections-and-secrets_key)). Until you do,
  accounts and workspaces work and nothing can be connected.
- Leave the build and deploy commands as they are. The deploy command applies the database
  migrations before the new code goes live.

When the build finishes, open the Worker's address and create an account. **The first account owns
the deployment** and decides who else may sign up: see [Who may sign up](#who-may-sign-up).

**Preview builds.** The button turns them on: a push to any other branch builds a Preview with its
own URL. A Preview gets none of the Worker's bindings or secrets, so its address only says that it
is not set up, and it cannot reach your data. To make Previews work, create another D1 database and
apply the migrations to it, name it and the Durable Objects under `previews` in `wrangler.jsonc` as
[Cloudflare's guide](https://developers.cloudflare.com/workers/previews/resources/) shows, and give
them a secret of their own with `pnpm wrangler preview base-config secret put BETTER_AUTH_SECRET`.
If you don't need them, untick **Enable Preview builds** on the form, or turn them off later under
Settings › Build › Branch control.

**Dependabot.** The copy brings this repository's `.github/dependabot.yml`, so Dependabot opens a
pull request on it within minutes, and weekly after that. You don't need them: a release brings
updates that were tested together. Delete the file unless you want them, and close what it opened.

## Deploy from the command line

Requirements: Node.js 24 (22+ works) and pnpm 12.

```sh
git clone https://github.com/gateweavehq/guard.git
cd guard
pnpm install
pnpm wrangler login
pnpm run deploy
```

`pnpm wrangler` runs the Wrangler version Guard pins, from the repository root. The Worker and its
database are named `gateweave-guard`. To use other names, change `name` and `database_name` in
`wrangler.jsonc` before the first deploy.

The first deploy does three things:

1. It creates the D1 database and the Durable Object namespace.
2. It generates `BETTER_AUTH_SECRET`, which is never shown.
3. It applies the migrations.

Every later `pnpm run deploy` builds, applies new migrations, and only then deploys.

Then open the Worker's address and create an account, which owns the deployment.

## Who may sign up

By default anyone who can reach the deployment may make an account. The first account is its owner,
and on the **Server** page (in the navigation, for the owner only) they can close sign-up. Closed
means by invitation: the first account of a new deployment, addresses and domains on the owner's
list, and addresses with a pending invitation to a workspace may make an account, and people who
already have one sign in as before. Where an OpenID Connect provider is set up, the owner can also
trust it, so that anyone who signs in through it may make an account.

Closing sign-up needs a recent sign-in, and the owner's own account stays while it is closed:
open sign-up first to delete it. Set `SIGN_UP_REQUEST_URL` to an https address and the sign-in pages
add "Ask for access", which leads there.

## Where the data lives

Every read and write of an account or a session goes to one place, the D1 database's primary, and
D1 puts it close to whoever asked for the database unless told otherwise. That may be far from your
people. To choose, make the database yourself before the first deploy, with a location hint
(`wnam`, `enam`, `weur`, `eeur`, `apac` or `oc`), or with a jurisdiction (`eu`) to keep it in one:

```sh
pnpm wrangler d1 create gateweave-guard --location apac
```

Then pick it instead of **+ Create new** on the button's form, or put its id in `wrangler.jsonc` as
`database_id`. To keep the rate limits' Durable Objects in a jurisdiction too, set
`DURABLE_OBJECT_JURISDICTION` to `eu`, `us`, `fedramp` or `fedramp-high`. A value Cloudflare does
not know makes requests fail, rather than silently count somewhere else.

## Settings

Everything except `BETTER_AUTH_SECRET` is optional. Set them in the Cloudflare dashboard (Workers &
Pages › your Worker › Settings › Variables and Secrets), or from the repository root:

```sh
pnpm wrangler secret put BETTER_AUTH_URL
```

Keep tokens, keys and email addresses as secrets. Plain variables stay through a deploy too,
because `wrangler.jsonc` sets `keep_vars`.

| Name                          | What it does                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`          | Signs sessions. Required.                                                                                          |
| `BETTER_AUTH_URL`             | The address people use, such as `https://guard.example.com`. Inferred when unset, and then MCP is off.             |
| `GITHUB_CLIENT_ID`            | Turns on "Sign in with GitHub", with `GITHUB_CLIENT_SECRET`.                                                       |
| `GITHUB_CLIENT_SECRET`        | The client secret of the same GitHub OAuth app.                                                                    |
| `OIDC_ISSUER`                 | Turns on an OpenID Connect provider, with the two below. See [below](#sign-in-through-an-openid-connect-provider). |
| `OIDC_CLIENT_ID`              | This deployment's client ID at the provider.                                                                       |
| `OIDC_CLIENT_SECRET`          | Its client secret there.                                                                                           |
| `OIDC_PROVIDER_NAME`          | What the sign-in button calls it. Unset: "single sign-on".                                                         |
| `EMAIL_FROM`                  | Turns on email (invitations, password reset, alerts), such as `Gateweave Guard <guard@example.com>`.               |
| `LEGAL_NOTICE_URL`            | The address of your legal notice. See [below](#your-legal-pages).                                                  |
| `PRIVACY_POLICY_URL`          | The address of your privacy policy.                                                                                |
| `TERMS_URL`                   | The address of your terms.                                                                                         |
| `DURABLE_OBJECT_JURISDICTION` | Keeps the Durable Objects in `eu`, `us`, `fedramp` or `fedramp-high`. Unset: no jurisdiction.                      |
| `SIGN_UP_REQUEST_URL`         | An https address that "Ask for access" leads to once the owner closes sign-up. Unset: no link.                     |
| `SECRETS_KEY`                 | Seals the tokens of connections. Without it nothing can be connected. See [below](#connections-and-secrets_key).   |
| `SECRETS_KEY_PREVIOUS`        | The key before, while `SECRETS_KEY` is being changed. Only opens what it sealed.                                   |
| `CLOUDFLARE_API_URL`          | For tests and mirrors: where Cloudflare's API is reached. Unset: `https://api.cloudflare.com/client/v4`.           |
| `GITHUB_API_URL`              | For tests and mirrors: where GitHub's API is reached. Unset: `https://api.github.com`.                             |
| `OSV_API_URL`                 | For tests and mirrors: where OSV is reached. Unset: `https://api.osv.dev/v1`.                                      |

### Connect an AI assistant

Guard has an MCP server at `https://<your-guard>/mcp`. It needs `BETTER_AUTH_URL` set to your
public address, because the sign-in an assistant does is bound to it: without that, `/mcp` answers
404. Apply the migrations (`pnpm run deploy` does), since it adds tables for the sign-in.

In Claude Code:

```sh
claude mcp add --transport http guard https://guard.example.com/mcp
```

In Claude.ai or another client, add `https://guard.example.com/mcp` as a remote MCP server. The
client registers itself, sends the person to Guard to sign in, and asks them to allow it on a page
that names the app. Settings, AI assistant, shows the address with a copy button, and lists the
assistants you allowed, each with a Take back button that ends its access at once.

The assistant acts as the person who allowed it, in every workspace they belong to, and can do what
the Findings and Traffic pages let that person do: read findings, and for an owner or admin dismiss
one and start a scan. What it reads goes to the assistant, so connect only ones you trust. It never
sees a connection's token. There are no keys for jobs with no browser yet. See "MCP" in
[architecture.md](architecture.md).

### Connections and SECRETS_KEY

Owners and admins connect a Cloudflare account (its id and an API token) or a GitHub repository
(`owner/name` and a fine-grained token) on the Connections page. Guard checks the token, seals it
and scans: the first scan runs while they wait, then every day, and whenever an admin presses
"Scan now" (once in five minutes per connection). Nothing else is needed from you but one secret.

`SECRETS_KEY` is 32 random bytes in base64, such as `openssl rand -base64 32`. It seals every token
before it is stored (AES-256-GCM, with a key derived from it and the workspace, so a token copied
into another row does not open). Without it, or with one shorter than 32 bytes, the page says the
server is not set up for connections and refuses to take a token. `pnpm dev:setup` makes one for
local development.

**Changing it.** Set the new key as `SECRETS_KEY` and the old one as `SECRETS_KEY_PREVIOUS`. The
daily run seals every token again under the new key, up to 500 a run, and logs `secrets:` with how
many it sealed, how many opened with neither key and how many are still under another. Once `left` is
0, remove `SECRETS_KEY_PREVIOUS`. A token that opens with neither key is not lost to the workspace:
its connection says it needs attention and an admin replaces the token. Do not lose the key: without
it, every connection needs a new token.

### Gateweave Track, and a fix from Agents

Findings can be filed as issues in a Gateweave Track, and dependency findings sent on to Gateweave
Agents for a pull request. An owner or admin sets it up under Settings, Gateweave Track. It needs
`SECRETS_KEY`, which seals the key, and nothing else on the server.

1. In Track, make an **agent member** for Guard (Settings, Agents) and copy its key, which starts
   with `gwt_`. It works in that one workspace and acts as itself. If an admin set it to propose
   some changes, an issue it files waits for a person to accept it, and Guard shows that.
2. In Guard, give Track's address (`https://track.gateweave.com`, or your own, https only; plain
   `http://localhost` works only while Guard itself runs on localhost), the workspace's slug, the
   key of the team that gets the issues, and the key. Guard checks them against Track before it
   saves, and says what is wrong in a sentence if it cannot.
3. Optional, for fixes: make a **label** in Track, such as `agent`, give Gateweave Agents a trigger
   for Track issues carrying that label, and enter the label in Guard. Dependencies with a fixed
   version then show "Ask Agents for a fix", which files the issue with the label or adds it. Agents
   opens the pull request, and it shows on the Track issue. Guard never makes labels and holds no
   Agents secret. Guard also adds a label called `security` to issues it files, but only if the
   workspace has one.

Guard sends Track a finding's title, severity, versions, advisory, lockfile and repository, or an
insight's class and subject, and a link back. Insights about multi-factor authentication name
members by email, and those go to the same team's Track. No token or key of a connection is ever
sent. Where Guard and Track share a zone, as on Gateweave Cloud, the Worker's
`global_fetch_strictly_public` flag in `wrangler.jsonc` lets Guard reach Track by its public
address; keep it if you run both under one domain.

**Scans** run from two Cron Triggers in `wrangler.jsonc`, both inherited by every environment: the
daily one (`29 3 * * *`) clears what is past its time and seals tokens again after a key change, and
the hourly one (`0 * * * *`) scans the connections whose day has passed, oldest first, at most 10 an
hour, one after another, and then sends the emails described under [Email](#email). A deployment
with more than 240 connections falls behind its day; see "Scans without a Queue" in
[architecture.md](architecture.md). Remove the hourly trigger and nothing scans except "Scan now",
and no alert or summary goes out.

**What Guard asks for.** Cloudflare: an account API token with three read permissions, Account ›
Security Center Insights › Read for the account, and, for all its zones, Zone › Security Center
Insights › Read and Zone › Analytics › Read. With the account one alone the token still works, but
Cloudflare leaves out every insight about the account's domains; without Analytics › Read, Guard
cannot count what the WAF and bots did to each zone (the Traffic page), and the connection says so
while its Security Insights are still scanned. Connecting checks the Analytics permission on the
account's first active zone. Three more read permissions are optional, for the Protection page, all on all zones:
Zone › WAF › Read (custom, managed and rate limiting rules), Zone › Bot Management › Read (Bot Fight
Mode) and Zone › Zone Settings › Read (Under Attack mode). Without one, Protection says which is missing
and the rest still works. A scan costs Cloudflare five more requests a zone; on Workers Paid
(10,000 subrequests an invocation) that is no limit for an account of a few hundred zones, but on the
Free plan's 50 only a few zones fit. Guard never reads or stores a rule's expression, which can hold
secrets. Guard stores those counts per day and zone for 90 days, and never an
address, user agent or path. GitHub: a fine-grained token for the one repository, with Contents set to
Read-only (GitHub adds Metadata itself). Guard only reads. The tokens, the sealed copies and the
findings live in D1, and Guard sends OSV only package names and versions, never a repository's name or
files.

### Your own domain

In the dashboard, open the Worker and add a custom domain under Settings › Domains & Routes. Or
add `"routes": [{ "pattern": "guard.example.com", "custom_domain": true }]` to `wrangler.jsonc`.
Then set `BETTER_AUTH_URL` to that address, and use it in the OAuth apps' URLs. Sign-in needs HTTPS:
session cookies are marked `Secure`, so a browser won't keep them over plain HTTP. Turn on
[Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)
for the domain so that nobody lands on the plain address.

Guard's pages refuse scripts they did not name, so a zone setting that adds scripts to a page does
nothing here or gets in the way. [Web Analytics' automatic setup and Rocket Loader](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/content-security-policies/)
are two of them: leave those off for this hostname.

### Your legal pages

Guard comes with no legal notice, privacy policy or terms, and never links to Gateweave's: whoever
runs a copy decides what applies to it. Set any of the three addresses above, and it is linked from
the sign-in pages and the workspace menu. With `TERMS_URL` set, the sign-in page also says that
continuing means agreeing to them.

### Email

Guard sends email through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/).
Onboard the sender's domain once with `pnpm wrangler email sending enable example.com`, then set
`EMAIL_FROM` to an address on it. Without email, Guard works, but invitations have to be accepted
from a link that an admin copies, and nobody can reset a forgotten password for themselves.

**What else Guard sends.** With email on, each member can get two emails about a workspace, which
they switch in Settings, Notifications. Owners and admins have both on until they turn them off,
and members have both off until they turn them on:

- **An alert** when a scan finds new critical or high findings: one email per workspace, at most
  one an hour, listing each finding's title and where it is (a zone, a repository, a package). The
  first scan of a new connection sends none, since it finds what was already there.
- **A weekly summary** on Mondays, from 08:00 UTC: what is open by severity, what is new and resolved
  this week, and how many requests Cloudflare's WAF and bot features stopped or challenged.

Both come from the hourly Cron Trigger, so they need it. They show titles and counts, never a token,
an address or anything from a request, and each carries a one-click unsubscribe link and the
`List-Unsubscribe` headers. Set `BETTER_AUTH_URL` for the links: the scheduled run has no request
to learn the address from, and without it the emails have no button and no unsubscribe link. The
sender and the domain are the ones above; nothing else needs setting up.

If someone forgets a password on a server with no email, you hold the database and can make them a
reset link, from the repository root. Find their `id` in this list. Don't paste an address someone
sent you into a command, as it could run as part of it:

```sh
pnpm wrangler d1 execute DB --remote --command "SELECT id, email FROM user ORDER BY email"
```

Then make a link for that `id`. It works once, for an hour, and using it signs them out everywhere.
Whoever opens it can choose the password, so send it only to them:

```sh
PERSON=the-id-from-that-list
TOKEN=$(openssl rand -hex 32)
pnpm wrangler d1 execute DB --remote --command \
  "INSERT INTO verification (id, identifier, value, expires_at) VALUES ('$TOKEN', 'reset-password:$TOKEN', '$PERSON', (unixepoch() + 3600) * 1000)"
echo "https://your-server/reset-password?token=$TOKEN"
```

### Sign in through an OpenID Connect provider

Any OpenID Connect provider can sign people in: Gateweave ID, Pocket ID, authentik, Keycloak, Okta
and others. It adds a button to the sign-in page, and passwords keep working.

1. Register Guard with the provider as a confidential client that uses the authorization code
   flow and `client_secret_basic`, with the scopes `openid`, `profile` and `email`:
   - Redirect URI: `https://guard.example.com/api/auth/callback/oidc` (your address)
   - Back-channel logout URI, if the provider has them:
     `https://guard.example.com/api/auth/backchannel-logout/oidc`
2. Set `OIDC_ISSUER` to the provider's issuer, the address its
   `/.well-known/openid-configuration` is under, then `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.
   `OIDC_PROVIDER_NAME` names the button, as in "Continue with Acme".

Someone new gets an account, named as the provider names them, and can change that name in Guard
without the provider changing it back. Someone whose address already has one links to it only when
the provider says the address is verified and they have verified it in Guard too, so anyone who
could sign up at the provider with that address cannot take over the account. Without
[email](#email) nobody can verify an address in Guard, so existing accounts stay with their
passwords.

If the provider is down, its button says so, and everything else keeps working. People already
signed in stay signed in, because Guard asks the provider nothing except when someone uses that
button or the provider signs someone out. With the back-channel logout URI registered, signing out
at the provider ends the Guard sessions it started. Signing out of Guard leaves the provider's
session alone.

A member's picture shows when it comes from the provider's own host or from GitHub. From anywhere
else, the page's policy stops it and their initials show instead.

If Guard and the provider are both Workers, give each a
[Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#worker-to-worker-communication).
A Worker cannot reach another on its own zone through a route, and two on `workers.dev` cannot reach
each other at all: Cloudflare answers with error 1042, and the button says it could not reach the
provider. If they have to stay on `workers.dev`, add `global_fetch_strictly_public` to
`compatibility_flags` in each one's `wrangler.jsonc`.

## When someone deletes their account

People delete their own account on `/settings/account`, with no setting to turn on. The account,
its sessions and sign-ins, its memberships, the invitations it sent and the invitations addressed
to it are deleted from D1 at once. An account that is the only owner of a workspace is refused
until someone else owns it or it is deleted. The owner of the deployment is refused too while
sign-up is closed. Workspaces they belonged to stay with the people still in them. Cloudflare keeps
point-in-time recovery for D1 (30 days on Workers Paid, 7 on Free), and restoring D1 to a time
before a deletion brings the person back.

## Updating

```sh
git pull
pnpm install
pnpm run deploy
```

The deploy applies new D1 migrations before the new code goes live. A copy made with the button
shares no history with this repository, so `git pull` refuses there: a way to bring such a copy up
to a release is planned and not built yet. Guard is in early development. Read
[CHANGELOG.md](../CHANGELOG.md) before updating, as some releases change how things work.
