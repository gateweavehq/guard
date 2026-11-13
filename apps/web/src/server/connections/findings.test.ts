import type { Insight, RepositoryScan } from "@gateweave/guard-scan";
import { describe, expect, it } from "vitest";
import { dependencyFindings, highestFix, insightFindings } from "./findings";

const ACCOUNT = "023e105f4ecef8ad9ca31a8372d0c353";

function insight(fields: Partial<Insight>): Insight {
	return {
		id: "i",
		issueClass: "hsts_not_enabled",
		issueType: "insecure_configuration",
		severity: "moderate",
		subject: "example.com",
		status: "active",
		dismissed: false,
		userClassification: null,
		detectionMethod: null,
		resolveText: null,
		resolveUrl: `https://dash.cloudflare.com/${ACCOUNT}/security-center`,
		zoneTag: null,
		source: "cloudflare",
		since: null,
		seenAt: null,
		...fields,
	};
}

describe("insightFindings", () => {
	it("counts only active insights that nobody dismissed in Cloudflare", async () => {
		const found = await insightFindings(ACCOUNT, [
			insight({ id: "a" }),
			insight({ id: "b", issueClass: "dmarc", status: "resolved" }),
			insight({ id: "c", issueClass: "spf", dismissed: true }),
		]);
		expect(found.map((one) => one.kind)).toEqual(["hsts_not_enabled"]);
		expect(found[0]).toMatchObject({
			title: "HSTS is off",
			source: "cloudflare",
			fixedVersion: null,
		});
	});

	it("names one problem once, however many insights say it, keeping the worst", async () => {
		const found = await insightFindings(ACCOUNT, [
			insight({ id: "a", severity: "low" }),
			insight({ id: "b", severity: "critical" }),
		]);
		expect(found).toHaveLength(1);
		expect(found[0]?.severity).toBe("critical");
	});
});

describe("highestFix", () => {
	it("is the highest of the fixes, and none when any version has no fix", () => {
		expect(highestFix(["4.17.21", "4.17.9", "4.18.0"])).toBe("4.18.0");
		expect(highestFix(["1.0.0-rc.1", "1.0.0"])).toBe("1.0.0");
		expect(highestFix(["4.17.21", null])).toBeNull();
		expect(highestFix(["a commit"])).toBeNull();
		expect(highestFix([])).toBeNull();
	});
});

describe("dependencyFindings", () => {
	const advisory = {
		id: "GHSA-x",
		aliases: [],
		summary: "Prototype pollution",
		severity: "high" as const,
		cvss: null,
		published: null,
		modified: "m",
		withdrawn: null,
		url: "https://osv.dev/vulnerability/GHSA-x",
		affected: [],
	};
	const scan = (lockfiles: RepositoryScan["lockfiles"], extra: Partial<RepositoryScan> = {}) =>
		({
			repository: {
				id: 42,
				owner: "a",
				name: "b",
				defaultBranch: "main",
				private: true,
				archived: false,
			},
			commit: "c".repeat(40),
			lockfiles,
			tooLarge: [],
			truncated: false,
			...extra,
		}) satisfies RepositoryScan;

	it("makes one finding per lockfile, package and advisory, and says which it could not judge", async () => {
		const vulnerable = [
			{
				ecosystem: "npm" as const,
				name: "lodash",
				advisory,
				versions: [
					{ version: "4.17.19", fixed: "4.17.21" },
					{ version: "4.17.20", fixed: "4.17.21" },
				],
			},
		];
		const result = await dependencyFindings(
			scan(
				[
					{ path: "a/package-lock.json", format: "npm", packages: 3, vulnerable },
					{ path: "b/package-lock.json", format: "npm", packages: 3, vulnerable },
					{ path: "old/package-lock.json", format: "npm", unreadable: "version 1" },
				],
				{ tooLarge: ["huge/pnpm-lock.yaml"] },
			),
		);
		expect(result.findings).toHaveLength(2);
		expect(new Set(result.findings.map((one) => one.fingerprint)).size).toBe(2);
		expect(result.findings[0]).toMatchObject({
			source: "dependency",
			kind: "GHSA-x",
			severity: "high",
			subject: "lodash@4.17.19, 4.17.20 in a/package-lock.json",
			title: "Prototype pollution",
			url: "https://osv.dev/vulnerability/GHSA-x",
			fixedVersion: "4.17.21",
		});
		expect(result.unjudged).toEqual(["huge/pnpm-lock.yaml", "old/package-lock.json"]);
		expect(result.partial).toBe(false);
	});

	// A later scan that can't read the lockfile keeps its findings open by that ending.
	it("ends the subject with the whole lockfile path, however many versions are installed", async () => {
		const versions = Array.from({ length: 200 }, (_, n) => ({
			version: `4.17.${n}`,
			fixed: "4.17.300",
		}));
		const path = "packages/a-rather-long-workspace-name/pnpm-lock.yaml";
		const result = await dependencyFindings(
			scan([
				{
					path,
					format: "pnpm",
					packages: 200,
					vulnerable: [{ ecosystem: "npm", name: "lodash", advisory, versions }],
				},
			]),
		);
		const subject = result.findings[0]?.subject ?? "";
		expect(subject.endsWith(` in ${path}`)).toBe(true);
		expect(subject.startsWith("lodash@4.17.0, 4.17.1")).toBe(true);
		expect(subject).toContain("…");
	});

	it("keeps the same fingerprint when the installed version moves but is still affected", async () => {
		const at = (version: string) =>
			dependencyFindings(
				scan([
					{
						path: "package-lock.json",
						format: "npm",
						packages: 1,
						vulnerable: [
							{
								ecosystem: "npm",
								name: "lodash",
								advisory,
								versions: [{ version, fixed: "4.17.21" }],
							},
						],
					},
				]),
			);
		expect((await at("4.17.19")).findings[0]?.fingerprint).toBe(
			(await at("4.17.20")).findings[0]?.fingerprint,
		);
	});
});
