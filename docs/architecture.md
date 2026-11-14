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
  verification, invitations, and the alerts and weekly summary of "Notifications" below. Without
  it, invitations are links to share and nothing else is sent.
- **What is past its time** goes once a day, on a Cron Trigger every deployment inherits from
  `wrangler.jsonc` (`apps/web/src/server/db/prune.ts`). Better Auth removes a session or a
  verification only when something looks it up, so those nobody comes back for would otherwise
  stay, with the address and browser a session holds, an assistant's expired tokens with the person
  who approved them, and invitations with the address they were sent to. It also removes apps that
  registered themselves and were never allowed (see "MCP"). The privacy policy states the rest, so a
  change there is a change to it.
- **Security headers** go on every answer, and a page also gets a policy that names its scripts by
  a nonce of that response (`security-headers.ts`). Nothing is framed and no host is allowed by
  default; a member's picture may come from GitHub or the sign-in provider's own host.
- **Origin checks.** A request that changes something from a browser must carry this deployment's
  own `Origin`, which Better Auth checks for its routes.

What a workspace shows today is the shell and no more: a page each for **Findings** and
**Connections**, **Settings** (members, invitations, the workspace itself) and, for whoever runs
the deployment, **Server**. A workspace with nothing connected says so, and a workspace with
connections and nothing wrong says "No open findings." Guard reads from a Cloudflare account
or a repository only once an admin has connected it: see the next section.

### Connections, scans and findings

An owner or admin connects a **Cloudflare account** (its id and an account API token) or a **GitHub
repository** (`owner/name` and a fine-grained token). Everyone in the workspace sees the connections
and findings, without tokens. Guard only reads: it asks for the least access that reads (Account ›
Security Center Insights › Read, with Zone › Security Center Insights › Read and Zone › Analytics ›
Read on all the account's zones; Contents: Read-only on one repository), and nothing in it changes a
setting, a rule or a file. The endpoints are `/api/connections/<workspace>` and
`/api/findings/<workspace>` (`apps/web/src/server/connections/`), the pages are the Connections and
Findings screens, and the schemas both agree on are in `apps/web/src/lib/connection-schemas.ts`.

- **Every request asks first.** A change needs the app's own `Origin`, a session, and
  `isAdminRole` for the member's role; a non-member gets the same "not found" as a missing
  workspace. Input is checked with zod at the boundary: a Cloudflare account id is 32 hex
  characters, a repository goes through `parseRepositoryName`, a token is 20 to 400 printable
  characters without spaces, and a reason for dismissing is at most 200.
- **A token is checked before it is kept.** Cloudflare: one `listInsights` call, where a refusal
  names the permission Account › Security Center Insights › Read (Guard cannot read a Cloudflare
  token's own permissions, so a call that needs it is the only proof). The zone permission can't be
  proved this way: a token without it is accepted, and Cloudflare then answers with the account's
  own insights only, leaving out those of its zones (measured on 2026-11-14: 29 of an account's 111
  active insights, and none of its 4 critical ones). So the form asks for the permissions in words.
  The zone permission for Analytics is proved: the check also lists the account's zones and, when
  one is active, asks it a small real GraphQL question (`probeTraffic`), and a refusal there names
  Zone › Analytics › Read. GitHub: `getRepository`, then
  `branchHead`, which proves Contents read; the repository's id is kept, since a rename keeps it. A
  workspace has up to 50 connections (checked in the endpoint, held by the trigger
  `connection_is_capped` in `0004_connection_cap.sql`), each target once, and a repository once
  however its name is written (`connection_repository_unique`). Checking tokens is rate limited per
  workspace (20 at once, refilling over an hour), since each goes to a third party.
- **A token is sealed** (`secrets.ts`, `secrets-key.ts`, ported from Gateweave Mail). `SECRETS_KEY`
  is 32 random bytes; each use gets its own AES-256-GCM key by HKDF from it and the workspace's id,
  and the connection's id is the additional data (`connection/<id>/token`), so a sealed token copied
  into another row or workspace does not open. A seal is `v2.<key id>.<iv>.<data>`; the key id is a
  keyed digest of the key, so a seal names the key that opens it. `SECRETS_KEY_PREVIOUS` only opens.
  After the key changes, the daily run seals each token again under the new key
  (`reseal-secrets.ts`: up to 500 a run, in pages so tokens that open with neither key never hold up
  the rest, each written only if it is still the value that was read), and logs `secrets:` with
  counts only. Without a usable `SECRETS_KEY`, connecting is refused with the reason and the page
  says the server is not set up for it. A token is opened only inside a scan or a check, never
  returned: pages get `token_hint`, its last four characters. Nothing logs a token, and
  `packages/scan`'s errors carry the status and no body.
- **A scan reads, then writes in one D1 batch.** Cloudflare: `listInsights`, where an insight that is
  `active` and not `dismissed` in Cloudflare's dashboard is present. GitHub: `scanRepository`, one
  finding per lockfile, package and advisory. Each present problem has a **fingerprint**
  (`insightFingerprint`: account, class and subject; `dependencyFingerprint`: repository id,
  lockfile, package and advisory, without the installed version, so moving to another affected
  version is the same finding). A present finding that is new is inserted; one already known has its
  severity, title, subject, link and last-seen time updated and is **reopened** if it was resolved;
  an open one that is no longer present is **resolved**. What a scan could not see does not count as
  gone: a lockfile Guard cannot read or that is too large keeps its findings as they are, and so does
  a repository GitHub listed only in part. **A dismissed finding stays dismissed whatever a scan
  sees**, until an admin un-dismisses it, and so is kept up to date underneath. A scan that fails
  changes no finding, and records its kind on the connection (`unauthorized`, `forbidden` and
  `not_found` mean it needs attention, and the page says what to fix; `rate_limited` and
  `unavailable` are tried again within the hour; `unreadable` means the stored token no longer
  opens). The last 30 scans of a connection are kept, with how many problems were found, new and
  closed.
- **Findings hold what a page shows and nothing of what was read:** the severity, a kind (the
  insight's class, or the advisory's id), the subject (hostname or zone, or `package@versions in
  lockfile`), a title, a link, the fixed version, and when it was first and last seen, resolved and
  dismissed. No insight payload and no lockfile content is stored. The title of a Security Insight
  is Guard's own short English text per class (`server/connections/titles.ts`), since the API
  sometimes sends translation keys; a class Guard has not seen gets its name made readable. The
  link is the dashboard URL `packages/scan` builds, which can only point at `dash.cloudflare.com`,
  or the advisory on osv.dev. Removing a connection deletes its token, findings and scans at once,
  by foreign-key cascade.
- **Scans without a Queue.** The hourly Cron Trigger (`0 * * * *`) scans the connections whose
  `next_scan_at` has passed, oldest first, at most 10 a run, one after another, and then sets
  the next scan a day ahead (an hour ahead after a failure that passes with time). "Scan now" runs
  the scan inside the request, for admins, at most once in five minutes per connection (the
  `RateLimiter`). A connection is never scanned twice at once: a conditional `UPDATE` sets
  `scan_started_at` before the token is read, and only the scan that set it goes on; a scan that
  dies lets go by itself after ten minutes. There is no Queue because a self-hoster then gets no
  extra resource to create and pay for, and a scan is a few seconds and a handful of subrequests
  (one for Cloudflare; a few for GitHub plus OSV's batched lookups), which one Worker invocation
  carries. A Queue would be needed when scans stop fitting: more than 240 connections on one
  deployment (10 an hour), a repository whose scan outruns an invocation's CPU or subrequest limits,
  or scans that must not wait for the hour. Each scan would then be a message, with retries and
  backoff for the failures that pass with time, and the claim in D1 would stay as it is.
- **The first scan runs when the token is connected,** in that request, so the page has something
  to show; if it fails, the connection stays and says what failed.
- **An admin can replace a token** (`replace-token`): the new one is checked the same way, for the
  same repository, then sealed and scanned. It is how a connection that needs attention is mended
  without losing what has been dismissed.

### Traffic

Guard counts what a Cloudflare account's WAF and bot features did to each zone's requests, per UTC
day, and raises a finding when a zone's day is far above its usual. It needs the zone permission
Analytics › Read, on all zones. The code is `packages/scan/src/traffic.ts` (what is asked of
Cloudflare), `apps/web/src/server/connections/traffic.ts` (what a scan reads, judges and writes) and
`traffic-gateway.ts` with the Traffic page (what members see).

- **What is read.** After Insights, a scan lists the account's zones (REST `GET /zones`, paged;
  only `active` ones are kept). For the full UTC days not stored yet, from yesterday back to 8 days
  ago (so a first scan already has the week the spike rule needs), it reads
  `httpRequestsAdaptiveGroups` with `securityAction_neq: "unknown"`, grouped by `date`: counts by
  action and security feature, and the top 10 countries and hosts among the mitigated requests.
  Today is incomplete and is never read or stored. For yesterday only, and only for the 20 zones with
  the most acted-on requests, it reads the rules that acted, from sampled events
  (`firewallEventsAdaptive`): at most two pages of `min(10000, maxPageSize)`, each event weighted
  by its `sampleInterval`, the top 10 by count, marked `partial` when the cap cut the day short.
  A zone's `last_day` is the last complete day read, so a scan with nothing new to read asks
  Cloudflare for no counts.
- **What is stored, and what never is.** D1 holds counts and nothing that names a visitor:
  `traffic_count` (connection, zone, UTC day, dimension `action`, `country`, `host` or `rule`, key,
  count, and for a rule its description, source and whether it is partial) and `traffic_zone` (the
  zones a connection last saw: id, name, plan, the first and last day of the contiguous run of days read, last failure). Both cascade from the
  workspace and from the connection, so removing a connection removes its traffic, and a zone that
  leaves the account takes its counts with it. A scan deletes the connection's days older than 90.
  Guard asks only for `ruleId description source action sampleInterval datetime` of an event, and
  never for an address, a user agent, a path, a query, a ray id or an ASN;
  `packages/scan/test/traffic.test.ts` and `apps/web/test/traffic.test.ts` fail if a query names one,
  or a column could hold one. Host names are the customer's own zones'. No traffic is ever logged.
- **What was measured** on 2026-11-14, on an account of 30 Free zones, since the docs state little:
  `firewallEventsAdaptiveGroups` is off on the Free plan (`settings` says `enabled: false` and a
  query fails), so it is never asked for; `httpRequestsAdaptiveGroups` works on Free (30 days a
  query, up to 10,000 groups a page, a `count` already scaled for sampling, no rule id) and its
  `botScoreBucketBy10` is refused; `firewallEventsAdaptive` works on Free and has `ruleId`. A query
  may name 10 zones at most, so zones are asked ten at a time, nested in the account
  (`viewer.accounts(filter: {accountTag}).zones(filter: {zoneTag_in})`), with
  `X-Rate-Limit-Type: account-based` so each zone has its own budget. At most four calls are in
  flight. Errors come back as HTTP 200 with an `errors` array: a missing permission is
  `zones [<tag>] are not authorized` or `Actor … does not have permission`, and a spent budget has
  `extensions.code` `budget`. They become `forbidden` and `rate_limited`; only the kind is kept,
  never the message, which may carry a token's id.
- **It never fails the Insights.** The token's traffic failure is kept on the connection
  (`connection.traffic_outcome`: `ok` or a failure kind) and, for a zone that failed alone, on the
  zone (`traffic_zone.last_failure`), and the Connections and Traffic pages say what to fix. The
  traffic is written in a batch of its own before the findings are changed, so a failing write cannot
  keep the insights from being recorded. A failure that passes with time brings the next scan within
  the hour; the days already read are not read again.
- **The spike rule.** `waf_spike`, source `cloudflare`, one finding per zone, severity `low`
  (the WAF is working; it is worth a look, not an alarm). Yesterday's mitigated requests are more
  than 5 times the median of the 7 days before, with at least 3 of those days known and at least
  500 mitigated requests yesterday. A known day is one Guard has read: in the run from `first_day` to
  `last_day`, a day with no rows had nothing acted on and counts as 0, while a gap (a long pause or a
  failing token) starts a new run so unread days are never zeros. Mitigated means the actions `block`, `challenge`, `jschallenge`,
  `managedChallenge` and `connectionClose` (the API lists its `securityAction` values nowhere, so
  anything else, such as `log` or `skip`, counts as the request getting through). The fingerprint is
  `traffic:<account>:waf_spike:<zone id>`, so it is one finding while it lasts and resolves on the
  first scan where yesterday is no longer a spike. Like an unreadable lockfile, a zone Guard could not
  read keeps its finding open, and a connection whose traffic could not be read keeps all of its
  traffic findings open (`held` in `scan.ts`).
- **The Traffic page** (`/$workspace/traffic`, `GET /api/traffic/<workspace>`) is for any member and
  answers a non-member as a missing workspace. Per zone it draws the stored days as inline SVG bars
  with a text summary beside it, and lists yesterday's top rules (marked "sampled", or "partial"), the
  top countries and hosts of the last seven days, and this week against last week. A zone with nothing
  stored says why: not scanned yet, no permission, or nothing acted on.

### Protection

Guard shows what each Cloudflare zone has: which protections are on, the zone's custom WAF rules,
and what those rules have done. It is for people who do not live in the dashboard, so the page
speaks in plain sentences, shows at a glance what is wrong, and links each fix to the zone's page in
Cloudflare. It needs three read permissions on all zones, all optional: Zone › WAF › Read, Zone ›
Bot Management › Read and Zone › Zone Settings › Read. Connecting still needs only the first three
(Insights and Analytics). The code is `packages/scan/src/protection.ts` (what is asked of
Cloudflare), `apps/web/src/server/connections/protection.ts` (what a scan reads, judges and writes),
`protection-gateway.ts` with the Protection page (what members see), and
`apps/web/src/lib/protection.ts` (the statuses, sentences and overview counts, which are plain
functions with unit tests).

- **What is read.** After Traffic, a scan reads each of the zones Traffic listed (the active ones),
  one zone at a time, with five requests made together: the entrypoint rulesets of the phases
  `http_request_firewall_custom`, `http_request_firewall_managed` and `http_ratelimit`
  (`GET /zones/{zone}/rulesets/phases/<phase>/entrypoint`, which answers 404 when the zone has
  nothing there), `GET /zones/{zone}/bot_management` (`fight_mode`) and
  `GET /zones/{zone}/settings/security_level`. When a managed ruleset is deployed, a sixth request,
  `GET /zones/{zone}/rulesets`, gives its name. DDoS is not read (it needs another permission and is
  always on), and `http_request_sbfm` is not a phase on these zones.
- **What was measured** on 2026-11-14, on an account of 30 Free zones: the custom entrypoint
  answers 200 with `rules[]` (`id`, `ref`, `version`, `action`, `description`, `enabled`,
  `expression`, `last_updated`) or 404 when there are none; the managed one is 404 on all 30; the
  rate limiting one is 404 when there are no rules; bot management and the security level answer
  200 with the permission and 403 without it. Cloudflare's docs (developers.cloudflare.com/waf/tools/security-level/,
  updated 2026-04-16) say the security level now only turns Under Attack mode on or off: the threat
  score is always 0, so `essentially_off`, `low`, `medium` and `high` no longer change who is challenged.
- **A rule's expression is never read or kept.** An expression can hold the customer's own secrets
  (a header value, an address in a skip rule). The field is left out of every schema in
  `packages/scan/src/protection.ts`, so zod strips it at the boundary, no column could hold it, and
  tests fail if one is stored, returned or shown. Of a custom rule Guard keeps its id, action,
  description (cut to 200 characters), whether it is on, and when it changed.
- **Each part stands alone.** Every part is `ok`, `none` (a 404 on an entrypoint) or `failed` with a
  failure kind, and one failing never spoils the others: a token with WAF but not Zone Settings
  still shows the rules. A failure never fails the scan or the Insights. The zone's row says which
  parts failed, the page says which permission is missing, and a failure that passes with time brings
  the next scan within the hour. Only a failure's kind is kept, never a message.
- **What is stored.** `protection_zone` (one row per connection and zone: each part's state, its
  values or failure kind, and when it was read) and `protection_rule` (the zone's custom rules,
  replaced on every scan, so a rule deleted in Cloudflare, or one that can no longer be read, does
  not linger). Both cascade from the workspace and the connection, and a zone that leaves the account
  takes its rows with it. They are written in a batch of their own before the findings change, as the
  traffic is.
- **Subrequests.** A zone costs five requests (six with a managed ruleset), on top of what Insights
  and Traffic cost. A Worker on Workers Paid may make 10,000 subrequests an invocation, so an account
  of a few hundred zones is within it; on the Free plan's 50 only a handful of zones fit. Requests
  are made five at once, one zone after another.
- **No finding from configuration.** Guard once raised `security_level_off` (low) for a security
  level of `essentially_off`. That warned about a setting that does nothing, since the security level
  now only means Under Attack mode, so the rule is gone. A kind a scan no longer makes resolves like
  any finding that is no longer seen, on the next scan, even where the level cannot be read: nothing
  holds it (`held` in `scan.ts` has no protection prefix). Insights already raises Bot Fight Mode
  and AI-bot findings (`manage_bot_fight_mode`, `no_challenge_ai_bots`) and Guard has seen no class
  for managed rules on a real account (`titles.ts` lists the classes seen), so it raises no finding
  for managed rules being off either: the Protection page shows it, and the overview counts it.
- **The Protection page** (`/$workspace/protection`, `GET /api/protection/<workspace>`) is for any
  member and answers a non-member as a missing workspace. At the top, one line per issue across all
  zones ("Bot Fight Mode off on 21 of 30 zones"); each is a filter on the zone list below. Per zone,
  a checklist of five lines (managed rules, custom rules, rate limiting, Bot Fight Mode, Under
  Attack mode), each with a status in words (Good, Worth a look, Not set up, Not readable, Not read yet),
  one sentence on why it matters, and where action is needed a "Fix in Cloudflare" link
  (`apps/web/src/lib/dashboard-links.ts`, the one module that knows the dashboard's paths). A part
  Guard cannot read says which permission to add and links to Connections. Under the checklist are
  the zone's custom rules: description, action, on or off, when it changed, and how much it acted.
- **A rule's activity comes from Traffic.** The page joins `protection_rule.rule_id` with the
  `traffic_count` rows of dimension `rule` (their key is the rule's id). Traffic keeps only the top
  10 rules of the 20 busiest zones for each day, from sampled events, so a rule with no row may still
  have acted. The page therefore says "No activity recorded" and never that a rule did nothing.
- **Token links.** Cloudflare's docs describe template URLs that pre-fill the token form
  (`https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=[…]&name=…`, with keys
  such as `analytics` and `zone_settings`), but list the keys of only a few permissions, and none
  for WAF, Bot Management or Security Center Insights. A link with guessed keys would tick the wrong
  boxes without saying so, so the connect form links to the token page and lists the permissions in
  words.

### Notifications

Findings reach people three ways, and the first needs nothing set up.

- **A "New" badge.** The Findings item in the sidebar counts the open findings that were raised
  since this member last opened Findings, and each such row says "New". `finding.raised_at` is when
  a finding became news: its first scan, or the scan that found it again after more than a day
  (`raisedAtFor` in `server/notifications/rules.ts`), so a finding that flaps within a day is not
  news twice. `notification_preference.findings_seen_at` is the member's side, per workspace; with
  none, they joined at `member.created_at` and see nothing from before. The page tells the server it
  has looked once it is on screen (`POST /api/findings/<workspace>` with `seen`, open to every
  member), never in the loader, which also runs when a link is only hovered. It sends the time its
  list was read, so a finding a scan raised after that stays new. The sidebar asks for its count
  (`GET /api/findings/<workspace>/new`) after every navigation.
- **An email when a scan finds new critical or high findings.** The hourly run sends these after the
  scans (`sendAlerts` in `server/notifications/send.ts`), so a finding from "Scan now" is told by the
  next hour at the latest. It looks for open, undismissed, critical or high findings whose
  `raised_at` is after their `notified_at`; a connection's first good scan sets `notified_at` as it
  writes them, since what was already there is no alert. A workspace gets at most one such email an
  hour (a row in `notification_log` is claimed first, in one statement, so two runs cannot both send)
  and findings raised in between wait for the next. A finding is settled when its email is claimed,
  so a send that fails is not retried: one alert twice is worse than none, and the page and the
  digest still show it. Findings raised more than 7 days ago and never told (email was off) are
  dropped from alerts. It goes to owners and admins by default and to members only when they turn it
  on.
- **A weekly summary.** The first hourly run on Monday from 08:00 UTC sends it, once per workspace
  per ISO week, so a missed 08:00 run is made up by the next hour's: `notification_log` is keyed by workspace, kind and week (`2026-W47`), and the row is claimed
  before anything is sent, so a retried or repeated run finds the week taken. It says what is open
  by severity, what was raised and resolved in the last seven days, the newest findings, and the
  last seven complete UTC days of WAF traffic as stopped (`block`, `connectionClose`) and challenged
  totals, left out when no zone has been read that far. A workspace with no connection is skipped.
  Default as for alerts.

Each member has two switches per workspace (`notification_preference.alert_email` and
`digest_email`, null meaning the role's default), in Settings, Notifications
(`/api/notifications/<workspace>`; a member changes only their own, which is the session's, never a
field of the request). Every email carries a link,
`/api/unsubscribe/<kind>.<workspace>.<member>.<mac>`, and `List-Unsubscribe` with
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) when the deployment's address is
https. The token is an HMAC of its purpose, kind, workspace and member under `BETTER_AUTH_SECRET`,
as Gateweave Track's inbox emails sign theirs. `GET` shows a page with a button, so that a link
scanner changes nothing; `POST` writes 0 to that one column for a current member and never anything
else, so a link can turn email off and nothing on. Every failure is the same 404 page, so nothing
says whether a workspace or member exists.

Email shows titles, severities, counts and the names people gave a connection or zone, never a
token or its hint, an address, a lockfile's path or anything read from a request. The links need
`BETTER_AUTH_URL`: the hourly run has no request to take the address from, so without it the email
has no button and no unsubscribe link, and says where to change the setting instead.

### Actions: a finding in Gateweave Track, and a fix from Agents

A finding is fixed where a team plans its work. An owner or admin connects the workspace to **one
Gateweave Track** in Settings, Gateweave Track (`/api/track/<workspace>`,
`apps/web/src/server/track/gateway.ts`): Track's address, the Track workspace's slug, the key of the
team issues go to, an **agent member's key** from that workspace, and optionally a label. Members
see whether it is set up, and the key's last four characters only owners and admins get.

- **Checked before it is kept.** Saving calls Track's MCP `get_workspace` with the key: the slug
  must be one the key can see (Track answers the same for a missing workspace and one it cannot
  see), the team must be in it, and the label, if one is named, must exist, since Guard never makes
  labels. A failure becomes one sentence (a revoked key, no such workspace or team, an address that
  is not Track, Track not reachable, or Track's own words). The key is sealed like a connection's
  token (`track_integration.key_sealed`, additional data `integration/<workspace>/track-key`), is
  opened only to call Track, and is sealed again by the daily run after `SECRETS_KEY` changes.
- **The address is where the key goes.** It must be https, with no name or password and no path;
  `http://localhost` is accepted only while Guard itself runs on localhost (`address.ts`). A kept
  key is reused only for the address it was made for: a new address needs a new key. No redirect is
  followed.
- **The client is Guard's own** (`mcp.ts`): `initialize`, `notifications/initialized` and
  `tools/call` over Streamable HTTP, with a bearer key, a 10 second timeout, a cap on what it
  reads, answers as an event stream or JSON, and results parsed with zod (loose objects, as
  Track's, so a field added there does not break Guard). `@modelcontextprotocol/client` was not
  taken: it is 7 MB unpacked, for stdio, OAuth and browsers a Worker never uses.
- **File in Track** (`filing.ts`) is for any member: it only makes an issue in the team's own
  Track. It calls `create_issue` with the finding's title and subject, a Markdown description,
  a priority from the severity (critical urgent, high high, moderate medium, low low, unknown none)
  and the label `security` only when the Track workspace has one. The description holds what Guard
  knows: severity, source and connection; for a dependency the package, installed and fixed
  versions, advisory id and link, lockfile and repository; for an insight its class and
  Cloudflare's fix link; for a WAF spike its sentence, which has the counts; and a link back to the
  finding. It is built from a short list of facts (`issue.ts`, `IssueFacts`) that has no field for
  a token, its hint, a secret or anything from the request, and text a scan or an advisory wrote is
  escaped so that it cannot make a link or a mention. Track sees the agent member only, not the
  member who pressed the button; Guard keeps who that was (`track_filed_by`).
- **One issue per finding.** The finding is claimed in D1 with one conditional update (`track_state`
  `filing`, taking a row that is unclaimed, or whose claim is older than two minutes, and is open)
  before Track is called, and let go if Track fails, by the same claimant's time, so a slow claim
  that was taken over cannot release the new one. The result is `filed`, with the issue's key and
  address (an address on another origin than Track's is replaced by the one Guard builds), or
  `proposed` when Track kept what was asked as a proposal because an admin set the agent to
  propose: the page says "Proposed in Track, waiting for a person" and files nothing again.
  Filing is limited to about 30 a minute per workspace, and checking an address and key to 20 an
  hour (`rate-limit/index.ts`). Removing the integration keeps the links findings already have.
- **Ask Agents for a fix** goes through Track. A Gateweave Agents trigger can be limited to Track
  issues carrying a label (see Agents' architecture, "Triggers"), and one conversation per issue
  opens the pull request. So the integration has one optional field, the label. When it is set,
  a dependency finding with a fixed version offers "Ask Agents for a fix", which files the issue
  with that label too, or, when it was already filed, adds the label with `update_issue` (once:
  Agents starts a run when the label is added). Guard holds no Agents secret and never talks to
  Agents; the pull request appears on the Track issue. With no label, nothing is offered, and
  Settings says how to set one up.
- **What Track is sent.** Titles, severities, versions, advisory ids, lockfile paths, repository
  and zone names, and Cloudflare insight subjects, which for multi-factor authentication are
  members' emails: all of it goes to the team's Track the workspace chose, which Settings says. No
  token, token hint, key or request detail goes.
- **Reaching Track from Guard.** Guard and Track are Workers on the same zone in Gateweave Cloud.
  `global_fetch_strictly_public` in `wrangler.jsonc` makes a request to a host on Guard's own zone
  go in through Cloudflare, to the Worker that serves it, as Track and Mail do. What Guard fetched
  before (Cloudflare's API, GitHub, OSV, a sign-in provider) is on public hosts and is unchanged.

### MCP: an assistant that acts as the person who approved it

A team asks its AI assistant what is wrong in its Cloudflare account, and the assistant reads Guard.
`/mcp` is a Model Context Protocol server over Streamable HTTP (`apps/web/src/server/mcp/`), built as
Gateweave Track's is: a person pastes `https://<guard>/mcp` into Claude Code, Claude.ai or any MCP
client and signs in in the browser. There is no key to copy.

- **OAuth only.** Better Auth's MCP plugin (`mcp`, with `jwt`) makes Guard an authorization server
  for the one resource `<origin>/mcp`. It is on only when `BETTER_AUTH_URL` pins Guard's address,
  since tokens are bound to that URL; without it `/mcp` and the discovery documents answer 404.
  Clients register themselves (dynamic and unauthenticated registration, five a minute per client
  address), sign in at `/login` and meet the consent page `/oauth/consent`, which names the app
  and where the grant goes, since anyone can register a client under any name. Consent is never
  skipped. Scopes are `openid profile email offline_access guard`. The documents are served at
  `/.well-known/oauth-protected-resource` (and `.../mcp`),
  `/.well-known/oauth-authorization-server/api/auth` and
  `/api/auth/.well-known/openid-configuration`. The plugins add the `jwks` and `oauth_*` tables
  (`0009_mcp_oauth.sql`); the routes that would let anyone manage clients or grants are closed in
  `disabledPaths`, and `routes.test.ts` lists every route that is open.
- **The endpoint verifies the token itself** (`protect.ts`): signature against the keys read
  in-process rather than over the network (a Worker's request to its own hostname fails in
  production), issuer, audience (the resource), expiry, `azp`, the `guard` scope, and DPoP binding
  where a token has one. A failure is a 401 with `WWW-Authenticate` and the protected-resource
  metadata, as MCP clients expect.
- **A person sees what they allowed, and takes it back** (Settings, AI assistant, `grants.ts` and
  `grants-gateway.ts`). Grants belong to the person, not to a workspace, so the list is the same in
  all of theirs and every role sees it. One row per app with a consent: the name it gave itself
  (marked as such, since any app can call itself anything), where it goes (the consent page's
  words, `redirectDestination`), when it was allowed, and when it last refreshed its access, which
  is the newest `rotated_at` among its refresh tokens (a refresh rotates the old token), so it is
  at most an hour behind and empty for an app that never came back. No token or token id is read.
  "Take back" (`POST /api/assistants`, Origin checked, the person from the session) deletes that
  person's refresh tokens, access tokens and consent for the app in one D1 batch. Someone else's
  grant to the same app stays, and an app the person never allowed answers the same "not found" as
  one that does not exist. Better Auth's own routes for this stay closed.
- **A grant is checked on every call.** An access token is a signed JWT that is good for an hour
  whatever happens in D1, so after verifying it `/mcp` reads `oauth_consent` for the token's
  person and app and requires the `guard` scope. That read runs together with the rate limit, not
  after it, and uses `oauthConsent_userId_idx` (a person has a handful of consents, so no index on
  `(user_id, client_id)` was added). A missing grant is answered as an invalid token, so the client
  asks the person again. The refresh token is gone too, so a refresh is refused as well.
- **Apps nobody allowed are pruned.** Anyone can register a client, so the daily run deletes those
  registered without a user, more than a day old, with no consent and no unexpired refresh token.
  Their `oauth_client_resource` rows go with them. A client someone allows is never touched.
- **Session cookies are never accepted at `/mcp`.** A page cannot make a signed-in browser call it,
  and the endpoint reads only the `Authorization` header.
- **A token acts as the person who approved it,** in every workspace they belong to. Every tool
  but `list_workspaces` takes the workspace's slug, and `findMembership` checks D1 on each call: a
  non-member gets the same "not found" as for a missing workspace, in the same words. What a role may
  do is not decided in the tools. Each tool calls the function the page's endpoint calls after
  "who is this member": `findingsOf`, `findingOf` and `changeFindingsAs` (`findings-gateway.ts`),
  `scanNow` (`gateway.ts`) and `trafficOf` (`traffic-gateway.ts`). So a member's token can read and
  nothing else, an owner's or admin's can also dismiss a finding, with a reason held to the page's
  bounds, and start a scan under the page's limit of once in a few minutes per connection.
- **Tools.** `list_workspaces`; `list_findings` (the page's filters, plus kind, connection and
  "new since I last looked", in the page's order, 50 by default and at most 200 a call, with a cursor
  that is only an offset); `get_finding` (all the page shows, for a package its installed and fixed
  versions, lockfile and repository, and who dismissed it and why); `dismiss_finding`;
  `start_scan`, which waits for the scan and returns its outcome; and `traffic_summary` (the page's
  periods: 14 days, this week against the last, yesterday's rules, the week's countries and hosts, and
  what Cloudflare did by action; never addresses, user agents or paths, which Guard does not store).
  Reading through MCP does not clear the person's "New" badge.
- **What is never returned:** a token, its hint, a sealed value, a rule's expression (Guard never
  reads one), the Track key, or anything of another workspace. A finding about multi-factor
  authentication names the account's members by email, as the page does for every member, so the
  person's assistant receives what the person can see, and no more: connect only assistants you
  trust. Titles, subjects and rule descriptions come from Cloudflare accounts and public advisories,
  and the tool descriptions tell the model to read them as data.
- **Outputs are loose objects,** because a client keeps a tool's output schema from when it
  connected and a strict one would fail every call after a field was added. Errors come in English
  with a stable code: `not_found`, `forbidden`, `invalid`, `rate_limited` or `upstream` (anything
  unexpected, in words that say nothing about what failed).
- **Rate limit.** Calls are counted in the `RateLimiter` Durable Object per person and OAuth client
  (not per token, which changes on every refresh): 60 at once, refilling over a minute, within 600
  an hour (`allowMcpCall`). Over it, the answer is 429 with `Retry-After`.
- **The consent page** is a page like the others: the same security headers and policy, nothing
  cached, light and dark. `oauth` is a reserved workspace slug.

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
  Guard will read are another matter, and are sealed: see "Connections, scans and findings".)
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

- **More ways to be told.** Email and the badge are built (see "Notifications"). Slack, webhooks,
  choices per severity or connection, and a push to a phone are not, and neither is an alert the
  moment a "Scan now" finishes: it goes with the next hourly run.
- **More rules from configuration and traffic.** Only the spike is built
  (see "Traffic" and "Protection"). A finding for managed rules being off waits for a measurement of
  which insight class says so; until then the Protection page shows it. Guard does not yet read
  account-level rulesets, DDoS overrides or Super Bot Fight Mode's settings.
- **Token links with the permissions ticked** wait for Cloudflare to document the template keys of
  the WAF, Bot Management and Security Center Insights permissions.
- **More for actions.** "File in Track" and "Ask Agents for a fix" through a Track label are built
  (see "Actions"). Not built: asking Agents directly, without Track, which would need an Agents
  secret held in Guard; a comment on the Track issue when its finding resolves, so the issue is not
  left open for a problem that is gone; and a GitHub App for opening the fix without Agents.
- **Headless agent keys for MCP.** The MCP server (see "MCP") takes OAuth tokens of people only,
  as Track does for people. Guard has no agent members, so a job or an agent with no browser cannot
  sign in. A key tied to a workspace and a role, like Track's agent members', is the follow-up.
- **More MCP tools.** Filing a finding in Track, bringing a dismissed one back, and listing
  connections and Protection are on the pages and not in MCP yet.
