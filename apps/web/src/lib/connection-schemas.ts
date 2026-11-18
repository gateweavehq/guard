import { z } from "zod";
import type { TrackLinkView, TrackStatusView } from "./track-schemas";

// What the pages and the endpoints behind them agree on, with nothing of the server in it. The
// schemas are what the server checks every request against; the pages use the same ones to say what
// a field takes.

/** How many connections one workspace may have. The database holds the same number. */
export const MAX_CONNECTIONS = 50;
export const MAX_DISMISS_REASON = 200;
export const MAX_NAME = 100;

export type ConnectionKind = "cloudflare" | "github";
export type FindingSeverity = "critical" | "high" | "moderate" | "low" | "unknown";
export type FindingSource = "cloudflare" | "dependency";
export type FindingStatus = "open" | "resolved" | "dismissed";

export const SEVERITIES: readonly FindingSeverity[] = [
	"critical",
	"high",
	"moderate",
	"low",
	"unknown",
];
export const SOURCES: readonly FindingSource[] = ["cloudflare", "dependency"];
export const STATUSES: readonly FindingStatus[] = ["open", "resolved", "dismissed"];

const id = z.string().min(1).max(64);

/** A token as Cloudflare and GitHub give one out: printable ASCII, no spaces, 20 to 400 long. */
export const tokenField = z
	.string()
	.trim()
	.regex(
		/^[\x21-\x7e]{20,400}$/,
		"That doesn't look like a token: 20 to 400 characters, no spaces.",
	);

const nameField = z
	.string()
	.trim()
	.max(MAX_NAME)
	.optional()
	.transform((name) => name || undefined);

export const ConnectionAction = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("connect-cloudflare"),
		accountId: z
			.string()
			.trim()
			.toLowerCase()
			.regex(
				/^[0-9a-f]{32}$/,
				"A Cloudflare account id is 32 characters, digits and the letters a to f.",
			),
		name: nameField,
		token: tokenField,
	}),
	z.object({
		action: z.literal("connect-github"),
		repository: z.string().trim().min(1).max(300),
		name: nameField,
		token: tokenField,
	}),
	z.object({ action: z.literal("replace-token"), id, token: tokenField }),
	z.object({ action: z.literal("scan"), id }),
	z.object({ action: z.literal("remove"), id }),
]);

export type ConnectionActionInput = z.input<typeof ConnectionAction>;

export const FindingAction = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("dismiss"),
		id,
		reason: z.string().trim().min(1, "Say why.").max(MAX_DISMISS_REASON),
	}),
	z.object({ action: z.literal("undismiss"), id }),
	// Any member may say they have looked: it is theirs alone, and the page clears its "New" marks.
	z.object({ action: z.literal("seen"), at: z.number().int().nonnegative().optional() }),
	// Filing only makes an issue in the team's own Track, so any member may ask for it.
	z.object({ action: z.literal("file"), id }),
	z.object({ action: z.literal("ask-fix"), id }),
]);

export type FindingActionInput = z.input<typeof FindingAction>;

export const FindingFilters = z.object({
	severity: z.enum(["critical", "high", "moderate", "low", "unknown"]).optional().catch(undefined),
	source: z.enum(["cloudflare", "dependency"]).optional().catch(undefined),
	status: z.enum(["open", "resolved", "dismissed"]).optional().catch(undefined),
});

export type FindingFiltersInput = z.input<typeof FindingFilters>;

export interface ConnectionView {
	id: string;
	kind: ConnectionKind;
	target: string;
	name: string;
	/** The token's last four characters: all of it any page gets. */
	tokenHint: string;
	addedAt: number;
	lastScanAt: number | null;
	/**
	 * `ok`, a failure kind, `unreadable`, or `unrecorded` for a scan whose result could not be
	 * saved. Null until the first scan finishes.
	 */
	lastScanOutcome: string | null;
	nextScanAt: number;
	openFindings: number;
	/**
	 * How reading WAF and bot traffic went, for a Cloudflare connection: `ok` or a failure kind.
	 * Null for a repository, and until the first scan has run.
	 */
	trafficOutcome: string | null;
}

export interface ConnectionsPage {
	/** Why this server cannot keep tokens, so nothing can be connected; null when it can. */
	sealingProblem: string | null;
	connections: ConnectionView[];
}

export interface FindingView {
	id: string;
	source: FindingSource;
	severity: FindingSeverity;
	kind: string;
	subject: string;
	title: string;
	url: string;
	fixedVersion: string | null;
	firstSeenAt: number;
	lastSeenAt: number;
	/** When it became news (`finding.raised_at`), which is what "New" counts from. */
	raisedAt: number;
	status: FindingStatus;
	dismissReason: string | null;
	connectionId: string;
	connectionName: string;
	connectionKind: ConnectionKind;
	/** Where it stands in Gateweave Track; null when it was never filed there. */
	track: TrackLinkView | null;
}

export interface FindingsPage {
	/** Whether the workspace has any connection, which is what tells "nothing yet" from "all clear". */
	hasConnections: boolean;
	findings: FindingView[];
	/** How many findings match, which may be more than are listed. */
	total: number;
	/** When this member last opened Findings: what "New" is measured from. */
	seenAt: number;
	/** The server's time for this answer, which the page hands back to say it has looked. */
	loadedAt: number;
	track: TrackStatusView;
}

/** One UTC day of a zone: the requests Cloudflare's WAF and bot features stopped or challenged. */
export interface TrafficDayView {
	/** `YYYY-MM-DD`. */
	day: string;
	mitigated: number;
}

/** A day of the chart's fixed window: read (0 when nothing was acted on) or not read yet. */
export interface TrafficSeriesDay {
	day: string;
	state: "read" | "unread";
	mitigated: number;
}

/** This week against the one before, from the days that were read. */
export interface TrafficWeek {
	thisSum: number;
	/** How many of this week's 7 days were read. */
	thisRead: number;
	lastSum: number;
	lastRead: number;
	/** A percentage, only when all 14 days are known and last week was not empty. */
	change: number | null;
}

export interface TrafficRuleView {
	ruleId: string;
	description: string;
	source: string;
	action: string;
	/** An estimate: events are sampled, each counted for the requests it stands for. */
	count: number;
	/** The day's events were cut short, so this is a part of the day. */
	partial: boolean;
}

export interface TrafficNameView {
	name: string;
	count: number;
}

export type TrafficZoneStatus = "ok" | "failed" | "not_scanned" | "no_events";

export interface TrafficZoneView {
	zoneId: string;
	name: string;
	plan: string | null;
	status: TrafficZoneStatus;
	/** A failure kind, when `status` is `failed`. */
	failure: string | null;
	/** The 14 days ending yesterday, oldest first, read or not. */
	series: TrafficSeriesDay[];
	/** Yesterday's top rules. */
	rules: TrafficRuleView[];
	/** The top countries and hosts over the last seven days. */
	countries: TrafficNameView[];
	hosts: TrafficNameView[];
	week: TrafficWeek;
}

export interface TrafficConnectionView {
	id: string;
	name: string;
	/** `ok` or a failure kind; null until a scan has run. */
	outcome: string | null;
	zones: TrafficZoneView[];
}

export interface TrafficPage {
	/** Whether the workspace has a Cloudflare connection, which is what tells "nothing yet" from "no data". */
	hasConnections: boolean;
	/** The last complete UTC day, `YYYY-MM-DD`. */
	yesterday: string;
	connections: TrafficConnectionView[];
}

/** A scan's result, as the page that asked for it shows it. */
export interface ScanSummary {
	outcome: string;
	found: number;
	added: number;
	resolved: number;
}

/**
 * What came of the scan that follows connecting or replacing a token: `recorded` with a summary,
 * `held` when another scan had the connection, `unrecorded` when it ran and its result could not
 * be saved.
 */
export type ScanState = "recorded" | "held" | "unrecorded";

/** What Guard knows of one thing it reads about a zone. `unread` is a zone no scan has read yet. */
export type ProtectionPartView<T> =
	| { state: "ok"; value: T }
	| { state: "none" }
	| { state: "failed"; failure: string }
	| { state: "unread" };

/** A custom WAF rule, as a person reads it. Its expression is never read, so it is not here. */
export interface ProtectionRuleView {
	ruleId: string;
	description: string;
	action: string;
	enabled: boolean;
	/** As Cloudflare writes it, an ISO time; null when it did not say. */
	lastUpdated: string | null;
	/**
	 * What Traffic recorded of this rule on the days it recorded rules: an estimate from sampled
	 * events. Null when no day recorded it, which is not the same as it never acting.
	 */
	acted: { count: number; days: number } | null;
}

export interface ProtectionZoneView {
	connectionId: string;
	connectionName: string;
	/** Cloudflare's account id, for the links into its dashboard. */
	accountId: string;
	zoneId: string;
	name: string;
	plan: string | null;
	/** When Guard last read this zone's protection; null until a scan has. */
	readAt: number | null;
	custom: ProtectionPartView<{ total: number; enabled: number }>;
	managed: ProtectionPartView<{
		rulesets: { id: string; name: string | null; enabled: boolean }[];
	}>;
	rateLimit: ProtectionPartView<{ total: number; enabled: number }>;
	bot: ProtectionPartView<{ fightMode: boolean | null }>;
	securityLevel: ProtectionPartView<{ level: string }>;
	rules: ProtectionRuleView[];
	/** On how many days Traffic recorded the rules that acted in this zone. */
	ruleDays: number;
}

export interface ProtectionPage {
	/** Whether the workspace has a Cloudflare connection, which tells "nothing yet" from "no zones". */
	hasConnections: boolean;
	zones: ProtectionZoneView[];
}
