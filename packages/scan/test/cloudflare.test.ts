import { describe, expect, it } from "vitest";
import { dashboardUrl, listInsights } from "../src/cloudflare";
import { UpstreamError } from "../src/errors";
import { fakeFetch, json } from "./fake-fetch";

const ACCOUNT = "023e105f4ecef8ad9ca31a8372d0c353";
const TOKEN = "test-token-that-must-not-leak";

function issue(id: string, fields: Record<string, unknown> = {}) {
	return {
		id,
		issue_class: "always_use_https_not_enabled",
		issue_type: "insecure_configuration",
		severity: "Moderate",
		subject: "example.com",
		dismissed: false,
		status: "active",
		since: "2026-10-01T00:00:00Z",
		timestamp: "2026-11-13T00:00:00Z",
		// The shape the API sends: placeholders for the account and zone.
		resolve_link: "/:account_id/zones/974037826/security/settings",
		resolve_text: "Turn on Always Use HTTPS",
		source: "cloudflare",
		payload: { detection_method: "We checked the zone's settings.", zone_tag: "zone-1" },
		...fields,
	};
}

function page(issues: unknown[], count: number) {
	return json({
		success: true,
		errors: [],
		messages: [],
		result: { count, page: 1, per_page: 1000, issues },
	});
}

describe("listInsights", () => {
	it("reads every page with the account's token", async () => {
		const first = Array.from({ length: 1000 }, (_, index) => issue(`insight-${index}`));
		const { fetch, requests } = fakeFetch((request) => {
			const pageNumber = new URL(request.url).searchParams.get("page");
			return pageNumber === "1"
				? page(first, 1002)
				: page([issue("last-1"), issue("last-2")], 1002);
		});

		const insights = await listInsights({ accountId: ACCOUNT, token: TOKEN }, { fetch });

		expect(insights).toHaveLength(1002);
		expect(requests.map((request) => request.url)).toEqual([
			`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/security-center/insights?page=1&per_page=1000`,
			`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/security-center/insights?page=2&per_page=1000`,
		]);
		expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		// Guard only reads what it connects to.
		expect(requests.every((request) => request.method === "GET")).toBe(true);
	});

	it("maps an insight into Guard's shape", async () => {
		const { fetch } = fakeFetch(() =>
			page(
				[
					issue("a"),
					issue("b", {
						severity: "Something new",
						status: "resolved",
						dismissed: true,
						user_classification: "accept_risk",
						resolve_link: "javascript:alert(1)",
						// Seen from the real API: translation keys where the text should be.
						resolve_text: "security_center.checks.access_policies.resolution_button",
						payload: { detection_method: "security_center.checks.access_policies.detection" },
					}),
				],
				2,
			),
		);
		const [first, second] = await listInsights({ accountId: ACCOUNT, token: TOKEN }, { fetch });
		expect(first).toEqual({
			id: "a",
			issueClass: "always_use_https_not_enabled",
			issueType: "insecure_configuration",
			severity: "moderate",
			subject: "example.com",
			status: "active",
			dismissed: false,
			userClassification: null,
			detectionMethod: "We checked the zone's settings.",
			resolveText: "Turn on Always Use HTTPS",
			resolveUrl: `https://dash.cloudflare.com/${ACCOUNT}/zones/974037826/security/settings`,
			zoneTag: "zone-1",
			source: "cloudflare",
			since: "2026-10-01T00:00:00Z",
			seenAt: "2026-11-13T00:00:00Z",
		});
		expect(second).toMatchObject({
			severity: "moderate",
			status: "resolved",
			dismissed: true,
			userClassification: "accept_risk",
			resolveUrl: `https://dash.cloudflare.com/${ACCOUNT}/security-center`,
			detectionMethod: null,
			resolveText: null,
			zoneTag: null,
		});
	});

	it("reports a token without the permission as forbidden, and never repeats the token", async () => {
		const { fetch } = fakeFetch(() =>
			json(
				{ success: false, errors: [{ code: 10000, message: `Authentication error for ${TOKEN}` }] },
				{ status: 403 },
			),
		);
		const error = await listInsights({ accountId: ACCOUNT, token: TOKEN }, { fetch }).catch(
			(caught) => caught,
		);
		expect(error).toBeInstanceOf(UpstreamError);
		expect(error).toMatchObject({
			service: "cloudflare",
			failure: "forbidden",
			status: 403,
			retryable: false,
		});
		expect(JSON.stringify({ message: error.message, cause: String(error.cause) })).not.toContain(
			TOKEN,
		);
	});

	it("passes on how long Cloudflare asks to wait", async () => {
		const { fetch } = fakeFetch(
			() => new Response(null, { status: 429, headers: { "Retry-After": "30" } }),
		);
		await expect(
			listInsights({ accountId: ACCOUNT, token: TOKEN }, { fetch }),
		).rejects.toMatchObject({
			failure: "rate_limited",
			retryAfterSeconds: 30,
			retryable: true,
		});
	});

	it("does not trust an answer that does not say it succeeded", async () => {
		const { fetch } = fakeFetch(() =>
			json({ success: false, errors: [], messages: [], result: null }),
		);
		await expect(
			listInsights({ accountId: ACCOUNT, token: TOKEN }, { fetch }),
		).rejects.toMatchObject({
			failure: "invalid_response",
		});
	});

	it("sends nothing for an account id that is not one", async () => {
		const { fetch, requests } = fakeFetch(() => page([], 0));
		await expect(
			listInsights({ accountId: "../../user/tokens", token: TOKEN }, { fetch }),
		).rejects.toBeInstanceOf(UpstreamError);
		expect(requests).toHaveLength(0);
	});
});

describe("dashboardUrl", () => {
	const insights = `https://dash.cloudflare.com/${ACCOUNT}/security-center`;

	it("fills in the account and leaves the zone for the dashboard to ask", () => {
		expect(dashboardUrl("/:account_id/zones/974037826/security/settings", ACCOUNT)).toBe(
			`https://dash.cloudflare.com/${ACCOUNT}/zones/974037826/security/settings`,
		);
		expect(dashboardUrl("/profile/authentication", ACCOUNT)).toBe(
			"https://dash.cloudflare.com/profile/authentication",
		);
		const zone = new URL(
			dashboardUrl("/:account_id/:zone_name/security/settings?id=precursor", ACCOUNT),
		);
		expect(zone.origin + zone.pathname).toBe("https://dash.cloudflare.com/");
		expect(zone.searchParams.get("to")).toBe(`/${ACCOUNT}/:zone/security/settings?id=precursor`);
	});

	it("links to Security Insights when there is no path, or one that leaves the dashboard", () => {
		for (const link of [
			"",
			null,
			undefined,
			"javascript:alert(1)",
			"https://evil.example/abc",
			"//evil.example/abc",
			"/\\evil.example/abc",
			"http://dash.cloudflare.com/abc",
			"/:account_id/:mystery/abc",
		]) {
			expect(dashboardUrl(link, ACCOUNT), String(link)).toBe(insights);
		}
	});
});
