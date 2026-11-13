import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "./accounts";
import { startGuard } from "./guard-worker";

const origin = "https://guard.test";

let guard: Awaited<ReturnType<typeof startGuard>>;

beforeAll(async () => {
	guard = await startGuard(origin);
});

afterAll(async () => {
	await guard?.dispose();
});

describe("the page", () => {
	it("shows who is signed in, but not their session's token", async () => {
		const { headers } = await signUp(guard, origin, "page-token");
		const signed = /session_token=([^;]+)/.exec(headers.cookie)?.[1] ?? "";
		const token = decodeURIComponent(signed).split(".")[0] ?? "";
		expect(token.length).toBeGreaterThan(16);

		const response = await guard.fetch(`${origin}/`, { headers: { cookie: headers.cookie } });
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("page-token@example.com");
		expect(html).not.toContain(token);
	});
});
