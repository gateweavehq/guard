import { describe, expect, it } from "vitest";
import {
	type AssistantGrant,
	firstRedirect,
	newestUseFirst,
	scopesInclude,
} from "./assistant-grants";

const grant = (clientId: string, allowedAt: number, lastUsedAt: number | null): AssistantGrant => ({
	clientId,
	name: null,
	destination: "an app on this computer",
	allowedAt,
	lastUsedAt,
});

describe("assistant grants", () => {
	it("sorts the most recently used first, and the never used by when they were allowed", () => {
		const sorted = newestUseFirst([
			grant("old-unused", 1, null),
			grant("used-long-ago", 2, 10),
			grant("new-unused", 9, null),
			grant("used-today", 3, 50),
		]);
		expect(sorted.map((one) => one.clientId)).toEqual([
			"used-today",
			"used-long-ago",
			"new-unused",
			"old-unused",
		]);
	});

	it("reads a stored scope list, and treats anything else as no scopes", () => {
		expect(scopesInclude('["openid","guard"]', "guard")).toBe(true);
		expect(scopesInclude('["openid"]', "guard")).toBe(false);
		expect(scopesInclude(["guard"], "guard")).toBe(true);
		// As D1 returns what Better Auth wrote: a JSON string holding the JSON list.
		expect(
			scopesInclude(JSON.stringify(JSON.stringify(["guard", "offline_access"])), "guard"),
		).toBe(true);
		expect(scopesInclude("guard", "guard")).toBe(false);
		expect(scopesInclude("{not json", "guard")).toBe(false);
		expect(scopesInclude(null, "guard")).toBe(false);
	});

	it("takes the first redirect address and survives a missing or broken list", () => {
		expect(firstRedirect('["http://127.0.0.1:1/cb","https://x.test/cb"]')).toBe(
			"http://127.0.0.1:1/cb",
		);
		expect(firstRedirect(JSON.stringify(JSON.stringify(["https://x.test/cb"])))).toBe(
			"https://x.test/cb",
		);
		expect(firstRedirect("[]")).toBeUndefined();
		expect(firstRedirect("nope")).toBeUndefined();
		expect(firstRedirect(null)).toBeUndefined();
	});
});
