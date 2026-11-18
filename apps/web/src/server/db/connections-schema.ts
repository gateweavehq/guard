import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organization, user } from "./auth-schema";

/** How many connections one workspace may have. The trigger `connection_is_capped` holds it. */
export const MAX_CONNECTIONS = 50;
/** How many scans a connection keeps. */
export const KEPT_SCANS = 30;
/** The longest reason an admin gives for dismissing a finding. */
export const MAX_DISMISS_REASON = 200;

export const CONNECTION_KINDS = ["cloudflare", "github"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const SEVERITIES = ["critical", "high", "moderate", "low", "unknown"] as const;
export type FindingSeverity = (typeof SEVERITIES)[number];

/** How many days of traffic a connection keeps; the scan deletes older ones. */
export const KEPT_TRAFFIC_DAYS = 90;

export const TRAFFIC_DIMENSIONS = ["action", "country", "host", "rule"] as const;
export type TrafficDimension = (typeof TRAFFIC_DIMENSIONS)[number];

/**
 * Where a finding stands in Gateweave Track: being filed, filed, or proposed for a person to
 * accept. There is no CHECK on the column: SQLite can only add one by rebuilding `finding`, which a
 * deploy's migration should not do to the table every scan writes.
 */
export const TRACK_STATES = ["filing", "filed", "proposed"] as const;
export type TrackState = (typeof TRACK_STATES)[number];

export const FINDING_SOURCES = ["cloudflare", "dependency"] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

/**
 * "Connections" in docs/architecture.md: a Cloudflare account or a GitHub repository a workspace
 * lets Guard read. The token is sealed (`secrets.ts`), opened only inside a scan or a check, and
 * pages see its last four characters.
 */
export const connection = sqliteTable(
	"connection",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: CONNECTION_KINDS }).notNull(),
		/** A Cloudflare account id, or `owner/name` as GitHub writes it. */
		target: text("target").notNull(),
		/** GitHub's id of the repository, which a rename keeps. Null for Cloudflare. */
		githubRepositoryId: integer("github_repository_id"),
		/** What pages call it. */
		name: text("name").notNull(),
		tokenSealed: text("token_sealed").notNull(),
		/** The token's last four characters. */
		tokenHint: text("token_hint").notNull(),
		/** The admin's user id. Not a foreign key: the connection outlives their account. */
		addedBy: text("added_by").notNull(),
		addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull(),
		lastScanAt: integer("last_scan_at", { mode: "timestamp_ms" }),
		/**
		 * `ok`, a failure kind of `UpstreamFailure`, `unreadable` for a token that does not open, or
		 * `unrecorded` for a scan whose result could not be written (`UNRECORDED` in `scan.ts`).
		 */
		lastScanOutcome: text("last_scan_outcome"),
		nextScanAt: integer("next_scan_at", { mode: "timestamp_ms" }).notNull(),
		/** Set while a scan runs, so that one connection is never scanned twice at once. */
		scanStartedAt: integer("scan_started_at", { mode: "timestamp_ms" }),
		/**
		 * How the last read of WAF and bot traffic went, for a Cloudflare connection: `ok`, or a failure
		 * kind of `UpstreamFailure`. It is kept apart from `last_scan_outcome` so that a token without
		 * Analytics › Read still has its Security Insights scanned. Null until a scan has run.
		 */
		trafficOutcome: text("traffic_outcome"),
	},
	(table) => [
		uniqueIndex("connection_target_unique").on(table.organizationId, table.kind, table.target),
		uniqueIndex("connection_repository_unique").on(table.organizationId, table.githubRepositoryId),
		index("connection_next_scan_idx").on(table.nextScanAt),
		check("connection_kind", sql`${table.kind} IN ('cloudflare', 'github')`),
		check(
			"connection_repository_id",
			sql`(${table.kind} = 'github') = (${table.githubRepositoryId} IS NOT NULL)`,
		),
	],
);

/**
 * One problem a scan found, kept by its fingerprint so that a rescan updates it, closes it when it
 * is gone and reopens it when it comes back. It holds what a page shows and nothing of what was
 * read: no insight payloads and no lockfile contents.
 */
export const finding = sqliteTable(
	"finding",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		connectionId: text("connection_id")
			.notNull()
			.references(() => connection.id, { onDelete: "cascade" }),
		fingerprint: text("fingerprint").notNull(),
		source: text("source", { enum: FINDING_SOURCES }).notNull(),
		severity: text("severity", { enum: SEVERITIES }).notNull(),
		/** An insight's `issue_class`, or an advisory's id. */
		kind: text("kind").notNull(),
		/** A hostname or zone, or `package@versions in lockfile`. */
		subject: text("subject").notNull(),
		title: text("title").notNull(),
		/** The Cloudflare dashboard, or the advisory on osv.dev. */
		url: text("url").notNull(),
		fixedVersion: text("fixed_version"),
		firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
		lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
		/**
		 * When the problem became news: its first scan, or the scan that found it again after it had
		 * been gone for more than a day. A finding that flaps within a day keeps its time, so it is not
		 * news twice. The "New" badge and the digest count from here.
		 */
		raisedAt: integer("raised_at").notNull().default(0),
		/**
		 * When an email about it was last settled, sent or not: null until then. A finding with
		 * `raised_at` after this is waiting for the next alert.
		 */
		notifiedAt: integer("notified_at", { mode: "timestamp_ms" }),
		/** Null while the problem is open. */
		resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
		dismissedAt: integer("dismissed_at", { mode: "timestamp_ms" }),
		/** An admin's user id. Not a foreign key, as `connection.added_by`. */
		dismissedBy: text("dismissed_by"),
		dismissReason: text("dismiss_reason"),
		/**
		 * The Gateweave Track issue this finding was filed as (`track_integration`), kept when the
		 * integration is removed so that the link stays. `filing` is the claim of whoever is calling
		 * Track right now, which makes one issue of two clicks; it is let go if Track fails.
		 */
		trackState: text("track_state", { enum: TRACK_STATES }),
		trackIssueKey: text("track_issue_key"),
		trackIssueUrl: text("track_issue_url"),
		trackFiledAt: integer("track_filed_at", { mode: "timestamp_ms" }),
		/** The member's user id. Not a foreign key, as `connection.added_by`. */
		trackFiledBy: text("track_filed_by"),
		/** When Agents was asked for a fix, by labelling the issue: see `track_integration.fix_label`. */
		fixRequestedAt: integer("fix_requested_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		uniqueIndex("finding_fingerprint_unique").on(table.organizationId, table.fingerprint),
		index("finding_connection_idx").on(table.connectionId),
		index("finding_open_idx").on(table.organizationId, table.resolvedAt),
		check("finding_source", sql`${table.source} IN ('cloudflare', 'dependency')`),
		check(
			"finding_severity",
			sql`${table.severity} IN ('critical', 'high', 'moderate', 'low', 'unknown')`,
		),
		check(
			"finding_dismiss_reason",
			sql`${table.dismissReason} IS NULL OR length(${table.dismissReason}) <= ${sql.raw(String(MAX_DISMISS_REASON))}`,
		),
	],
);

/** What each scan did, for the page's last line about a connection. The last 30 are kept. */
export const scan = sqliteTable(
	"scan",
	{
		id: text("id").primaryKey(),
		connectionId: text("connection_id")
			.notNull()
			.references(() => connection.id, { onDelete: "cascade" }),
		startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }).notNull(),
		outcome: text("outcome").notNull(),
		found: integer("found").notNull().default(0),
		added: integer("new").notNull().default(0),
		resolved: integer("resolved").notNull().default(0),
	},
	(table) => [index("scan_connection_idx").on(table.connectionId, table.startedAt)],
);

/**
 * The zones a Cloudflare connection last saw, and how far Guard has read each. Only active zones
 * are kept. Removing the connection removes them.
 */
export const trafficZone = sqliteTable(
	"traffic_zone",
	{
		connectionId: text("connection_id")
			.notNull()
			.references(() => connection.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		zoneId: text("zone_id").notNull(),
		name: text("name").notNull(),
		plan: text("plan"),
		/**
		 * `first_day` and `last_day` bound a contiguous run of complete UTC days (`YYYY-MM-DD`) Guard
		 * has read, whether or not anything was acted on in them: a day in the run with no rows had
		 * nothing acted on, and counts as 0. A gap (a long pause, a failing token) starts a new run, so
		 * unread days are never zeros. Retention may delete counts older than `first_day`'s age; the
		 * spike rule looks back 8 days only, so `first_day` may stay older than the oldest stored row.
		 */
		firstDay: text("first_day"),
		lastDay: text("last_day"),
		/** Why this zone's last read failed, a failure kind; null when it went well. */
		lastFailure: text("last_failure"),
		seenAt: integer("seen_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.connectionId, table.zoneId] }),
		index("traffic_zone_org_idx").on(table.organizationId),
	],
);

/**
 * What the WAF and bot features did to a zone's requests on one UTC day: counts and nothing that
 * names a visitor. Never an address, a user agent, a path, a query, a ray id or an ASN
 * (invariant 3). Host names are those of the customer's own zones. A `rule` row is an estimate
 * from sampled events.
 *
 * What `key` means depends on the dimension: `action` rows have the action as key (it is in
 * `action` too) and the security feature in `source`; `country` and `host` rows have the name as
 * key and the action in `action`; `rule` rows have the rule id as key, with its action, source and
 * description.
 */
export const trafficCount = sqliteTable(
	"traffic_count",
	{
		connectionId: text("connection_id")
			.notNull()
			.references(() => connection.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		zoneId: text("zone_id").notNull(),
		/** `YYYY-MM-DD`, UTC. */
		day: text("day").notNull(),
		dimension: text("dimension", { enum: TRAFFIC_DIMENSIONS }).notNull(),
		key: text("key").notNull(),
		action: text("action").notNull().default(""),
		source: text("source").notNull().default(""),
		/** A rule's description, as its owner wrote it. */
		description: text("description"),
		/** For a rule: the day's events were cut short, so this counts a part of the day. */
		partial: integer("partial").notNull().default(0),
		count: integer("count").notNull(),
	},
	(table) => [
		primaryKey({
			columns: [
				table.connectionId,
				table.zoneId,
				table.day,
				table.dimension,
				table.key,
				table.action,
				table.source,
			],
		}),
		index("traffic_count_org_idx").on(table.organizationId, table.zoneId, table.day),
		check(
			"traffic_count_dimension",
			sql`${table.dimension} IN ('action', 'country', 'host', 'rule')`,
		),
		check("traffic_count_count", sql`${table.count} >= 0`),
	],
);

export const PROTECTION_STATES = ["ok", "none", "failed"] as const;
export type ProtectionState = (typeof PROTECTION_STATES)[number];

const partIn = (column: string) =>
	sql.raw(`${column} IN (${PROTECTION_STATES.map((state) => `'${state}'`).join(", ")})`);

/**
 * What protects a zone, as of its last read: one row per connection and zone, each part with its
 * state (`ok`, `none` for a 404, or `failed` with the failure kind) and its values. A part's values
 * are null unless its state is `ok`. The zone's custom rules are in `protection_rule`. Nothing of
 * a rule's expression is read or kept, since it can hold the customer's own secrets.
 */
export const protectionZone = sqliteTable(
	"protection_zone",
	{
		connectionId: text("connection_id")
			.notNull()
			.references(() => connection.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		zoneId: text("zone_id").notNull(),
		name: text("name").notNull(),
		plan: text("plan"),
		readAt: integer("read_at", { mode: "timestamp_ms" }).notNull(),
		customState: text("custom_state", { enum: PROTECTION_STATES }).notNull(),
		customFailure: text("custom_failure"),
		managedState: text("managed_state", { enum: PROTECTION_STATES }).notNull(),
		managedFailure: text("managed_failure"),
		/** JSON: `[{ id, name, enabled }]`, the managed rulesets deployed. */
		managedRulesets: text("managed_rulesets"),
		rateLimitState: text("rate_limit_state", { enum: PROTECTION_STATES }).notNull(),
		rateLimitFailure: text("rate_limit_failure"),
		rateLimitTotal: integer("rate_limit_total"),
		rateLimitEnabled: integer("rate_limit_enabled"),
		botState: text("bot_state", { enum: PROTECTION_STATES }).notNull(),
		botFailure: text("bot_failure"),
		/** 1 or 0; null when Cloudflare did not say. */
		botFightMode: integer("bot_fight_mode"),
		securityLevelState: text("security_level_state", { enum: PROTECTION_STATES }).notNull(),
		securityLevelFailure: text("security_level_failure"),
		securityLevel: text("security_level"),
	},
	(table) => [
		primaryKey({ columns: [table.connectionId, table.zoneId] }),
		index("protection_zone_org_idx").on(table.organizationId),
		check("protection_zone_custom_state", partIn(table.customState.name)),
		check("protection_zone_managed_state", partIn(table.managedState.name)),
		check("protection_zone_rate_limit_state", partIn(table.rateLimitState.name)),
		check("protection_zone_bot_state", partIn(table.botState.name)),
		check("protection_zone_security_level_state", partIn(table.securityLevelState.name)),
	],
);

/**
 * A zone's custom WAF rules, replaced on every scan. What a person can read of a rule: its
 * description, action, whether it is on and when it changed. There is deliberately no column for
 * its expression.
 */
export const protectionRule = sqliteTable(
	"protection_rule",
	{
		connectionId: text("connection_id")
			.notNull()
			.references(() => connection.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		zoneId: text("zone_id").notNull(),
		/** Cloudflare's rule id, which `traffic_count` rows of dimension `rule` use as their key. */
		ruleId: text("rule_id").notNull(),
		/** The rule's place in the zone's order. */
		position: integer("position").notNull(),
		action: text("action").notNull(),
		description: text("description").notNull(),
		enabled: integer("enabled").notNull(),
		/** As Cloudflare writes it. */
		lastUpdated: text("last_updated"),
	},
	(table) => [
		primaryKey({ columns: [table.connectionId, table.zoneId, table.ruleId] }),
		index("protection_rule_org_idx").on(table.organizationId, table.zoneId),
	],
);

/**
 * What one member chose about notifications in one workspace, and when they last opened Findings.
 * A switch left null follows the default for their role (on for owners and admins, off for
 * members), so nobody has a row to set up. The unsubscribe link only ever writes 0.
 */
export const notificationPreference = sqliteTable(
	"notification_preference",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** An email when a scan finds new critical or high findings. */
		alertEmail: integer("alert_email"),
		/** The Monday summary. */
		digestEmail: integer("digest_email"),
		/** The badge counts what was raised after this. Null: since the member joined. */
		findingsSeenAt: integer("findings_seen_at", { mode: "timestamp_ms" }),
	},
	(table) => [
		primaryKey({ columns: [table.organizationId, table.userId] }),
		index("notification_preference_user_idx").on(table.userId),
		check(
			"notification_preference_switches",
			sql`(${table.alertEmail} IS NULL OR ${table.alertEmail} IN (0, 1)) AND (${table.digestEmail} IS NULL OR ${table.digestEmail} IN (0, 1))`,
		),
	],
);

/**
 * Which emails a workspace has had, so that each goes out once. An alert's `period` is unique to
 * it and the hourly limit looks at `sent_at`; a digest's is its ISO week (`2026-W46`), so that a
 * retried run finds the week taken. Rows older than 90 days are deleted by the daily run.
 */
export const notificationLog = sqliteTable(
	"notification_log",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: ["alert", "digest"] }).notNull(),
		period: text("period").notNull(),
		sentAt: integer("sent_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.organizationId, table.kind, table.period] }),
		check("notification_log_kind", sql`${table.kind} IN ('alert', 'digest')`),
	],
);

/**
 * "Actions" in docs/architecture.md: the one Gateweave Track a workspace files findings in, and the
 * key of an agent member there that does it. The key is sealed like a connection's token
 * (`secrets.ts`), opened only to call Track, and pages see its last four characters. Removing the
 * integration leaves the links findings already have.
 */
export const trackIntegration = sqliteTable("track_integration", {
	organizationId: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	/** Track's origin, such as `https://track.gateweave.com`. */
	address: text("address").notNull(),
	/** The Track workspace's slug, and the key of the team issues go to. */
	workspaceSlug: text("workspace_slug").notNull(),
	teamKey: text("team_key").notNull(),
	/**
	 * The label whose presence on an issue asks Agents for a fix, through a trigger limited to it.
	 * Null when nobody asked for that.
	 */
	fixLabel: text("fix_label"),
	keySealed: text("key_sealed").notNull(),
	/** The key's last four characters. */
	keyHint: text("key_hint").notNull(),
	/** The admin's user id. Not a foreign key, as `connection.added_by`. */
	addedBy: text("added_by").notNull(),
	addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull(),
	/** When Track last answered a check or a filing, and how it went: `ok` or a failure kind. */
	lastCheckAt: integer("last_check_at", { mode: "timestamp_ms" }),
	lastCheckOutcome: text("last_check_outcome"),
});
