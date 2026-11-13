/**
 * What a Security Insight is called on the Findings page. The API sometimes sends a translation key
 * where its text should be (`packages/scan` drops those), so Guard keeps a short English title for
 * each `issue_class` it has seen on a real account. Each says what is wrong and nothing it cannot
 * check, and the finding links to the dashboard for the rest. One title for a class Guard has not
 * seen is made from its name.
 */
const TITLES: Readonly<Record<string, string>> = {
	security_txt_not_enabled: "No security.txt is published",
	// The class does not say which of the two it is, so neither do these.
	dmarc: "DMARC is missing or misconfigured",
	spf: "SPF is missing or misconfigured",
	hsts_not_enabled: "HSTS is off",
	always_https_not_enabled: "Always Use HTTPS is off",
	tls_not_enabled: "TLS is off",
	tls_version_old: "An old TLS version is still allowed",
	manage_bot_fight_mode: "Bot Fight Mode is not on",
	no_challenge_ai_bots: "AI bots are not challenged",
	cname_record_not_proxied: "A CNAME record is not proxied",
	argo_smart_routing_not_enabled: "Argo Smart Routing is off",
	polish_not_enabled: "Polish is off",
	skip_above_threshold: "Skip rules go above the threshold",
	precursor_not_enabled: "Precursor is not enabled",
	mfa_not_enabled: "Multi-factor authentication is not enabled",
	access_policy_insecure: "An Access policy is insecure",
};

/** "always_https_not_enabled" as "Always https not enabled". */
function readable(issueClass: string): string {
	const words = issueClass.replace(/[^A-Za-z0-9]+/g, " ").trim();
	if (words === "") return "Security Center insight";
	return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

export function insightTitle(issueClass: string): string {
	return Object.hasOwn(TITLES, issueClass) ? (TITLES[issueClass] as string) : readable(issueClass);
}

/** The classes with a title of their own, for the test that keeps the list from shrinking. */
export const KNOWN_INSIGHT_CLASSES: readonly string[] = Object.keys(TITLES);
