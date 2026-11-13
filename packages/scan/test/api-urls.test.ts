import { describe, expect, it } from "vitest";
import { listInsights } from "../src/cloudflare";
import { branchHead, getRepository } from "../src/github";
import { getAdvisory, queryAdvisories } from "../src/osv";
import { fakeFetch, json } from "./fake-fetch";

const ACCOUNT = "023e105f4ecef8ad9ca31a8372d0c353";

describe("apiUrls", () => {
	it("sends Cloudflare's requests to the address given, with or without a trailing slash", async () => {
		const { fetch, requests } = fakeFetch(() =>
			json({ success: true, result: { count: 0, issues: [] } }),
		);
		await listInsights(
			{ accountId: ACCOUNT, token: "t" },
			{ fetch, apiUrls: { cloudflare: "https://mirror.test/client/v4/" } },
		);
		expect(requests[0]?.url).toMatch(
			new RegExp(
				`^https://mirror\\.test/client/v4/accounts/${ACCOUNT}/security-center/insights\\?`,
			),
		);
	});

	it("sends GitHub's requests to the address given", async () => {
		const { fetch, requests } = fakeFetch((request) =>
			request.url.includes("/git/ref/")
				? json({ object: { sha: "a".repeat(40) } })
				: json({
						id: 1,
						name: "shop",
						owner: { login: "acme" },
						default_branch: "main",
						private: false,
					}),
		);
		const apiUrls = { github: "https://github-mirror.test" };
		const repo = await getRepository({ owner: "acme", name: "shop" }, "t", { fetch, apiUrls });
		await branchHead(repo, "main", "t", { fetch, apiUrls });
		expect(requests.map((request) => request.url)).toEqual([
			"https://github-mirror.test/repos/acme/shop",
			"https://github-mirror.test/repos/acme/shop/git/ref/heads/main",
		]);
	});

	it("sends OSV's requests to the address given, and leaves the other services alone", async () => {
		const { fetch, requests } = fakeFetch((request) =>
			request.url.endsWith("/querybatch")
				? json({ results: [{}] })
				: json({ id: "GHSA-x", modified: "2026-10-01T00:00:00Z" }),
		);
		const apiUrls = { osv: "https://osv-mirror.test/v1", github: "https://elsewhere.test" };
		await queryAdvisories([{ ecosystem: "npm", name: "a", version: "1.0.0" }], { fetch, apiUrls });
		await getAdvisory("GHSA-x", { fetch, apiUrls });
		expect(requests.map((request) => request.url)).toEqual([
			"https://osv-mirror.test/v1/querybatch",
			"https://osv-mirror.test/v1/vulns/GHSA-x",
		]);
	});

	it("uses the real hosts when none is given", async () => {
		const { fetch, requests } = fakeFetch(() => json({ results: [{}] }));
		await queryAdvisories([{ ecosystem: "npm", name: "a", version: "1.0.0" }], { fetch });
		expect(requests[0]?.url).toBe("https://api.osv.dev/v1/querybatch");
	});
});
