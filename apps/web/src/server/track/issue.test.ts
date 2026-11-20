import { describe, expect, it } from "vitest";
import {
	code,
	type IssueFacts,
	issueDescription,
	issueTitle,
	issueUrl,
	parseDependencySubject,
	plain,
	priorityFor,
} from "./issue";

const dependency: IssueFacts = {
	source: "dependency",
	severity: "high",
	kind: "GHSA-35jh-r3h4-6jhm",
	subject: "lodash@4.17.20, 4.17.19 in package-lock.json",
	title: "Prototype pollution in lodash",
	url: "https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm",
	fixedVersion: "4.17.21",
	connectionKind: "github",
	connectionTarget: "acme/shop",
	connectionName: "Shop",
	guardUrl: "https://guard.example.com/acme/findings#finding-f1",
};

const insight: IssueFacts = {
	source: "cloudflare",
	severity: "moderate",
	kind: "hsts_not_enabled",
	subject: "example.com",
	title: "HSTS is off",
	url: "https://dash.cloudflare.com/acc/example.com/ssl-tls",
	fixedVersion: null,
	connectionKind: "cloudflare",
	connectionTarget: "023e105f4ecef8ad9ca31a8372d0c353",
	connectionName: "Main account",
	guardUrl: "https://guard.example.com/acme/findings#finding-f2",
};

describe("priorityFor", () => {
	it("maps severity to Track's priorities, and leaves an unknown one without", () => {
		expect(priorityFor("critical")).toBe("urgent");
		expect(priorityFor("high")).toBe("high");
		expect(priorityFor("moderate")).toBe("medium");
		expect(priorityFor("low")).toBe("low");
		expect(priorityFor("unknown")).toBeUndefined();
	});
});

describe("issueTitle", () => {
	it("names the finding and where it is", () => {
		expect(issueTitle(insight)).toBe("HSTS is off (example.com)");
	});

	it("does not say a zone twice when the title already names it", () => {
		expect(
			issueTitle({
				title: "Blocked and challenged requests on example.com were 6.0 times the usual",
				subject: "example.com",
			}),
		).toBe("Blocked and challenged requests on example.com were 6.0 times the usual");
	});

	it("stays within Track's limit", () => {
		expect(issueTitle({ title: "x".repeat(600), subject: "s" }).length).toBe(512);
	});
});

describe("parseDependencySubject", () => {
	it("splits a package, its versions and its lockfile", () => {
		expect(parseDependencySubject(dependency.subject)).toEqual({
			name: "lodash",
			versions: "4.17.20, 4.17.19",
			lockfile: "package-lock.json",
		});
	});

	it("keeps a scoped package's own @", () => {
		expect(parseDependencySubject("@scope/pkg@1.2.3 in apps/web/pnpm-lock.yaml")).toEqual({
			name: "@scope/pkg",
			versions: "1.2.3",
			lockfile: "apps/web/pnpm-lock.yaml",
		});
	});

	it("gives up on a subject of another shape", () => {
		expect(parseDependencySubject("something else")).toBeNull();
	});
});

describe("issueDescription", () => {
	it("tells what is known of a dependency, with the advisory and a way back", () => {
		const text = issueDescription(dependency);
		expect(text).toContain("**Severity:** High");
		expect(text).toContain("` acme/shop `");
		expect(text).toContain("**Package:** ` lodash `");
		expect(text).toContain("**Installed:** ` 4.17.20, 4.17.19 `");
		expect(text).toContain("**Fixed in:** ` 4.17.21 `");
		expect(text).toContain("**Lockfile:** ` package-lock.json `");
		expect(text).toContain("GHSA-35jh-r3h4-6jhm");
		expect(text).toContain("https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm");
		expect(text).toContain(
			"[Open the finding in Guard](https://guard.example.com/acme/findings#finding-f1)",
		);
	});

	it("says when no fix is known", () => {
		expect(issueDescription({ ...dependency, fixedVersion: null })).toContain(
			"no fix is known for every version installed",
		);
	});

	it("keeps the fixed version when the subject is not in the usual shape", () => {
		const text = issueDescription({ ...dependency, subject: "lodash 4.17.20 in a lockfile" });
		expect(text).toContain("- **Subject:** ` lodash 4.17.20 in a lockfile `");
		expect(text).toContain("- **Fixed in:** ` 4.17.21 `");
	});

	it("tells what is known of an insight, with Cloudflare's fix link", () => {
		const text = issueDescription(insight);
		expect(text).toContain("**Class:** ` hsts_not_enabled `");
		expect(text).toContain("account ` 023e105f4ecef8ad9ca31a8372d0c353 `");
		expect(text).toContain("(https://dash.cloudflare.com/acc/example.com/ssl-tls)");
	});

	it("links only to https addresses", () => {
		const text = issueDescription({ ...dependency, url: "javascript:alert(1)" });
		expect(text).not.toContain("javascript:");
	});

	it("lets nothing a scan wrote open a link or mention someone", () => {
		const text = issueDescription({
			...dependency,
			title: "[@Admin](mention:abc) <b>bold</b> [click](https://evil.example)",
			connectionName: "# heading",
		});
		expect(text).not.toContain("](mention:");
		expect(text).not.toContain("[click](");
		expect(text).not.toContain("<b>");
		expect(text).not.toMatch(/^# heading/m);
	});

	it("has nothing in it that is not one of the facts it was handed", () => {
		// `IssueFacts` has no field for a token or its hint, so a text built from it cannot hold one.
		const facts = { ...dependency, tokenHint: "Q7Z9" } as IssueFacts;
		expect(issueDescription(facts)).not.toContain("Q7Z9");
	});
});

describe("plain and code", () => {
	it("escape what Markdown would act on", () => {
		expect(plain("a [b](c) *d*")).toBe("a \\[b\\]\\(c\\) \\*d\\*");
		expect(plain("two\nlines")).toBe("two lines");
	});

	it("fences a code span longer than any run of backticks inside it", () => {
		expect(code("a`b")).toBe("`` a`b ``");
		expect(code("plain")).toBe("` plain `");
	});
});

describe("issueUrl", () => {
	const integration = { address: "https://track.example.com", workspaceSlug: "acme" };

	it("keeps an address on Track's own origin", () => {
		expect(issueUrl("https://track.example.com/acme/issue/DEMO-1", integration, "DEMO-1")).toBe(
			"https://track.example.com/acme/issue/DEMO-1",
		);
	});

	it("builds the address itself when Track names another origin", () => {
		expect(issueUrl("https://evil.example/phish", integration, "DEMO-1")).toBe(
			"https://track.example.com/acme/issue/DEMO-1",
		);
		expect(issueUrl("not a url", integration, "DEMO-1")).toBe(
			"https://track.example.com/acme/issue/DEMO-1",
		);
	});
});
