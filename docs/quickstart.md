# Quickstart

About N minutes from a fresh clone gets you Guard on your own Cloudflare account, at a workers.dev
address, deployed from the command line, with `SECRETS_KEY` set and you signed in as its first
account. A few minutes more connects your Cloudflare account with a read-only token you make, and
Guard shows what it found.

This is the shortest path: no custom domain, no sign-in provider and no email. The rest is in
[self-hosting.md](self-hosting.md). The time counts the steps before you make the token, because
that happens in the Cloudflare dashboard and the token is yours; the last two steps are not timed.

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
   ```

   </details>

2. Install the dependencies.

   ```sh
   pnpm install
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Packages: +371
   ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
   Progress: resolved 371, reused 0, downloaded 371, added 371, done

   devDependencies:
   + @biomejs/biome 2.6.8
   + typescript 7.0.2

   Done in 40s using pnpm v12.4.2
   ```

   The counts and the time differ a little from release to release and from machine to machine.

   </details>

3. Sign in to Cloudflare. Wrangler, the Cloudflare command-line tool, opens your browser; approve
   its request there.

   ```sh
   pnpm wrangler login
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Attempting to login via OAuth...
   Opening a link in your default browser: https://dash.cloudflare.com/oauth2/auth?...
   Successfully logged in.
   ```

   </details>

4. Deploy. If your Cloudflare login can reach more than one account, first run
   `pnpm wrangler whoami` to see them with their ids, then set `CLOUDFLARE_ACCOUNT_ID` to the one to
   deploy to: `export CLOUDFLARE_ACCOUNT_ID=<id>` in a POSIX shell, `$env:CLOUDFLARE_ACCOUNT_ID="<id>"`
   in PowerShell. The deploy runs some Wrangler commands with their output captured, and there
   Wrangler cannot ask which account to use, so it stops.

   ```sh
   pnpm run deploy
   ```

   Nothing needs setting first. The deploy builds Guard, creates the database and the Durable
   Object class, makes the secret that signs sessions (`BETTER_AUTH_SECRET`) and never shows it,
   and then applies the database migrations. If your account has no workers.dev subdomain yet,
   Wrangler offers to register one: say yes. Before it applies the migrations, Wrangler asks "Your
   database may not be available to serve requests during the migration, continue?": answer yes.

   The Worker and the database are both called `gateweave-guard`, from `name` and `database_name`
   at the top of `wrangler.jsonc`. To use other names, change those two before this step. The
   Worker's name is also the first part of its address. Leave the ones under `env`: they are
   Gateweave's own deployments. If your account already has a Worker or a D1 database under those
   names, the deploy does not make new ones: it applies the migrations to that database and deploys
   over that Worker, keeping the secrets it already has. To keep a new Guard apart from them,
   choose other names first.

   <details>
   <summary>Expected output</summary>

   ```text
   vite v8.3.8 building client environment for production...
   ✓ built in 18s
   vite v8.3.8 building ssr environment for production...
   ▲ [WARNING] Missing required secrets: BETTER_AUTH_SECRET. Add them to .dev.vars, .env, or set as environment variables.
   ✓ built in 6s
   ...
   Total Upload: 4540.59 KiB / gzip: 1052.34 KiB
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
   Worker Startup Time: 68 ms
   Your Worker has access to the following bindings:
   Binding                                    Resource
   env.RATE_LIMITER (RateLimiter)             Durable Object
   env.EMAIL (unrestricted)                   Send Email
   env.DB (gateweave-guard)                   D1 Database
   env.BETTER_AUTH_SECRET ("(hidden)")        Environment Variable
   Uploaded gateweave-guard (14.84 sec)
   Deployed gateweave-guard triggers (2.44 sec)
     https://gateweave-guard.<your-subdomain>.workers.dev
     schedule: 29 3 * * *
     schedule: 0 * * * *
   Current Version ID: 01f37d43-a8a9-4537-9638-ed4a5d75bcf4
    ⛅️ wrangler 4.166.0
   ───────────────────────────────────────────────
   Resource location: remote
   Migrations to be applied:
   ? About to apply 12 migration(s)
   Your database may not be available to serve requests during the migration, continue? › yes
   ...
   │ 0011_track_connect.sql  │ ✅     │
   ```

   The build also prints a Vite note about its config loader; it can be ignored. So can the
   warning about `BETTER_AUTH_SECRET`: the deploy makes that secret right after the build. The
   address on the line after `Deployed` is yours. The migration table lists every migration with a
   tick; the last one is shown above. Versions, sizes and times differ. A deploy takes a minute or
   two.

   </details>

5. Make the key that seals tokens. `SECRETS_KEY` is 32 random bytes in base64, and this prints one.

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

   Copy the line into your password manager now, before you go on. Guard seals every token you
   connect under this key and keeps it nowhere else. Without it Guard cannot open the tokens it
   stored: each connection then says it needs attention, and an admin has to give it a new token.
   Nobody else needs to see it.

   <details>
   <summary>Expected output</summary>

   ```text
   q3Vq0m1hNn2m7u5g8Zr4Xk9bYt6cJd1fLw3sPa0eHxA=
   ```

   One line of 44 characters, ending in `=`. Yours differs: it is random.

   </details>

6. Give the key to the Worker. Wrangler asks for the value; paste the line from the last step. What
   you type is not shown.

   ```sh
   pnpm wrangler secret put SECRETS_KEY
   ```

   If you changed the Worker's name in step 4, Wrangler uses the changed name.

   <details>
   <summary>Expected output</summary>

   ```text
   ▲ [WARNING] Multiple environments are defined in the Wrangler configuration file, but no target environment was specified for the secret put command.
   ...
   ? Enter a secret value: ›
   🌀 Creating the secret for the Worker "gateweave-guard"
   ✨ Success! Uploaded secret SECRETS_KEY
   ```

   The warning can be ignored: the environments it means are Gateweave's own, and the key goes to
   the Worker you deployed.

   </details>

7. Open the address from step 4 in your browser. Guard sends you on to `/login`, titled **Sign in to Gateweave Guard**; choose
   **Create an account**, enter a name, an email address and a password of at least 8 characters,
   then choose **Create account**. Guard sends no email and asks for no confirmation, so any
   address will do.

   This server is open until you change it: anyone who reaches the address can make an account, and
   the first one, yours, owns the deployment. Do this step before you share the address. To let in
   only people you choose, see [Who may sign up](self-hosting.md#who-may-sign-up).

   <details>
   <summary>Expected output</summary>

   You are signed in at once and taken back to the address itself, `/`. The page is titled
   **Workspaces**, with "Signed in as"
   and your address under it and "You are not in any workspace yet." below.

   </details>

8. Under **New workspace**, enter a name such as `Acme` (the URL fills in as `acme`) and choose
   **Create workspace**.

   <details>
   <summary>Expected output</summary>

   The workspace opens at `/acme`, which sends you on to `/acme/findings`, titled **Findings**, with "No findings
   yet." and "Connect a Cloudflare account or a GitHub repository to start." under it, and a
   **Connections** button. The sidebar lists Findings, Protection, Traffic, Connections, Settings
   and Server.

   </details>

9. In the sidebar, choose **Connections**.

   <details>
   <summary>Expected output</summary>

   The page is titled **Connections**, says "Nothing connected yet." and offers **Connect a
   Cloudflare account** and **Connect a GitHub repository**. If it says instead "This server is not
   set up to keep tokens, so nothing can be connected.", Guard does not have `SECRETS_KEY` yet: go
   back to step 6.

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
    four characters. Under it, "The last scan went well.", the time of the last and next scan, and
    a link such as "0 open findings". If Cloudflare refuses the token, the form says in a sentence
    what is wrong, such as which permissions it needs, and keeps nothing.

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
