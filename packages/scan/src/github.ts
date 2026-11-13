import { z } from "zod";
import { UpstreamError } from "./errors";
import { apiBase, type FetchOptions, readJson, retryAfterSeconds, send } from "./http";
import { type LockfileFormat, lockfileFormat } from "./lockfiles";

// GitHub, read with a fine-grained token limited to the repositories someone chose, with
// "Contents: Read" and nothing more. Guard reads the default branch's file list and its
// lockfiles, never other files and never writes.

const GITHUB_API = "https://api.github.com";
/** Lockfiles past this are skipped rather than read into a Worker's memory. */
export const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;

export interface RepositoryName {
	readonly owner: string;
	readonly name: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** "owner/name" or a github.com URL of a repository; null for anything else. */
export function parseRepositoryName(input: string): RepositoryName | null {
	let path = input.trim();
	const url = /^https:\/\/github\.com\/(.+?)\/?$/.exec(path);
	if (url?.[1]) path = url[1].replace(/\.git$/, "");
	const [owner, name, ...rest] = path.split("/");
	if (owner === undefined || name === undefined || rest.length > 0) return null;
	if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
	return { owner, name };
}

function headers(token: string, accept = "application/vnd.github+json"): HeadersInit {
	return {
		Accept: accept,
		Authorization: `Bearer ${token}`,
		"User-Agent": "Gateweave Guard",
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

/** GitHub answers a spent rate limit with 403 or 429 and says when it resets. */
function rateLimit(response: Response): UpstreamError | null {
	if (response.status !== 403 && response.status !== 429) return null;
	const retry = retryAfterSeconds(response);
	const remaining = response.headers.get("x-ratelimit-remaining");
	if (retry === null && remaining !== "0") return null;
	const reset = Number(response.headers.get("x-ratelimit-reset"));
	const untilReset =
		Number.isFinite(reset) && reset > 0 ? Math.max(0, Math.ceil(reset - Date.now() / 1000)) : null;
	return new UpstreamError("github", "rate_limited", "github's rate limit is spent", {
		status: response.status,
		retryAfterSeconds: retry ?? untilReset,
	});
}

function repoPath({ owner, name }: RepositoryName, options: FetchOptions): string {
	if (!OWNER.test(owner) || !NAME.test(name)) {
		throw new UpstreamError("github", "not_found", "That is not a GitHub repository name");
	}
	return `${apiBase(options, "github", GITHUB_API)}/repos/${owner}/${name}`;
}

export interface Repository extends RepositoryName {
	readonly id: number;
	readonly defaultBranch: string;
	readonly private: boolean;
	readonly archived: boolean;
}

const repositoryResponse = z.object({
	id: z.number().int(),
	name: z.string(),
	owner: z.object({ login: z.string() }),
	default_branch: z.string().min(1),
	private: z.boolean(),
	archived: z.boolean().catch(false),
});

export async function getRepository(
	repo: RepositoryName,
	token: string,
	options: FetchOptions = {},
): Promise<Repository> {
	const response = await send(
		"github",
		repoPath(repo, options),
		{ headers: headers(token) },
		options,
		rateLimit,
	);
	const data = await readJson("github", response, repositoryResponse);
	return {
		id: data.id,
		owner: data.owner.login,
		name: data.name,
		defaultBranch: data.default_branch,
		private: data.private,
		archived: data.archived,
	};
}

const refResponse = z.object({ object: z.object({ sha: z.string().regex(/^[0-9a-f]{40,64}$/) }) });

/** The commit a branch points at, so that a scan reads one consistent snapshot. */
export async function branchHead(
	repo: RepositoryName,
	branch: string,
	token: string,
	options: FetchOptions = {},
): Promise<string> {
	const ref = branch.split("/").map(encodeURIComponent).join("/");
	const response = await send(
		"github",
		`${repoPath(repo, options)}/git/ref/heads/${ref}`,
		{ headers: headers(token) },
		options,
		rateLimit,
	);
	return (await readJson("github", response, refResponse)).object.sha;
}

export interface LockfileEntry {
	readonly path: string;
	readonly format: LockfileFormat;
	/** The blob's id, which changes only when the file does. */
	readonly sha: string;
	readonly size: number;
}

export interface LockfileList {
	readonly lockfiles: readonly LockfileEntry[];
	/** Lockfiles too large to read. */
	readonly tooLarge: readonly LockfileEntry[];
	/** GitHub listed only part of a very large repository; some lockfiles may be missing. */
	readonly truncated: boolean;
}

const treeResponse = z.object({
	truncated: z.boolean().catch(false),
	tree: z.array(
		z.object({
			path: z.string(),
			type: z.string(),
			sha: z.string(),
			size: z.number().int().nonnegative().optional(),
		}),
	),
});

/** The lockfiles in a commit, outside any node_modules folder that was committed. */
export async function listLockfiles(
	repo: RepositoryName,
	commit: string,
	token: string,
	options: FetchOptions = {},
): Promise<LockfileList> {
	if (!/^[0-9a-f]{40,64}$/.test(commit)) {
		throw new UpstreamError("github", "not_found", "That is not a commit id");
	}
	const response = await send(
		"github",
		`${repoPath(repo, options)}/git/trees/${commit}?recursive=1`,
		{ headers: headers(token) },
		options,
		rateLimit,
	);
	const { tree, truncated } = await readJson("github", response, treeResponse);
	const lockfiles: LockfileEntry[] = [];
	const tooLarge: LockfileEntry[] = [];
	for (const item of tree) {
		if (item.type !== "blob" || item.path.split("/").includes("node_modules")) continue;
		const format = lockfileFormat(item.path);
		if (format === null) continue;
		const entry = { path: item.path, format, sha: item.sha, size: item.size ?? 0 };
		(entry.size > MAX_LOCKFILE_BYTES ? tooLarge : lockfiles).push(entry);
	}
	lockfiles.sort((a, b) => (a.path < b.path ? -1 : 1));
	return { lockfiles, tooLarge, truncated };
}

/** A file's text by its blob id. GitHub sends blobs of up to 100 MB raw. */
export async function readBlob(
	repo: RepositoryName,
	sha: string,
	token: string,
	options: FetchOptions = {},
): Promise<string> {
	if (!/^[0-9a-f]{40,64}$/.test(sha)) {
		throw new UpstreamError("github", "not_found", "That is not a blob id");
	}
	const response = await send(
		"github",
		`${repoPath(repo, options)}/git/blobs/${sha}`,
		{ headers: headers(token, "application/vnd.github.raw+json") },
		options,
		rateLimit,
	);
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > MAX_LOCKFILE_BYTES) {
		await response.body?.cancel();
		throw new UpstreamError("github", "invalid_response", "github sent a file larger than allowed");
	}
	return response.text();
}
