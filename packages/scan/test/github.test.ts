import { afterEach, describe, expect, it, vi } from "vitest";
import {
	branchHead,
	getRepository,
	listLockfiles,
	MAX_LOCKFILE_BYTES,
	parseRepositoryName,
	readBlob,
} from "../src/github";
import { fakeFetch, json } from "./fake-fetch";

const REPO = { owner: "acme", name: "shop" };
const TOKEN = "github_pat_test";
const COMMIT = "a".repeat(40);

afterEach(() => {
	vi.useRealTimers();
});

describe("parseRepositoryName", () => {
	it("reads owner/name and github.com links", () => {
		expect(parseRepositoryName("acme/shop")).toEqual(REPO);
		expect(parseRepositoryName(" https://github.com/acme/shop.git ")).toEqual(REPO);
		expect(parseRepositoryName("https://github.com/acme/shop/")).toEqual(REPO);
	});

	it("turns down anything else", () => {
		for (const input of [
			"acme",
			"acme/shop/tree/main",
			"acme/..",
			"-acme/shop",
			"https://gitlab.com/acme/shop",
			"acme/sh op",
		]) {
			expect(parseRepositoryName(input), input).toBeNull();
		}
	});
});

describe("getRepository", () => {
	it("reads the default branch with GitHub's headers", async () => {
		const { fetch, requests } = fakeFetch(() =>
			json({
				id: 42,
				name: "shop",
				owner: { login: "acme" },
				default_branch: "main",
				private: true,
			}),
		);
		expect(await getRepository(REPO, TOKEN, { fetch })).toEqual({
			id: 42,
			owner: "acme",
			name: "shop",
			defaultBranch: "main",
			private: true,
			archived: false,
		});
		const headers = requests[0]?.headers;
		expect(requests[0]?.url).toBe("https://api.github.com/repos/acme/shop");
		expect(headers?.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(headers?.get("x-github-api-version")).toBe("2022-11-28");
		expect(headers?.get("user-agent")).toBe("Gateweave Guard");
	});

	it("tells a spent rate limit from a missing permission", async () => {
		vi.useFakeTimers({ now: 1_800_000_000_000 });
		const limited = fakeFetch(
			() =>
				new Response(null, {
					status: 403,
					headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000120" },
				}),
		);
		await expect(getRepository(REPO, TOKEN, limited)).rejects.toMatchObject({
			failure: "rate_limited",
			retryAfterSeconds: 120,
		});

		const forbidden = fakeFetch(() => new Response(null, { status: 403 }));
		await expect(getRepository(REPO, TOKEN, forbidden)).rejects.toMatchObject({
			failure: "forbidden",
		});

		const missing = fakeFetch(() => new Response(null, { status: 404 }));
		await expect(getRepository(REPO, TOKEN, missing)).rejects.toMatchObject({
			failure: "not_found",
		});
	});
});

describe("branchHead", () => {
	it("keeps the slashes of a branch name in the ref's path", async () => {
		const { fetch, requests } = fakeFetch(() => json({ object: { sha: COMMIT, type: "commit" } }));
		expect(await branchHead(REPO, "release/v1 #2", TOKEN, { fetch })).toBe(COMMIT);
		expect(requests[0]?.url).toBe(
			"https://api.github.com/repos/acme/shop/git/ref/heads/release/v1%20%232",
		);
	});
});

describe("listLockfiles", () => {
	it("lists the lockfiles outside node_modules and sets aside ones too large to read", async () => {
		const { fetch, requests } = fakeFetch(() =>
			json({
				sha: COMMIT,
				truncated: true,
				tree: [
					{ path: "pnpm-lock.yaml", type: "blob", sha: "b".repeat(40), size: 1000 },
					{ path: "apps/legacy/package-lock.json", type: "blob", sha: "c".repeat(40), size: 2000 },
					{
						path: "vendor/node_modules/x/package-lock.json",
						type: "blob",
						sha: "d".repeat(40),
						size: 3,
					},
					{
						path: "huge/package-lock.json",
						type: "blob",
						sha: "e".repeat(40),
						size: MAX_LOCKFILE_BYTES + 1,
					},
					{ path: "package.json", type: "blob", sha: "f".repeat(40), size: 10 },
					{ path: "pnpm-lock.yaml.d", type: "tree", sha: "0".repeat(40) },
				],
			}),
		);
		const list = await listLockfiles(REPO, COMMIT, TOKEN, { fetch });
		expect(requests[0]?.url).toBe(
			`https://api.github.com/repos/acme/shop/git/trees/${COMMIT}?recursive=1`,
		);
		expect(list.lockfiles.map((entry) => [entry.path, entry.format])).toEqual([
			["apps/legacy/package-lock.json", "npm"],
			["pnpm-lock.yaml", "pnpm"],
		]);
		expect(list.tooLarge.map((entry) => entry.path)).toEqual(["huge/package-lock.json"]);
		expect(list.truncated).toBe(true);
	});

	it("sends nothing for a commit id that is not one", async () => {
		const { fetch, requests } = fakeFetch(() => json({}));
		await expect(listLockfiles(REPO, "main", TOKEN, { fetch })).rejects.toMatchObject({
			failure: "not_found",
		});
		expect(requests).toHaveLength(0);
	});
});

describe("readBlob", () => {
	it("asks for the raw file", async () => {
		const { fetch, requests } = fakeFetch(() => new Response("lockfileVersion: '9.0'\n"));
		expect(await readBlob(REPO, "b".repeat(40), TOKEN, { fetch })).toBe("lockfileVersion: '9.0'\n");
		expect(requests[0]?.headers.get("accept")).toBe("application/vnd.github.raw+json");
	});
});
