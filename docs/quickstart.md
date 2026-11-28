# Quickstart

Following this page on 26 November 2026 took about 3 minutes, from a fresh clone to a signed-in
first account with a workspace, on the Connections page and ready to connect a Cloudflare account.
It started from an empty package cache. It did not count installing the tools below or signing in
to Cloudflare.

Step 3 and steps 10 to 12 were not timed. Step 3 opens your browser to sign in to your own
Cloudflare account. Steps 10 to 12 need a token that you make in your own Cloudflare account. The
timed run set a token in the environment in place of step 3.

This is the shortest path: no custom domain, no sign-in provider and no email. The rest is in
[self-hosting.md](self-hosting.md).

## What you need

- A Cloudflare account on the Workers Paid plan. The Free plan gives a request too little CPU for a
  password sign-in; [self-hosting.md](self-hosting.md) has the details.
- [Git](https://git-scm.com/downloads).
- [Node.js](https://nodejs.org) 24, the version in `.node-version`, and [pnpm](https://pnpm.io/installation) 12.
- A browser, for signing in to Cloudflare and for Guard itself.

## Steps

1. Get the code.

   ```sh
   git clone https://github.com/gateweavehq/guard.git
   cd guard
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Cloning into 'guard'...
   ...
   ```

   </details>

2. Install the dependencies.

   ```sh
   pnpm install
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Scope: all … workspace projects
   ✓ Lockfile passes supply-chain policies (verified … ago)
   Lockfile is up to date, resolution step is skipped
   Packages are hard linked from the content-addressable store to the virtual store.
     Content-addressable store is at: …
     Virtual store is at:             node_modules/.pnpm
   Downloading @cloudflare/workerd-…: 0.00 B/… MB
   ...
   Progress: resolved …, reused 0, downloaded …, added …
   ...
   Packages: +…
   ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
   Progress: resolved …, reused 0, downloaded …, added …, done
   .../esbuild@…/node_modules/esbuild postinstall$ node install.js
   .../node_modules/workerd postinstall$ node install.js
   ...
   .../node_modules/workerd postinstall: Done
   ...

   devDependencies:
   + @biomejs/biome …
   + typescript …

   Done in …s using pnpm v…
   ```

   With an empty package cache, as in the timed run, pnpm downloads every package, so you see the
   lockfile lines, the `Downloading` and `Progress` lines and the `postinstall` lines. With a full
   cache, most of them are not there. The counts, the versions, the paths and the time differ from
   release to release and from machine to machine. The timed run took about 17 seconds.

   </details>

3. Sign in to Cloudflare. Wrangler, the Cloudflare command-line tool, opens your browser; approve
   its request there.

   ```sh
   pnpm wrangler login
   ```

   <details>
   <summary>Expected output</summary>

   ```text
    ⛅️ wrangler … (update available …)
   ───────────────────────────────────────────────
   Attempting to login via OAuth...
   Opening a link in your default browser: https://dash.cloudflare.com/oauth2/auth?...
   Successfully logged in.
   ```

   The first line is Wrangler's banner, which every Wrangler command prints. It says "update
   available" when a newer Wrangler exists. You can ignore that: Guard pins the one it uses.

   </details>

4. Choose names for a fresh deployment, then deploy. If your Cloudflare login can reach more than
   one account, first run
   `pnpm wrangler whoami` to see them with their ids, then set `CLOUDFLARE_ACCOUNT_ID` to the one to
   deploy to: `export CLOUDFLARE_ACCOUNT_ID=<id>` in a POSIX shell, `$env:CLOUDFLARE_ACCOUNT_ID="<id>"`
   in PowerShell. The deploy runs some Wrangler commands with their output captured, and there
   Wrangler cannot ask which account to use, so it stops.

   **Choose an unused Worker name and an unused D1 database name in the selected account.** The
   defaults are both `gateweave-guard`. To change them, edit `name` and `database_name` at the top
   of `wrangler.jsonc`. The Worker's name is also the first part of its address. Leave the names
   under `env` for Gateweave's own deployments.

   If the database selected by the configuration already exists, the deploy applies Guard's
   migrations to it before checking whether the Worker exists. An existing Worker with a
   `BETTER_AUTH_SECRET` can have its code replaced while keeping its secrets. To upgrade a
   Guard you already run, see [Updating](self-hosting.md#updating).

   ```sh
   pnpm run deploy
   ```

   With fresh names, the deploy builds Guard, creates the database and the Durable
   Object class, makes the secret that signs sessions (`BETTER_AUTH_SECRET`) and never shows it,
   and then applies the database migrations. If your account has no workers.dev subdomain yet,
   Wrangler asks "Would you like to register a workers.dev subdomain now?": say yes. After the
   deploy, before it applies the migrations, Wrangler asks "Your database may not be available to
   serve requests during the migration, continue?": answer yes. If the deploy stops with an error,
   act on what the message says.

   <details>
   <summary>Expected output</summary>

   ```text
   $ pnpm --filter @gateweave/guard-web run deploy
   $ node scripts/deploy.mjs
   (!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, …
     - import "./scripts/dev-secrets" without a file extension (vite.config.ts:…). Add the file extension
   Set `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` to suppress this warning.
   ...
   vite v… building client environment for production...
   ...
   ✓ … modules transformed.
   ...
   ✓ built in …
   vite v… building ssr environment for production...
   ...
   ▲ [WARNING] Missing required secrets: BETTER_AUTH_SECRET. Add them to .dev.vars, .env, or set as environment variables.
   ...
   ✓ built in …
    ⛅️ wrangler … (update available …)
   ───────────────────────────────────────────────
   Using redirected Wrangler configuration.
   ...
   Attaching additional modules:
   ┌──────────────────────┬──────┬──────────┐
   │ Name                 │ Type │ Size     │
   ...
   Uploaded … of … assets
   ✨ Success! Uploaded … files (… sec)

   Total Upload: … KiB / gzip: … KiB
   The following bindings need to be provisioned:
   Binding        Resource
   env.DB         D1 Database

   Provisioning DB (D1 Database)...
   Resource name found in config: gateweave-guard
   🌀 Creating new D1 Database "gateweave-guard"...
   ✨ DB provisioned 🎉
   🎉 Resources provisioned, continuing with deployment...
   Durable Object exports reconciliation:
     Created: RateLimiter
   Worker Startup Time: … ms
   Your Worker has access to the following bindings:
   Binding                                    Resource
   env.RATE_LIMITER (RateLimiter)             Durable Object
   env.EMAIL (unrestricted)                   Send Email
   env.DB (gateweave-guard)                   D1 Database
   env.BETTER_AUTH_SECRET ("(hidden)")        Environment Variable
   Uploaded gateweave-guard (… sec)
   Deployed gateweave-guard triggers (… sec)
     https://gateweave-guard.<your-subdomain>.workers.dev
     schedule: 29 3 * * *
     schedule: 0 * * * *
   Current Version ID: …
    ⛅️ wrangler … (update available …)
   ───────────────────────────────────────────────
   Resource location: remote
   Migrations to be applied:
   ┌─────────────────────────┐
   │ name                    │
   ├─────────────────────────┤
   │ 0000_init.sql           │
   ...
   │ 0011_track_connect.sql  │
   └─────────────────────────┘
   ? About to apply 12 migration(s)
   Your database may not be available to serve requests during the migration, continue? › yes
   🌀 Executing on remote database DB (…):
   ...
   │ 0011_track_connect.sql  │ ✅     │
   └─────────────────────────┴────────┘
   ```

   The Vite note about its config loader can appear more than once, and the build can print timing
   notes. All of it can be ignored. So can the warning about `BETTER_AUTH_SECRET`: the deploy makes
   that secret right after the build. The module table before `Total Upload` is long. The address
   is in the middle of the log, on the line after `Deployed … triggers`, and it is yours: the
   migrations come after it. Wrangler lists them, asks the question, and you answer yes. It then
   prints the migration table again as each one is applied, with a clock in place of a tick for
   those still waiting; the last table has a tick on every row. The number of migrations grows
   with releases. Versions, sizes and times differ. The timed run took about 72 seconds.

   </details>

5. Check the key that seals tokens. If Guard already has a working `SECRETS_KEY`, keep it and
   skip steps 5 and 6. If a deployment with existing connections has a missing or invalid key,
   restore the original value from backup using the command in step 6. When the connections list
   is empty and the key is missing or invalid, follow steps 5 and 6 to set a new key.
   `pnpm wrangler secret list` shows which secrets the Worker has. To rotate a key, see "Changing it" in
   [Connections and SECRETS_KEY](self-hosting.md#connections-and-secrets_key).

   `SECRETS_KEY` is 32 random bytes in base64, and this prints one.

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

   Copy the line into your password manager now, before you go on. Guard seals every token you
   connect under this key and keeps it nowhere else. Each sealed token carries the id of the key
   that sealed it, and Guard opens it only with that key (`SECRETS_KEY`, or `SECRETS_KEY_PREVIOUS`
   while a key is being changed). Without the key Guard cannot open the tokens it stored: each
   connection then says it needs attention, and an admin has to give it a new token. Nobody else
   needs to see it.

   <details>
   <summary>Expected output</summary>

   ```text
   q3Vq0m1hNn2m7u5g8Zr4Xk9bYt6cJd1fLw3sPa0eHxA=
   ```

   One line of 44 characters, ending in `=`. Yours differs: it is random.

   </details>

6. Give the new or restored key to the Worker. Wrangler asks for the value and hides what you type.
   This command replaces a key already stored on the Worker, so check the value against step 5.

   ```sh
   pnpm wrangler secret put SECRETS_KEY
   ```

   If you changed the Worker's name in step 4, Wrangler uses the changed name.

   <details>
   <summary>Expected output</summary>

   ```text
   $ pnpm --filter @gateweave/guard-web exec wrangler --cwd ../.. "secret" "put" "SECRETS_KEY"
    ⛅️ wrangler … (update available …)
   ───────────────────────────────────────────────
   ▲ [WARNING] Multiple environments are defined in the Wrangler configuration file, but no target environment was specified for the secret put command.
   ...
   ? Enter a secret value: ›
   🌀 Creating the secret for the Worker "gateweave-guard"
   ✨ Success! Uploaded secret SECRETS_KEY
   ```

   The warning can be ignored: the environments it means are Gateweave's own, and the key goes to
   the Worker you deployed. The timed run took about 4 seconds.

   </details>

7. Open the address from step 4 in your browser. Guard sends you on to `/login`, headed **Sign in
   to Gateweave Guard**; choose **Create an account**, enter a name, an email address and a
   password of at least 8 characters, then choose **Create account**. Guard sends no email and
   asks for no confirmation, so any address will do.

   This server is open until you change it: anyone who reaches the address can make an account, and
   the first one, yours, owns the deployment. Do this step before you share the address. To let in
   only people you choose, see [Who may sign up](self-hosting.md#who-may-sign-up).

   <details>
   <summary>Expected output</summary>

   The login page reads "Sign in to Gateweave Guard", with **Email**, **Password**, **Sign in** and
   "New to Gateweave Guard?" beside **Create an account**. After you create the account you are
   signed in at once and taken back to the address itself, `/`. The page is headed **Workspaces**,
   with "Signed in as" and your address under it, **Your account** and **Sign out**, and "You are
   not in any workspace yet." above a **New workspace** form with **Name** and **URL**.

   </details>

8. Under **New workspace**, enter a name such as `Acme` (the URL fills in as `acme`) and choose
   **Create workspace**.

   <details>
   <summary>Expected output</summary>

   The workspace opens at `/acme/findings`, headed **Findings**, with "No findings yet." and
   "Connect a Cloudflare account or a GitHub repository to start." under it, and a **Connections**
   button. The sidebar lists Findings, Protection, Traffic, Connections, Settings and Server.

   </details>

9. In the sidebar, choose **Connections**.

   <details>
   <summary>Expected output</summary>

   The page, at `/acme/connections`, is headed **Connections**. It says "Nothing connected yet."
   and "Connect a Cloudflare account or a GitHub repository, and Guard starts reading.", and offers
   **Connect a Cloudflare account** and **Connect a GitHub repository**. If it says instead "This
   server is not set up to keep tokens, so nothing can be connected.", act on what it says: Guard
   has no usable `SECRETS_KEY`. It is missing, or it is shorter than 32 bytes. If the deployment
   already has connections, restore its original key from backup. If the connections list is
   empty, follow steps 5 and 6 and paste the whole line that step 5 prints.

   </details>

<!-- timed run stops here -->

10. Make a read-only token in the Cloudflare dashboard. Choose **Connect a Cloudflare account**: the
    form links to the page where an account API token is made. In Cloudflare, create an account
    API token from a custom one, give it these three permissions, and nothing more:
    - Account › Security Center Insights › Read
    - Zone › Security Center Insights › Read
    - Zone › Analytics › Read

    Set the account resources to your account, and the zone resources to all zones from that
    account. Create the token and copy it: Cloudflare shows it once. Also copy your account id,
    32 characters, which is in the dashboard's address and at the foot of an account's overview.
    `pnpm wrangler whoami` lists your accounts with their ids too.

    Without the second permission Cloudflare leaves out every insight about the account's domains,
    and without the third Guard cannot count what the WAF and bots did to each zone (the Traffic
    page). Guard only reads. Three more read permissions are optional, all on all zones, for the
    Protection page: Zone › WAF › Read, Zone › Bot Management › Read and Zone › Zone Settings ›
    Read. Without one, Protection says which is missing and the rest works.

    <details>
    <summary>Expected output</summary>

    Cloudflare shows the new token's value once, and the token's name in its list of tokens. The
    dashboard's layout changes from time to time; the permission names above are the ones Guard's
    own form and error messages use.

    </details>

11. In the form, enter the account id under **Account id**, the token under **Token**, and
    optionally a **Name**, then choose **Check and connect**. Guard asks Cloudflare whether the
    token works, seals it under `SECRETS_KEY`, and runs the first scan while you wait.

    <details>
    <summary>Expected output</summary>

    A message says "Connected." and the connection appears in the list: its name (the account id,
    unless you gave one), "Cloudflare account", the account id and "Token …" with the token's last
    four characters. When the first scan succeeds, the row says "The last scan went well." and
    shows the last and next scan times and a link such as "0 open findings". If that scan fails,
    read its status in the connection row. If Cloudflare refuses the token during the connection
    check, the form says what is wrong, such as which permissions it needs, and keeps nothing.

    </details>

12. In the sidebar, choose **Findings**.

    <details>
    <summary>Expected output</summary>

    Each finding shows its severity, its title, what it is about, "From" and the connection's
    name, when it was first seen, and an **Open in Cloudflare** link. If there is none, the page
    says "No open findings." and "Everything Guard reads from your connections is in order."

    </details>

## What a new account shows

Guard shows what Cloudflare's Security Center Insights lists for the account, so a connection can
only show what Cloudflare already found. An account with no domains, which is what a new one has,
may well show no findings: the Findings page says "No open findings.", Traffic says "Guard has not
listed this account's zones yet." and Protection says "Guard has not listed any zone yet. The next
scan does." Those two pages stay that way until the account has a zone. Cloudflare may also take
time to produce insights for a new account or a new zone, and the code does not say how long.

Guard scans each connection once a day, and every hour it scans the ones whose day has come. To read
again sooner, choose **Scan now** on the connection; it works once in five minutes for each
connection. The first scan of a new connection sends no alert email, since it finds what was
already there.

## Next

- [self-hosting.md](self-hosting.md#connections-and-secrets_key): connect a GitHub repository with
  a fine-grained token, what each token needs, and how to change `SECRETS_KEY`.
- [mcp.md](mcp.md): ask an AI assistant what is wrong in your account, once `BETTER_AUTH_URL` names
  your address.
