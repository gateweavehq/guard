import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/errors";
import type { InstalledPackage } from "../src/lockfiles";
import {
	type Advisory,
	findVulnerablePackages,
	fixedVersion,
	getAdvisory,
	queryAdvisories,
} from "../src/osv";
import { fakeFetch, json } from "./fake-fetch";

const npm = (name: string, version: string): InstalledPackage => ({
	ecosystem: "npm",
	name,
	version,
});

interface BatchQuery {
	package: { ecosystem: string; name: string };
	version: string;
	page_token?: string;
}

async function queriesOf(request: Request): Promise<BatchQuery[]> {
	return ((await request.json()) as { queries: BatchQuery[] }).queries;
}

function record(id: string, fields: Record<string, unknown> = {}) {
	return {
		id,
		modified: "2026-10-01T00:00:00Z",
		published: "2026-09-01T00:00:00Z",
		summary: `Problem ${id}`,
		aliases: [`CVE-2026-${id.length}`],
		affected: [
			{
				package: { ecosystem: "npm", name: "lodash" },
				ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
			},
		],
		database_specific: { severity: "HIGH" },
		...fields,
	};
}

describe("queryAdvisories", () => {
	it("asks once per package and follows each query's own next pages", async () => {
		const { fetch, requests } = fakeFetch(async (request) => {
			const queries = await queriesOf(request);
			return json({
				results: queries.map((query) => {
					if (query.package.name === "lodash" && query.page_token === undefined) {
						return { vulns: [{ id: "GHSA-1", modified: "m1" }], next_page_token: "page-2" };
					}
					if (query.package.name === "lodash") return { vulns: [{ id: "GHSA-2", modified: "m2" }] };
					return {};
				}),
			});
		});

		const results = await queryAdvisories(
			[npm("lodash", "4.17.20"), npm("react", "18.3.1"), npm("lodash", "4.17.20")],
			{ fetch },
		);

		expect(results).toEqual([
			[
				{ id: "GHSA-1", modified: "m1" },
				{ id: "GHSA-2", modified: "m2" },
			],
			[],
			[
				{ id: "GHSA-1", modified: "m1" },
				{ id: "GHSA-2", modified: "m2" },
			],
		]);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.url).toBe("https://api.osv.dev/v1/querybatch");
		expect(await queriesOf(requests[0] as Request)).toEqual([
			{ package: { ecosystem: "npm", name: "lodash" }, version: "4.17.20" },
			{ package: { ecosystem: "npm", name: "react" }, version: "18.3.1" },
		]);
		expect(await queriesOf(requests[1] as Request)).toEqual([
			{ package: { ecosystem: "npm", name: "lodash" }, version: "4.17.20", page_token: "page-2" },
		]);
	});

	it("splits more than a thousand packages over several requests", async () => {
		const sizes: number[] = [];
		const { fetch } = fakeFetch(async (request) => {
			const queries = await queriesOf(request);
			sizes.push(queries.length);
			return json({ results: queries.map(() => ({})) });
		});
		const packages = Array.from({ length: 2500 }, (_, index) => npm(`package-${index}`, "1.0.0"));
		expect(await queryAdvisories(packages, { fetch })).toHaveLength(2500);
		expect(sizes).toEqual([1000, 1000, 500]);
	});

	it("does not trust an answer with the wrong number of results", async () => {
		const { fetch } = fakeFetch(() => json({ results: [] }));
		await expect(queryAdvisories([npm("react", "18.3.1")], { fetch })).rejects.toMatchObject({
			service: "osv",
			failure: "invalid_response",
		});
	});

	it("reports OSV being down as something to retry", async () => {
		const { fetch } = fakeFetch(() => new Response("oops", { status: 503 }));
		const error = await queryAdvisories([npm("react", "18.3.1")], { fetch }).catch(
			(caught) => caught,
		);
		expect(error).toBeInstanceOf(UpstreamError);
		expect(error).toMatchObject({ failure: "unavailable", status: 503, retryable: true });
	});
});

describe("getAdvisory", () => {
	it("reads an advisory's severity, aliases and link", async () => {
		const { fetch, requests } = fakeFetch(() =>
			json(record("GHSA-p6mc-m468-83gw", { database_specific: { severity: "MODERATE" } })),
		);
		const advisory = await getAdvisory("GHSA-p6mc-m468-83gw", { fetch });
		expect(requests[0]?.url).toBe("https://api.osv.dev/v1/vulns/GHSA-p6mc-m468-83gw");
		expect(advisory).toMatchObject({
			id: "GHSA-p6mc-m468-83gw",
			severity: "moderate",
			summary: "Problem GHSA-p6mc-m468-83gw",
			withdrawn: null,
			url: "https://osv.dev/vulnerability/GHSA-p6mc-m468-83gw",
		});
	});

	it("counts a malicious package as critical and falls back to the details for a summary", async () => {
		const { fetch } = fakeFetch(() =>
			json(
				record("MAL-2026-1234", {
					summary: undefined,
					details: "\nMalicious code in evil-package (npm)\n\nMore text.",
					database_specific: undefined,
				}),
			),
		);
		expect(await getAdvisory("MAL-2026-1234", { fetch })).toMatchObject({
			severity: "critical",
			summary: "Malicious code in evil-package (npm)",
		});
	});

	it("keeps going when OSV adds a kind of range event this code does not know", async () => {
		const { fetch } = fakeFetch(() =>
			json(
				record("GHSA-x", {
					affected: [
						{
							package: { ecosystem: "npm", name: "lodash" },
							ranges: [
								{
									type: "SEMVER",
									events: [{ introduced: "0" }, { superseded: "2" }, { fixed: "4.17.21" }],
								},
							],
						},
					],
				}),
			),
		);
		const advisory = await getAdvisory("GHSA-x", { fetch });
		expect(advisory.affected[0]?.ranges[0]?.events).toEqual([
			{ introduced: "0" },
			{ fixed: "4.17.21" },
		]);
		expect(advisory.severity).toBe("high");
	});

	it("turns down another advisory than the one asked for, and ids that are not ids", async () => {
		const { fetch, requests } = fakeFetch(() => json(record("GHSA-other")));
		await expect(getAdvisory("GHSA-asked", { fetch })).rejects.toMatchObject({
			failure: "invalid_response",
		});
		await expect(getAdvisory("../v1/query", { fetch })).rejects.toBeInstanceOf(UpstreamError);
		expect(requests).toHaveLength(1);
	});
});

function advisory(ranges: Advisory["affected"][number]["ranges"], name = "lodash"): Advisory {
	return {
		id: "GHSA-test",
		aliases: [],
		summary: "",
		severity: "high",
		cvss: null,
		published: null,
		modified: "",
		withdrawn: null,
		url: "",
		affected: [{ ecosystem: "npm", name, ranges, versions: [] }],
	};
}

describe("fixedVersion", () => {
	it("finds the version that ends the range the installed version is in", () => {
		const twoRanges = advisory([
			{
				type: "SEMVER",
				events: [
					{ introduced: "2.0.0" },
					{ fixed: "2.1.0" },
					{ introduced: "0" },
					{ fixed: "1.2.3" },
				],
			},
		]);
		expect(fixedVersion(twoRanges, npm("lodash", "1.0.0"))).toBe("1.2.3");
		expect(fixedVersion(twoRanges, npm("lodash", "2.0.5"))).toBe("2.1.0");
		expect(fixedVersion(twoRanges, npm("lodash", "1.5.0"))).toBeNull();
		expect(fixedVersion(twoRanges, npm("lodash", "2.1.0"))).toBeNull();
	});

	it("knows that a pre-release comes before its release", () => {
		const range = advisory([
			{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "3.0.0-rc.2" }] },
		]);
		expect(fixedVersion(range, npm("lodash", "3.0.0-rc.1"))).toBe("3.0.0-rc.2");
		expect(fixedVersion(range, npm("lodash", "3.0.0"))).toBeNull();
	});

	it("gives no fix when the advisory only says which version was last affected", () => {
		const range = advisory([
			{ type: "SEMVER", events: [{ introduced: "1.0.0" }, { last_affected: "1.4.0" }] },
		]);
		expect(fixedVersion(range, npm("lodash", "1.2.0"))).toBeNull();
	});

	it("only looks at the installed package's own entry", () => {
		const other = advisory(
			[{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "9.0.0" }] }],
			"lodash-es",
		);
		expect(fixedVersion(other, npm("lodash", "1.0.0"))).toBeNull();
	});
});

describe("findVulnerablePackages", () => {
	it("returns one entry per package and advisory, most severe first, without withdrawn ones", async () => {
		const records: Record<string, unknown> = {
			"GHSA-high": record("GHSA-high"),
			"GHSA-critical": record("GHSA-critical", {
				database_specific: { severity: "CRITICAL" },
				affected: [
					{
						package: { ecosystem: "npm", name: "minimist" },
						ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.2.6" }] }],
					},
				],
			}),
			"GHSA-gone": record("GHSA-gone", { withdrawn: "2026-10-02T00:00:00Z" }),
		};
		const { fetch, requests } = fakeFetch(async (request) => {
			const url = new URL(request.url);
			if (url.pathname === "/v1/querybatch") {
				const queries = await queriesOf(request);
				return json({
					results: queries.map((query) => {
						if (query.package.name === "lodash") {
							return {
								vulns: [
									{ id: "GHSA-high", modified: "m" },
									{ id: "GHSA-gone", modified: "m" },
								],
							};
						}
						if (query.package.name === "minimist")
							return { vulns: [{ id: "GHSA-critical", modified: "m" }] };
						return {};
					}),
				});
			}
			const id = decodeURIComponent(url.pathname.slice("/v1/vulns/".length));
			return records[id] ? json(records[id]) : new Response(null, { status: 404 });
		});

		const found = await findVulnerablePackages(
			[
				npm("lodash", "4.17.20"),
				npm("lodash", "4.17.19"),
				npm("minimist", "1.2.5"),
				npm("react", "18.3.1"),
			],
			{ fetch },
		);

		expect(
			found.map(({ name, advisory, versions }) => ({ name, id: advisory.id, versions })),
		).toEqual([
			{ name: "minimist", id: "GHSA-critical", versions: [{ version: "1.2.5", fixed: "1.2.6" }] },
			{
				name: "lodash",
				id: "GHSA-high",
				versions: [
					{ version: "4.17.20", fixed: "4.17.21" },
					{ version: "4.17.19", fixed: "4.17.21" },
				],
			},
		]);
		// One batch, then each advisory once.
		expect(requests.map((request) => new URL(request.url).pathname).sort()).toEqual([
			"/v1/querybatch",
			"/v1/vulns/GHSA-critical",
			"/v1/vulns/GHSA-gone",
			"/v1/vulns/GHSA-high",
		]);
	});
});
