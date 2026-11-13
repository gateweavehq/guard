# Self-hosting

Gateweave Guard runs on your own Cloudflare account as one Worker. It is early: today it has
accounts, workspaces with members and invitations, and the empty screens that findings and
connections will fill. It uses:

- a D1 database for accounts, sessions, the list of workspaces and who runs the deployment;
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
| `BETTER_AUTH_URL`             | The address people use, such as `https://guard.example.com`. Inferred from each request when unset.                |
| `GITHUB_CLIENT_ID`            | Turns on "Sign in with GitHub", with `GITHUB_CLIENT_SECRET`.                                                       |
| `GITHUB_CLIENT_SECRET`        | The client secret of the same GitHub OAuth app.                                                                    |
| `OIDC_ISSUER`                 | Turns on an OpenID Connect provider, with the two below. See [below](#sign-in-through-an-openid-connect-provider). |
| `OIDC_CLIENT_ID`              | This deployment's client ID at the provider.                                                                       |
| `OIDC_CLIENT_SECRET`          | Its client secret there.                                                                                           |
| `OIDC_PROVIDER_NAME`          | What the sign-in button calls it. Unset: "single sign-on".                                                         |
| `EMAIL_FROM`                  | Turns on email (invitations, password reset), such as `Gateweave Guard <guard@example.com>`.                       |
| `LEGAL_NOTICE_URL`            | The address of your legal notice. See [below](#your-legal-pages).                                                  |
| `PRIVACY_POLICY_URL`          | The address of your privacy policy.                                                                                |
| `TERMS_URL`                   | The address of your terms.                                                                                         |
| `DURABLE_OBJECT_JURISDICTION` | Keeps the Durable Objects in `eu`, `us`, `fedramp` or `fedramp-high`. Unset: no jurisdiction.                      |
| `SIGN_UP_REQUEST_URL`         | An https address that "Ask for access" leads to once the owner closes sign-up. Unset: no link.                     |

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
