/**
 * Stands in for Cloudflare's API, GitHub's and OSV, with answers shaped as the real ones are (the
 * shapes `packages/scan` is tested against), so that the Worker's tests never reach the internet.
 * State is plain data a test changes between scans: an insight appears, a package is fixed, a token
 * is revoked.
 */

export const ACCOUNT_ID = "023e105f4ecef8ad9ca31a8372d0c353";
export const OTHER_ACCOUNT_ID = "5fb0a1a1b2c3d4e5f60718293a4b5c6d";

export interface FakeInsight {
	id: string;
	issue_class: string;
	subject: string;
	severity?: string;
	status?: "active" | "resolved";
	dismissed?: boolean;
}

interface FakeAccount {
	token: string;
	insights: FakeInsight[];
	/** An answer to give instead of the insights, such as 500. */
	status?: number;
}

interface FakeRepository {
	id: number;
	token: string;
	branch: string;
	/** Whether the token may read contents, or only the repository itself. */
	contents: boolean;
	/** path to text */
	lockfiles: Record<string, string>;
	status?: number;
}

export interface FakeAdvisory {
	id: string;
	packageName: string;
	severity: "CRITICAL" | "HIGH" | "MODERATE" | "LOW";
	summary: string;
	fixed: string;
}

export interface Seen {
	method: string;
	host: string;
	path: string;
	authorization: string | null;
}

const COMMIT = "c".repeat(40);

/** An npm lockfile (version 3) that installs these packages. */
export function npmLock(packages: Record<string, string>): string {
	return JSON.stringify({
		name: "app",
		lockfileVersion: 3,
		packages: {
			"": { name: "app" },
			...Object.fromEntries(
				Object.entries(packages).map(([name, version]) => [
					`node_modules/${name}`,
					{ version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` },
				]),
			),
		},
	});
}

const blobSha = (path: string) => Buffer.from(path).toString("hex").padEnd(40, "0").slice(0, 40);

export function startUpstreams() {
	const accounts = new Map<string, FakeAccount>();
	const repositories = new Map<string, FakeRepository>();
	const advisories = new Map<string, FakeAdvisory>();
	const seen: Seen[] = [];
	/** Set to make OSV fail, as when it is down. */
	const osv = { down: false };
	/** While set, Cloudflare answers only once it is done, as a slow account does. */
	const hold: { until: Promise<void> | null } = { until: null };

	async function cloudflare(request: Request, path: string): Promise<Response> {
		await hold.until;
		const match = /^\/client\/v4\/accounts\/([0-9a-f]{32})\/security-center\/insights$/.exec(path);
		const account = match?.[1] ? accounts.get(match[1]) : undefined;
		if (!account) return Response.json({ success: false }, { status: 403 });
		if (request.headers.get("authorization") !== `Bearer ${account.token}`) {
			return Response.json({ success: false }, { status: 403 });
		}
		if (account.status) return new Response(null, { status: account.status });
		return Response.json({
			success: true,
			result: {
				count: account.insights.length,
				issues: account.insights.map((insight) => ({
					issue_type: "insecure_configuration",
					severity: "Moderate",
					status: "active",
					dismissed: false,
					resolve_link: "/:account_id/:zone_name/ssl-tls",
					source: "cloudflare",
					...insight,
				})),
			},
		});
	}

	function github(request: Request, path: string): Response {
		const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
		const repository = match
			? repositories.get(`${match[1]}/${match[2]}`.toLowerCase())
			: undefined;
		if (!match || !repository) return new Response(null, { status: 404 });
		if (request.headers.get("authorization") !== `Bearer ${repository.token}`) {
			return new Response(null, { status: 401 });
		}
		if (repository.status) return new Response(null, { status: repository.status });
		const rest = match[3] ?? "";
		if (rest === "") {
			return Response.json({
				id: repository.id,
				name: match[2],
				owner: { login: match[1] },
				default_branch: repository.branch,
				private: true,
			});
		}
		if (!repository.contents) return new Response(null, { status: 403 });
		if (rest === `/git/ref/heads/${repository.branch}`) {
			return Response.json({ object: { sha: COMMIT } });
		}
		if (rest.startsWith(`/git/trees/${COMMIT}`)) {
			return Response.json({
				truncated: false,
				tree: Object.entries(repository.lockfiles).map(([lockfile, text]) => ({
					path: lockfile,
					type: "blob",
					sha: blobSha(lockfile),
					size: text.length,
				})),
			});
		}
		const blob = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest)?.[1];
		const lockfile = Object.keys(repository.lockfiles).find((one) => blobSha(one) === blob);
		if (lockfile) return new Response(repository.lockfiles[lockfile]);
		return new Response(null, { status: 404 });
	}

	async function osvAnswer(request: Request, path: string): Promise<Response> {
		if (osv.down) return new Response(null, { status: 503 });
		if (path === "/v1/querybatch") {
			const { queries } = (await request.json()) as { queries: { package: { name: string } }[] };
			return Response.json({
				results: queries.map((query) => {
					const found = [...advisories.values()].filter(
						(advisory) => advisory.packageName === query.package.name,
					);
					return found.length > 0
						? { vulns: found.map((advisory) => ({ id: advisory.id, modified: "m" })) }
						: {};
				}),
			});
		}
		const advisory = advisories.get(decodeURIComponent(path.slice("/v1/vulns/".length)));
		if (!advisory) return new Response(null, { status: 404 });
		return Response.json({
			id: advisory.id,
			modified: "2026-10-01T00:00:00Z",
			summary: advisory.summary,
			database_specific: { severity: advisory.severity },
			affected: [
				{
					package: { ecosystem: "npm", name: advisory.packageName },
					ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: advisory.fixed }] }],
				},
			],
		});
	}

	const handlers = {
		"cloudflare.test": cloudflare,
		"github.test": github,
		"osv.test": osvAnswer,
	};

	const hosts: Record<string, (request: Request) => Response | Promise<Response>> = {};
	for (const [host, handler] of Object.entries(handlers)) {
		hosts[host] = (request) => {
			const path = new URL(request.url).pathname;
			seen.push({
				method: request.method,
				host,
				path,
				authorization: request.headers.get("authorization"),
			});
			return handler(request, path);
		};
	}

	return {
		accounts,
		repositories,
		advisories,
		osv,
		hold,
		/** Every request that reached a stand-in, oldest first. */
		seen,
		hosts,
		/** The Worker's settings that point it here. */
		settings: {
			CLOUDFLARE_API_URL: "https://cloudflare.test/client/v4",
			GITHUB_API_URL: "https://github.test",
			OSV_API_URL: "https://osv.test/v1",
		},
		/** A Cloudflare account that accepts this token. */
		addAccount(accountId: string, token: string, insights: FakeInsight[] = []) {
			accounts.set(accountId, { token, insights });
			return accounts.get(accountId) as FakeAccount;
		},
		/** A repository, as `owner/name`, that accepts this token. */
		addRepository(name: string, token: string, id: number, lockfiles: Record<string, string> = {}) {
			repositories.set(name.toLowerCase(), {
				id,
				token,
				branch: "main",
				contents: true,
				lockfiles,
			});
			return repositories.get(name.toLowerCase()) as FakeRepository;
		},
		addAdvisory(advisory: FakeAdvisory) {
			advisories.set(advisory.id, advisory);
		},
	};
}

export type Upstreams = ReturnType<typeof startUpstreams>;
