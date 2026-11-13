import { describe, expect, it } from "vitest";
import { insightTitle, KNOWN_INSIGHT_CLASSES } from "./titles";

// Seen on a real account, where the API sometimes sends translation keys instead of text.
const SEEN = [
	"security_txt_not_enabled",
	"dmarc",
	"spf",
	"hsts_not_enabled",
	"always_https_not_enabled",
	"tls_not_enabled",
	"tls_version_old",
	"manage_bot_fight_mode",
	"no_challenge_ai_bots",
	"cname_record_not_proxied",
	"argo_smart_routing_not_enabled",
	"polish_not_enabled",
	"skip_above_threshold",
	"precursor_not_enabled",
	"mfa_not_enabled",
	"access_policy_insecure",
];

describe("insightTitle", () => {
	it("has a title for every class seen on a real account, none of them a translation key", () => {
		for (const issueClass of SEEN) {
			expect(KNOWN_INSIGHT_CLASSES).toContain(issueClass);
			const title = insightTitle(issueClass);
			expect(title.length).toBeGreaterThan(3);
			expect(title).not.toContain("_");
			expect(title).not.toMatch(/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/);
			expect(title).not.toBe(insightTitle("some_other_unseen_class"));
		}
		expect(insightTitle("hsts_not_enabled")).toBe("HSTS is off");
	});

	it("makes a readable title of a class it has not seen", () => {
		expect(insightTitle("some_new_check_class")).toBe("Some new check class");
		expect(insightTitle("Always_HTTPS")).toBe("Always https");
		expect(insightTitle("")).toBe("Security Center insight");
		expect(insightTitle("___")).toBe("Security Center insight");
	});

	it("does not mistake a property of objects for a class", () => {
		expect(insightTitle("constructor")).toBe("Constructor");
		expect(insightTitle("__proto__")).toBe("Proto");
		expect(insightTitle("toString")).toBe("Tostring");
	});
});
