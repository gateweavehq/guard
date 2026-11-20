import { z } from "zod";

// What the Settings page, the Findings page and the endpoints behind them agree on about Gateweave
// Track, with nothing of the server in it.

export const TRACK_DEFAULT_ADDRESS = "https://track.gateweave.com";

/**
 * An agent member's key as Track makes them: `gwt_` and 43 characters. Checked here so that
 * something that is plainly not one is refused before it is sent anywhere.
 */
export const trackKeyField = z
	.string()
	.trim()
	.regex(
		/^gwt_[A-Za-z0-9_-]{43}$/,
		"That doesn't look like an agent key from Track: it is gwt_ and 43 more characters. Copy it again from the agent's page in Track.",
	);

const blankToUndefined = (value: unknown) =>
	typeof value === "string" && value.trim() === "" ? undefined : value;

export const TrackAction = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("save"),
		address: z.string().trim().min(1, "Say where Track is.").max(300),
		workspace: z
			.string()
			.trim()
			.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "A workspace slug is letters, digits and dashes."),
		team: z
			.string()
			.trim()
			.toUpperCase()
			.regex(/^[A-Z][A-Z0-9]{0,6}$/, "A team key is 1 to 7 letters or digits, such as ENG."),
		fixLabel: z.preprocess(blankToUndefined, z.string().trim().max(64).optional()),
		// Left out, the key already kept is used again: only when the address is unchanged.
		key: z.preprocess(blankToUndefined, trackKeyField.optional()),
	}),
	z.object({ action: z.literal("remove") }),
	z.object({
		action: z.literal("source"),
		connectionId: z.string().min(1),
		address: z.string().trim().min(1).max(300).optional(),
		key: z
			.string()
			.length(47)
			.regex(/^gws_[A-Za-z0-9_-]{43}$/, "Paste a source key from Track."),
	}),
]);

export type TrackActionInput = z.input<typeof TrackAction>;

export interface TrackIntegrationView {
	address: string;
	workspace: string;
	team: string;
	fixLabel: string | null;
	/** The key's last four characters. Only owners and admins get it. */
	keyHint: string | null;
	addedAt: number;
	lastCheckAt: number | null;
	/** `ok` or a failure kind. */
	lastCheckOutcome: string | null;
}

export interface SourceView {
	id: string;
	name: string;
	kind: "github" | "cloudflare";
	keyHint: string | null;
	/**
	 * Track's status code, or `foreign_link`, `too_large`, `unreachable`, `invalid_response` or
	 * `unreadable`.
	 */
	lastAnswer: string | null;
	answeredAt: number | null;
	stopped: boolean;
}

const ANSWERS: Record<string, string> = {
	"200": "Track took the finding",
	"400": "Track refused a finding",
	"404": "Track doesn't know this key",
	"429": "Track asked Guard to wait",
	unreachable: "Track couldn't be reached",
	invalid_response: "Track's answer couldn't be read",
	unreadable: "Guard couldn't open the saved key",
	foreign_link: "Track took the finding but linked it on another address",
	too_large: "A finding was too large to send",
};

/** What a source's last answer means, in words an admin can act on. */
export function sourceAnswerText(answer: string): string {
	return ANSWERS[answer] ?? `Track answered ${answer}`;
}
export interface TrackPage {
	sources: SourceView[];
	guardOrigin: string;
	sourceAddress: string | null;
	/** Why this server cannot keep a key; null when it can. */
	sealingProblem: string | null;
	integration: TrackIntegrationView | null;
}

/** Where one finding stands in Track, for the Findings page. */
export interface TrackLinkView {
	/** `filing` while another click is still being answered. */
	state: "filing" | "filed" | "proposed";
	/** Null while it is being filed, or when Track proposed it without saying where. */
	key: string | null;
	url: string | null;
	/** Whether Agents was asked for a fix by labelling the issue. */
	fixRequested: boolean;
}

/** What the Findings page needs to know about the integration. */
export interface TrackStatusView {
	configured: boolean;
	sourceMode?: boolean;
	/** Whether "Ask Agents for a fix" is offered: a label is set. */
	canAskFix: boolean;
}
