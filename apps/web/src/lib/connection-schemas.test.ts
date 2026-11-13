import { describe, expect, it } from "vitest";
import {
	MAX_CONNECTIONS as DB_MAX_CONNECTIONS,
	MAX_DISMISS_REASON as DB_MAX_DISMISS_REASON,
	SEVERITIES as DB_SEVERITIES,
	FINDING_SOURCES,
	KEPT_SCANS,
} from "../server/db/connections-schema";
import {
	ConnectionAction,
	FindingAction,
	FindingFilters,
	MAX_CONNECTIONS,
	MAX_DISMISS_REASON,
	SEVERITIES,
	SOURCES,
	tokenField,
} from "./connection-schemas";

describe("what pages and the database agree on", () => {
	it("keeps the page's limits and words the same as the database's", () => {
		expect(MAX_CONNECTIONS).toBe(DB_MAX_CONNECTIONS);
		expect(MAX_CONNECTIONS).toBe(50);
		expect(MAX_DISMISS_REASON).toBe(DB_MAX_DISMISS_REASON);
		expect([...SEVERITIES]).toEqual([...DB_SEVERITIES]);
		expect([...SOURCES]).toEqual([...FINDING_SOURCES]);
		expect(KEPT_SCANS).toBe(30);
	});
});

describe("tokenField", () => {
	it("takes 20 to 400 printable characters with no spaces, trimmed", () => {
		expect(tokenField.safeParse(`  ${"a".repeat(20)}  `).data).toBe("a".repeat(20));
		expect(tokenField.safeParse("a".repeat(400)).success).toBe(true);
		for (const odd of [
			"a".repeat(19),
			"a".repeat(401),
			`${"a".repeat(20)} b`,
			`${"a".repeat(20)}é`,
			"",
		]) {
			expect(tokenField.safeParse(odd).success, odd).toBe(false);
		}
	});
});

describe("ConnectionAction", () => {
	const token = "t".repeat(30);

	it("lowercases an account id and turns down one that is not 32 hex characters", () => {
		const id = "023E105F4ECEF8AD9CA31A8372D0C353";
		const parsed = ConnectionAction.parse({ action: "connect-cloudflare", accountId: id, token });
		expect(parsed).toMatchObject({ accountId: id.toLowerCase() });
		for (const bad of ["", "xyz", id.slice(1), `${id}0`, id.replace("0", "g")]) {
			expect(
				ConnectionAction.safeParse({ action: "connect-cloudflare", accountId: bad, token }).success,
			).toBe(false);
		}
	});

	it("drops an empty name and refuses a long one", () => {
		const parsed = ConnectionAction.parse({
			action: "connect-github",
			repository: "a/b",
			token,
			name: "   ",
		});
		expect("name" in parsed && parsed.name).toBeUndefined();
		expect(
			ConnectionAction.safeParse({
				action: "connect-github",
				repository: "a/b",
				token,
				name: "n".repeat(101),
			}).success,
		).toBe(false);
	});
});

describe("FindingAction and FindingFilters", () => {
	it("needs a reason of at most 200 characters to dismiss", () => {
		expect(
			FindingAction.safeParse({ action: "dismiss", id: "x", reason: "a".repeat(200) }).success,
		).toBe(true);
		for (const reason of ["", "  ", "a".repeat(201)]) {
			expect(FindingAction.safeParse({ action: "dismiss", id: "x", reason }).success).toBe(false);
		}
	});

	it("ignores filters it does not know instead of trusting them", () => {
		expect(FindingFilters.parse({ severity: "bogus", source: "x", status: "y" })).toEqual({
			severity: undefined,
			source: undefined,
			status: undefined,
		});
		expect(
			FindingFilters.parse({ severity: "high", source: "dependency", status: "resolved" }),
		).toEqual({
			severity: "high",
			source: "dependency",
			status: "resolved",
		});
	});
});
