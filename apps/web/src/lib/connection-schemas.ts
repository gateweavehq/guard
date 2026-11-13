import { z } from "zod";

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
	/** `ok`, a failure kind, or `unreadable`. Null until the first scan finishes. */
	lastScanOutcome: string | null;
	nextScanAt: number;
	openFindings: number;
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
	status: FindingStatus;
	dismissReason: string | null;
	connectionId: string;
	connectionName: string;
	connectionKind: ConnectionKind;
}

export interface FindingsPage {
	/** Whether the workspace has any connection, which is what tells "nothing yet" from "all clear". */
	hasConnections: boolean;
	findings: FindingView[];
	/** How many findings match, which may be more than are listed. */
	total: number;
}

/** A scan's result, as the page that asked for it shows it. */
export interface ScanSummary {
	outcome: string;
	found: number;
	added: number;
	resolved: number;
}
