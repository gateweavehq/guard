import { describe, expect, it } from "vitest";
import { scanRepository } from "../src/dependencies";
import { dependencyFingerprint, insightFingerprint } from "../src/fingerprint";
import { fakeFetch, json } from "./fake-fetch";

const COMMIT = "1".repeat(40);
const ROOT_LOCK = "2".repeat(40);
const OLD_LOCK = "3".repeat(40);
const WEB_LOCK = "4".repeat(40);

const PNPM = `lockfileVersion: '9.0'

packages:

  lodash@4.17.20:
    resolution: {integrity: sha512-a}

  react@18.3.1:
    resolution: {integrity: sha512-b}
`;

const NPM = JSON.stringify({
	lockfileVersion: 3,
	packages: {
		"": { name: "web" },
		"node_modules/lodash": { version: "4.17.19" },
		"node_modules/react": { version: "18.3.1" },
	},
});

describe("scanRepository", () => {
	it("reads every lockfile of the default branch and looks each package up once", async () => {
		const osvQueries: string[] = [];
		const { fetch, requests } = fakeFetch(async (request) => {
			const url = new URL(request.url);
			const path = url.pathname;
			if (url.host === "api.github.com") {
				if (path === "/repos/acme/shop") {
					return json({
						id: 7,
						name: "shop",
						owner: { login: "acme" },
						default_branch: "trunk",
						private: false,
					});
				}
				if (path === "/repos/acme/shop/git/ref/heads/trunk")
					return json({ object: { sha: COMMIT } });
				if (path === `/repos/acme/shop/git/trees/${COMMIT}`) {
					return json({
						truncated: false,
						tree: [
							{ path: "pnpm-lock.yaml", type: "blob", sha: ROOT_LOCK, size: 100 },
							{ path: "old/package-lock.json", type: "blob", sha: OLD_LOCK, size: 100 },
							{ path: "web/package-lock.json", type: "blob", sha: WEB_LOCK, size: 100 },
						],
					});
				}
				const blobs: Record<string, string> = {
					[ROOT_LOCK]: PNPM,
					[OLD_LOCK]: JSON.stringify({ lockfileVersion: 1, dependencies: {} }),
					[WEB_LOCK]: NPM,
				};
				const blob = blobs[path.slice("/repos/acme/shop/git/blobs/".length)];
				if (blob !== undefined) return new Response(blob);
			}
			if (url.host === "api.osv.dev" && path === "/v1/querybatch") {
				const { queries } = (await request.json()) as {
					queries: { package: { name: string }; version: string }[];
				};
				osvQueries.push(...queries.map((query) => `${query.package.name}@${query.version}`));
				return json({
					results: queries.map((query) =>
						query.package.name === "lodash"
							? { vulns: [{ id: "GHSA-lodash", modified: "m" }] }
							: {},
					),
				});
			}
			if (url.host === "api.osv.dev" && path === "/v1/vulns/GHSA-lodash") {
				return json({
					id: "GHSA-lodash",
					modified: "m",
					summary: "Prototype pollution in lodash",
					database_specific: { severity: "HIGH" },
					affected: [
						{
							package: { ecosystem: "npm", name: "lodash" },
							ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
						},
					],
				});
			}
			return new Response(null, { status: 404 });
		});

		const scan = await scanRepository({ owner: "acme", name: "shop" }, "token", { fetch });

		// Guard only reads what it connects to: nothing but GETs reach GitHub, and the repository's
		// token goes nowhere else.
		const github = requests.filter((request) => new URL(request.url).host === "api.github.com");
		expect(github.length).toBeGreaterThan(0);
		expect(new Set(github.map((request) => request.method))).toEqual(new Set(["GET"]));
		for (const request of requests) {
			if (new URL(request.url).host !== "api.github.com") {
				expect(request.headers.get("authorization")).toBeNull();
			}
		}
		expect(scan.commit).toBe(COMMIT);
		expect(scan.repository.defaultBranch).toBe("trunk");
		expect(osvQueries.sort()).toEqual(["lodash@4.17.19", "lodash@4.17.20", "react@18.3.1"]);
		expect(
			scan.lockfiles.map((lockfile) =>
				"unreadable" in lockfile
					? { path: lockfile.path, unreadable: lockfile.unreadable }
					: {
							path: lockfile.path,
							packages: lockfile.packages,
							vulnerable: lockfile.vulnerable.map(({ name, advisory, versions }) => ({
								name,
								id: advisory.id,
								versions,
							})),
						},
			),
		).toEqual([
			{
				path: "old/package-lock.json",
				unreadable:
					"npm lockfile version 1 is not supported; npm 7 and later write version 2 or 3.",
			},
			{
				path: "pnpm-lock.yaml",
				packages: 2,
				vulnerable: [
					{
						name: "lodash",
						id: "GHSA-lodash",
						versions: [{ version: "4.17.20", fixed: "4.17.21" }],
					},
				],
			},
			{
				path: "web/package-lock.json",
				packages: 2,
				vulnerable: [
					{
						name: "lodash",
						id: "GHSA-lodash",
						versions: [{ version: "4.17.19", fixed: "4.17.21" }],
					},
				],
			},
		]);
	});
});

describe("fingerprints", () => {
	it("name the problem, not the scan or the installed version", async () => {
		const one = await dependencyFingerprint(
			7,
			"pnpm-lock.yaml",
			{ ecosystem: "npm", name: "lodash" },
			"GHSA-1",
		);
		expect(one).toMatch(/^[0-9a-f]{64}$/);
		expect(
			await dependencyFingerprint(
				7,
				"pnpm-lock.yaml",
				{ ecosystem: "npm", name: "lodash" },
				"GHSA-1",
			),
		).toBe(one);
		expect(
			await dependencyFingerprint(
				7,
				"web/package-lock.json",
				{ ecosystem: "npm", name: "lodash" },
				"GHSA-1",
			),
		).not.toBe(one);

		const insight = await insightFingerprint("acc", {
			issueClass: "a_record_dangling",
			subject: "old.example.com",
		});
		expect(insight).not.toBe(
			await insightFingerprint("acc", { issueClass: "a_record_dangling", subject: "example.com" }),
		);
		// The parts are kept apart, so moving text from one to the next makes another fingerprint.
		expect(await insightFingerprint("acc", { issueClass: "a", subject: "bc" })).not.toBe(
			await insightFingerprint("acc", { issueClass: "ab", subject: "c" }),
		);
	});
});
