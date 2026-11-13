import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startGuard } from "./guard-worker";

// The legal notice has to be easy to reach, and they are one deployment's own: a copy someone else
// runs must show none unless it sets its own. These read the HTML the server sends.

const origin = "https://guard.test";
const SIGN_IN_PAGES = ["/login", "/forgot-password", "/reset-password", "/invite/none"];

type Guard = Awaited<ReturnType<typeof startGuard>>;

async function page(guard: Guard, path: string, headers: Record<string, string> = {}) {
	const response = await guard.fetch(`${origin}${path}`, { headers });
	expect(response.status).toBe(200);
	return response.text();
}

function expectLinks(html: string) {
	for (const [words, address] of [
		["Legal notice", "https://legal.test/notice?from=guard&amp;lang=en"],
		["Privacy", "https://legal.test/privacy"],
		["Terms", "https://legal.test/terms"],
	]) {
		const link = [...html.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].find(
			([, attributes, text]) => text === words && attributes?.includes(`href="${address}"`),
		);
		expect(link?.[1], words).toContain('rel="noreferrer"');
	}
}

describe("a deployment that sets its legal pages", () => {
	let guard: Guard;

	beforeAll(async () => {
		guard = await startGuard(origin, {
			settings: {
				LEGAL_NOTICE_URL: "https://legal.test/notice?from=guard&lang=en",
				PRIVACY_POLICY_URL: "https://legal.test/privacy",
				TERMS_URL: "https://legal.test/terms",
			},
		});
	});

	afterAll(async () => {
		await guard?.dispose();
	});

	it.each(SIGN_IN_PAGES)("links them from %s, passing on no address", async (path) => {
		expectLinks(await page(guard, path));
	});

	it("says at sign-in that continuing means agreeing to the terms", async () => {
		expect(await page(guard, "/login")).toContain("By continuing, you agree to the");
		expect(await page(guard, "/forgot-password")).not.toContain("By continuing");
	});

	it("links them from the workspace list, and gives them to the workspace menu", async () => {
		const { headers } = await signUp(guard, origin, "legal-links");
		await createWorkspace(guard, origin, headers, "legal-links");
		const { cookie } = headers;
		expectLinks(await page(guard, "/", { cookie }));
		// The menu opens only in the browser, but what it shows comes with the page.
		const inside = await page(guard, "/legal-links/findings", { cookie });
		expect(inside).toContain("https://legal.test/terms");
		expect(inside).toContain("https://legal.test/privacy");
	});
});

describe("a deployment that sets none", () => {
	let guard: Guard;

	beforeAll(async () => {
		guard = await startGuard(origin);
	});

	afterAll(async () => {
		await guard?.dispose();
	});

	it.each(SIGN_IN_PAGES)("shows nothing of the kind on %s", async (path) => {
		const html = await page(guard, path);
		expect(html).not.toContain("Legal notice");
		expect(html).not.toContain("By continuing");
		expect(html).not.toContain('aria-label="Legal"');
		expect(html).not.toContain("gateweave.com");
	});
});

describe("settings that are not addresses people can open", () => {
	let guard: Guard;

	beforeAll(async () => {
		guard = await startGuard(origin, {
			settings: {
				LEGAL_NOTICE_URL: "javascript:alert(1)",
				PRIVACY_POLICY_URL: "not an address",
				TERMS_URL: "http://legal.test/terms",
			},
		});
	});

	afterAll(async () => {
		await guard?.dispose();
	});

	it("leaves them out, and keeps the one that is", async () => {
		const html = await page(guard, "/login");
		expect(html).not.toContain("javascript:alert");
		expect(html).not.toContain("not an address");
		expect(html).not.toMatch(/>Legal notice</);
		expect(html).not.toMatch(/>Privacy</);
		expect(html).toMatch(/<a [^>]*href="http:\/\/legal\.test\/terms"[^>]*>Terms<\/a>/);
	});
});
