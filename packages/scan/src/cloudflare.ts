import { z } from "zod";
import { UpstreamError } from "./errors";
import { type FetchOptions, readJson, send } from "./http";

// Cloudflare's Security Insights: what Security Center found wrong in an account's setup, such
// as a proxied DNS record without "Always Use HTTPS" or an exposed origin. Guard reads them with
// an account API token that has "Account Security Center Insights: Read" and nothing more.

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
/** The API's ceiling on `per_page`. */
const PER_PAGE = 1000;
/** Fifty thousand insights is far past any real account; stopping keeps a bad answer from looping. */
const MAX_PAGES = 50;

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

export function isAccountId(value: string): boolean {
	return ACCOUNT_ID.test(value);
}

export type InsightSeverity = "critical" | "moderate" | "low";

export interface Insight {
	readonly id: string;
	/** What kind of problem, such as "always_use_https_not_enabled". */
	readonly issueClass: string;
	/** The broader group, such as "insecure_configuration" or "exposed_infrastructure". */
	readonly issueType: string;
	readonly severity: InsightSeverity;
	/** What the insight is about, usually a hostname or zone name. */
	readonly subject: string;
	readonly status: "active" | "resolved";
	/** Dismissed by someone in the Cloudflare dashboard. */
	readonly dismissed: boolean;
	readonly userClassification: string | null;
	readonly detectionMethod: string | null;
	readonly resolveText: string | null;
	/** Where in the Cloudflare dashboard to fix it; see {@link dashboardUrl}. */
	readonly resolveUrl: string;
	readonly zoneTag: string | null;
	readonly source: string;
	readonly since: string | null;
	readonly seenAt: string | null;
}

const text = z.string().nullish().catch(null);

const insightsResponse = z.object({
	success: z.literal(true),
	result: z.object({
		count: z.number().int().nonnegative().optional(),
		issues: z.array(
			z.object({
				id: z.string().min(1),
				issue_class: z.string().catch("unknown"),
				issue_type: z.string().catch("unknown"),
				severity: text,
				subject: z.string().catch(""),
				status: text,
				dismissed: z.boolean().catch(false),
				user_classification: text,
				resolve_link: text,
				resolve_text: text,
				source: text,
				since: text,
				timestamp: text,
				payload: z.object({ detection_method: text, zone_tag: text }).nullish().catch(null),
			}),
		),
	}),
});

function severityOf(value: string | null | undefined): InsightSeverity {
	const lower = value?.toLowerCase();
	// An unknown level counts as moderate rather than disappearing among the low ones.
	return lower === "critical" || lower === "low" ? lower : "moderate";
}

/**
 * Text meant for people, or null. For some insights the API sends the dashboard's translation
 * key ("security_center.checks.access_policies.detection") where the text should be, which is no
 * use to anyone reading it.
 */
function prose(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed || /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(trimmed)) return null;
	return trimmed;
}

const DASHBOARD = "https://dash.cloudflare.com";

/**
 * Where in the Cloudflare dashboard to fix an insight. The API sends a path with placeholders,
 * such as `/:account_id/:zone_name/security/bots`, or for most insights an empty string. The
 * account is filled in. The zone is left to the dashboard's `?to=` links, which ask for it,
 * because an insight's subject is often a hostname rather than its zone. Anything else, including
 * a path that would leave the dashboard, links to the account's Security Insights instead, so a
 * changed or tampered answer cannot send anyone to another site.
 */
export function dashboardUrl(resolveLink: string | null | undefined, accountId: string): string {
	const insights = `${DASHBOARD}/${accountId}/security-center`;
	if (!resolveLink?.startsWith("/")) return insights;
	const path = resolveLink.replaceAll(":account_id", accountId).replaceAll(":zone_name", ":zone");
	// A placeholder other than the zone is one the dashboard may not fill in.
	if (/\/:(?!zone(?:[/?#]|$))/.test(path)) return insights;
	let url: URL;
	try {
		url = new URL(path, DASHBOARD);
	} catch {
		return insights;
	}
	// "//host" and "/\host" are links to another host.
	if (url.origin !== DASHBOARD) return insights;
	if (!/\/:zone(?:[/?#]|$)/.test(path)) return url.href;
	const to = new URL(`${DASHBOARD}/`);
	to.searchParams.set("to", path);
	return to.href;
}

/**
 * Every Security Insight in the account, dismissed and resolved ones included, so that a finding
 * can be closed when Cloudflare no longer reports it as active.
 */
export async function listInsights(
	account: { readonly accountId: string; readonly token: string },
	options: FetchOptions = {},
): Promise<Insight[]> {
	if (!isAccountId(account.accountId)) {
		throw new UpstreamError("cloudflare", "not_found", "That is not a Cloudflare account id");
	}
	const insights: Insight[] = [];
	for (let page = 1; ; page++) {
		if (page > MAX_PAGES) {
			throw new UpstreamError(
				"cloudflare",
				"invalid_response",
				"cloudflare kept sending more pages",
			);
		}
		const url = new URL(`${CLOUDFLARE_API}/accounts/${account.accountId}/security-center/insights`);
		url.searchParams.set("page", String(page));
		url.searchParams.set("per_page", String(PER_PAGE));
		const response = await send(
			"cloudflare",
			url.href,
			{ headers: { Authorization: `Bearer ${account.token}`, Accept: "application/json" } },
			options,
		);
		const { result } = await readJson("cloudflare", response, insightsResponse);
		for (const issue of result.issues) {
			insights.push({
				id: issue.id,
				issueClass: issue.issue_class,
				issueType: issue.issue_type,
				severity: severityOf(issue.severity),
				subject: issue.subject,
				status: issue.status === "resolved" ? "resolved" : "active",
				dismissed: issue.dismissed,
				userClassification: issue.user_classification ?? null,
				detectionMethod: prose(issue.payload?.detection_method),
				resolveText: prose(issue.resolve_text),
				resolveUrl: dashboardUrl(issue.resolve_link, account.accountId),
				zoneTag: issue.payload?.zone_tag ?? null,
				source: issue.source ?? "cloudflare",
				since: issue.since ?? null,
				seenAt: issue.timestamp ?? null,
			});
		}
		const total = result.count;
		if (result.issues.length < PER_PAGE || (total !== undefined && insights.length >= total)) {
			return insights;
		}
	}
}
