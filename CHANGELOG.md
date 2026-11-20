# Changelog

Notable changes to Gateweave Guard, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org). Until 1.0, any release may change how things work:
read its entry before updating a self-hosted copy.

Each version's [GitHub release](https://github.com/gateweavehq/guard/releases) carries the same
notes. Publishing a release deploys it.

## [0.6.0] - 2026-11-20

Guard can now connect to Gateweave Track with one approval, instead of a source key copied by hand.
It needs Track 0.45.0 or later for that, and the paste field stays for older Tracks. This release
adds a D1 migration.

### Added

- **Connect Track.** In Guard's Track settings, an owner or admin chooses **Connect Track** beside
  a connection, then picks the workspace and team in Track and approves. Guard receives the
  source's key straight from Track, through a one-time code and its own PKCE verifier, and seals
  it. Nobody sees or copies the key. Like a pasted key, the first one switches the workspace from
  filing by hand to reporting.
  - **Interruptions:** each step survives a lost answer or a slow request. A later paste,
    removal or "Stop reporting" wins over an approval still on its way.
  - **Undo:** an approval that Guard cannot save is undone at Track, and the daily run retries
    the undo until Track's deadline. Guard never undoes a source whose key it has installed.
    ([#39](https://github.com/gateweavehq/guard/pull/39))
- **`pnpm secrets:key-id`** prints the id of a `SECRETS_KEY` piped to it, never the key itself, to
  match against the daily `secrets:` log line.

### Changed

- **Key rotation's log line names the key pair:**
  `secrets: primary=<id> previous=<id|none> resealed=… unopened=… left=… settled=…`. `settled=true`
  now needs a previous key, a run that resealed nothing and left nothing, and the pair first seen
  at least an hour before the run, so a Worker of the previous deploy can no longer write under
  the old key. Remove `SECRETS_KEY_PREVIOUS` only after such a line.

### If you run your own

- `pnpm run deploy` applies the D1 migration (`0011_track_connect`).
- **Connect Track needs Track 0.45.0 or later,** and Guard served over HTTPS. Against an older
  Track, keep pasting source keys.
- **If you are rotating `SECRETS_KEY`,** wait for a `settled=true` line from this version before
  removing the previous key: a line from an older version does not count.

## [0.5.0] - 2026-11-20

Guard can now report its findings to Gateweave Track on its own, as a Track source, instead of
someone filing each one. It needs Gateweave Track 0.44.0 or later. This release adds a D1
migration.

### Added

- **Automatic reporting to Track.** In Track, make a source for each Guard connection (product
  `guard`, Guard's address as a link origin) and paste its key beside the connection in Guard's
  Track settings. From then on, after every scan and whenever someone dismisses or restores a
  finding, Guard sends Track each finding whose state or severity changed: open, cleared or
  dismissed. Track decides what becomes an issue, by the source's lowest severity, and can assign
  it to an agent; the finding's "File in Track" becomes "Open in Track".
  - Settings show each connection's last answer from Track, in words. After seven days of Track
    not knowing a key, Guard stops sending for that connection and says so; a new key starts it
    again.
  - Saving the first source key switches the workspace from filing by hand to reporting, and
    removes its agent key and fix label. Issues already filed keep their links. "Stop reporting"
    removes every source key and lets the workspace connect again either way.
  - Guard sends at most 50 events a minute per connection, clears and dismissals first, so a
    refused open never holds them back.
  - A workspace that saves no source key keeps filing by hand as before.
    ([#37](https://github.com/gateweavehq/guard/pull/37))

### If you run your own

- `pnpm run deploy` applies the D1 migration (`0010_track_sources`).
- Reporting needs Track 0.44.0 or later. Against an older Track, every event gets a 404, and
  after seven days Guard stops sending for that connection until a new key is pasted.

## [0.4.1] - 2026-11-19

Better Auth, which runs sign-in and Guard's MCP server, is updated to 1.7.25. There is no migration
in this release.

### Changed

- **Better Auth 1.7.25** (from 1.7.20), the version Gateweave ID runs. Among its fixes: an
  assistant's token request that fails a check no longer uses up its code, and a session's
  cookies are cleared when the session is revoked.
  ([#33](https://github.com/gateweavehq/guard/pull/33))
- **A bad or expired token at `/mcp` is answered with `error="invalid_token"`**, as RFC 6750
  asks and Better Auth's own servers answer, so an assistant knows to refresh rather than start
  over. A token whose access was taken back gets the same words. A request with no token is
  answered as before.

### If you run your own

No migration, variable or secret. Deploy as usual.

## [0.4.0] - 2026-11-19

A copy made with the Deploy button can now be updated to a new release, and the sign-in page no
longer sends anyone to another site. There is no migration in this release.

### Added

- **Update a copy made with the Deploy button.** Such a copy has no shared Git history, so
  `git pull` cannot bring it to a new release. `scripts/update-copy.mjs` applies a release to it
  and keeps the copy's own Worker, D1 binding and workflow; `docs/self-hosting.md` says how.
  ([#24](https://github.com/gateweavehq/guard/pull/24))
- **The script says why it stopped.** A refused merge stops with Git's own reason, a squash left
  staged by an interrupted update tells you to reset first, and an `upstream` remote that is not
  Guard is refused before anything is fetched.
  ([#27](https://github.com/gateweavehq/guard/pull/27))

### Fixed

- **The page you return to after signing in stays on Guard.** A return path such as
  `/.//example.com/x` passed the check and then, once its dot segments were resolved, pointed to
  another site. Such a path is now refused, and an ordinary `..` that stays on Guard still works.
  ([#26](https://github.com/gateweavehq/guard/pull/26))
- **A scan that ran but could not be saved says so.** "Scan now" and an assistant's `start_scan`
  used to answer that a scan was already running. They now say the scan ran and what it found
  could not be saved. Such a connection waits an hour before its next scan, then a day if it
  fails again, instead of coming back every hour ahead of the others. Connecting an account that
  fails for another reason is no longer called a duplicate.
  ([#25](https://github.com/gateweavehq/guard/pull/25))
- **Guard has its own icon** in place of Mail's envelope, on the tab, the home screen and the
  README.

### If you run your own

- **Update.** No migration, variable or secret is needed.
- **A copy made with the Deploy button** can take this release with the commands under
  "Updating" in `docs/self-hosting.md`. They run the script from Guard's repository, so the copy
  does not need it first.

## [0.3.2] - 2026-11-16

Puts back a guard that v0.3.1 dropped by mistake. There is no migration in this release.

### Fixed

- **A server function's request from another origin is refused again.** The framework refuses
  such a request unless the browser says it comes from the app's own origin. v0.3.1 added a file
  that replaced the framework's default without listing that guard, so for a few hours it did not
  run. Guard's server functions only read, and what changes anything goes through routes with
  their own origin check, so nothing could be changed through the gap; a link on another site
  could have run a read whose answer only the person's own browser saw.
  ([#22](https://github.com/gateweavehq/guard/pull/22))

### If you run your own

- **If you run v0.3.1, update.**

## [0.3.1] - 2026-11-16

A database read that fails in passing is asked again instead of becoming an error, and a query
that fails for good no longer logs or answers with its values. There is no migration in this
release.

### Fixed

- **An error because one database read failed.** When a single read from D1 failed, a page, a
  scan step or an assistant's call was an error although asking again would have worked. A plain
  read (one `SELECT` statement) that fails with one of the errors Cloudflare documents as passing
  is now sent up to three times, a moment apart. Writes, batches and any other error are sent
  once, as before. ([#20](https://github.com/gateweavehq/guard/pull/20))
- **A failed database query no longer carries its values.** When a query failed for good, the
  error held the statement and its values. Replacing a connection's token could log the token in
  its encrypted form with its last four characters, a failed read of a session or a refresh token
  was logged with its value, and `/mcp` could answer an assistant with the database's own
  message. A failure now carries a reference only. The log has the kind of failure and the
  statement without its values under the same reference; a page shows a plain sentence with it.
  To see whether a server ever logged one, search its logs for `Failed query:`.
  ([#20](https://github.com/gateweavehq/guard/pull/20))

### If you run your own

- **Nothing to do.** If a page shows a reference, the line with the same reference in the
  Worker's logs says what failed.

## [0.3.0] - 2026-11-14

A person can see the AI assistants they allowed and take one back, effective at once.

### Added

- **Assistants you allowed.** Settings, AI assistant, lists each app the person let act as them:
  the name it gave itself, where it goes ("an app on this computer" for one on their own machine),
  when it was allowed and last used. "Take back" ends its access at once: its tokens and the
  consent go, and `/mcp` checks the consent on every call, so even an access token that hasn't
  expired is refused, and the app has to ask again. Every role sees it.
  ([#17](https://github.com/gateweavehq/guard/pull/17))

### Changed

- The daily clean-up also deletes OAuth clients that registered themselves more than a day ago and
  that nobody allowed. ([#17](https://github.com/gateweavehq/guard/pull/17))

### If you run your own

- Nothing to do: no migration and no new setting.

## [0.2.0] - 2026-11-14

Guard can now be used from an AI assistant. A person pastes Guard's `/mcp` address into Claude
Code, Claude or any assistant that speaks MCP, signs in and allows it, and the assistant can read
their findings and traffic, and do what their role lets them on the pages.

### Added

- **An MCP server at `/mcp`.** Signed in through OAuth, with no key to copy: the assistant
  registers itself, the person signs in and sees a consent page that names the app and where the
  grant goes. A token acts as the person who allowed it, in every workspace they belong to, and
  each call checks their membership. Tools: `list_workspaces`, `list_findings` (the page's
  filters, with a cursor), `get_finding`, `traffic_summary`, and for owners and admins
  `dismiss_finding` (with a reason) and `start_scan`. No answer carries a token, its hint or a
  rule's expression. Session cookies are never accepted there, and calls are rate limited per
  person and app. Settings has an "AI assistant" tab with the address and the `claude mcp add`
  line. ([#15](https://github.com/gateweavehq/guard/pull/15))

### If you run your own

- The migration `0009_mcp_oauth.sql` adds the tables of the OAuth plugins; `pnpm run deploy`
  applies it.
- `/mcp` is on only when `BETTER_AUTH_URL` is set to the address people open Guard at. See
  [docs/self-hosting.md](docs/self-hosting.md).

## [0.1.0] - 2026-11-14

The first release of Gateweave Guard: security in one place for teams on Cloudflare. It reads a
Cloudflare account and GitHub repositories with read-only tokens, shows what is wrong, what
protects each zone and what got blocked, tells people when something new and serious appears, and
turns a finding into an issue in Gateweave Track. It never changes a setting, a rule or a file.

### Added

- **Workspaces and sign-in.** Email and password, or an OpenID Connect provider such as Gateweave
  ID; workspaces with owners, admins and members; invitations; a deployment owner who decides who
  may make an account. ([#1](https://github.com/gateweavehq/guard/pull/1))
- **Connections and findings.** A Cloudflare account connects with a read-only API token (Account
  and Zone Security Center Insights Read, Zone Analytics Read), a GitHub repository with a
  fine-grained token that reads Contents. Tokens are checked, sealed with `SECRETS_KEY` and never
  shown again. Scans run every day and on "Scan now", and list Security Insights and known
  vulnerabilities in pnpm and npm lockfiles (from OSV) as findings by severity, which close by
  themselves when a scan no longer sees them.
  ([#2](https://github.com/gateweavehq/guard/pull/2), [#4](https://github.com/gateweavehq/guard/pull/4),
  [#5](https://github.com/gateweavehq/guard/pull/5))
- **Traffic.** Daily counts of what the WAF and bot protection stopped or challenged in each zone,
  by action, rule, country and host, kept 90 days, with a finding when a zone's WAF stops far more
  than usual. Never IPs, user agents or paths.
  ([#7](https://github.com/gateweavehq/guard/pull/7))
- **Protection.** What protects each zone, in plain words: WAF managed rules, custom rules and what
  each did, rate limiting, Bot Fight Mode and Under Attack mode, with "Fix in Cloudflare" links and
  an overview across zones. Three more read permissions turn it on; a rule's expression is never
  stored. ([#9](https://github.com/gateweavehq/guard/pull/9), [#11](https://github.com/gateweavehq/guard/pull/11))
- **Alerts.** A count of new findings in the sidebar, an email for new critical and high findings
  (at most one an hour per workspace), a weekly summary on Mondays, switches in Settings and a
  one-click unsubscribe. ([#10](https://github.com/gateweavehq/guard/pull/10))
- **From a finding to work.** Connect a Gateweave Track workspace with an agent member's key, and
  "File in Track" makes one issue per finding; for a dependency with a fixed version, "Ask Agents
  for a fix" adds the label a Gateweave Agents trigger watches.
  ([#12](https://github.com/gateweavehq/guard/pull/12))

### If you run your own

- See [docs/self-hosting.md](docs/self-hosting.md): it needs Workers Paid, a D1 database and, to
  connect anything, `SECRETS_KEY`. Keep a copy of `SECRETS_KEY` outside Cloudflare: without it, the
  tokens in the database and its backups cannot be opened.
