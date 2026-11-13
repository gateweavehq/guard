import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import type {
	ConnectionActionInput,
	ConnectionsPage,
	ConnectionView,
	FindingActionInput,
	FindingsPage,
} from "../src/lib/connection-schemas";
import { isSealer, sealerFor } from "../src/server/secrets";
import { createWorkspace, signUp } from "./accounts";
import { startGuard } from "./guard-worker";
import { startUpstreams } from "./upstreams";

export const origin = "https://guard.test";
export const HOURLY = "0 * * * *";

type Person = Awaited<ReturnType<typeof signUp>>;
type Guard = Awaited<ReturnType<typeof startGuard>>;

let workspaces = 0;

/** A Guard with stand-in upstreams, an owner and a workspace of theirs. */
export async function startWorld(
	options: {
		isolates?: number;
		settings?: Record<string, string>;
		isolateSettings?: Record<string, string>[];
		/** Without it, the server cannot keep tokens. */
		withoutKey?: boolean;
	} = {},
) {
	const upstream = startUpstreams();
	const key = randomBytes(32).toString("base64");
	const guard = await startGuard(origin, {
		hosts: upstream.hosts,
		isolates: options.isolates ?? 1,
		isolateSettings: options.isolateSettings ?? [],
		settings: {
			...(options.withoutKey ? {} : { SECRETS_KEY: key }),
			...upstream.settings,
			...options.settings,
		},
	});
	const owner = await signUp(guard, origin, "owner");
	const slug = `ws-${++workspaces}`;
	const workspaceId = await createWorkspace(guard, origin, owner.headers, slug);
	return new World(guard, upstream, key, owner, slug, workspaceId);
}

export class World {
	constructor(
		readonly guard: Guard,
		readonly upstream: ReturnType<typeof startUpstreams>,
		readonly key: string,
		readonly owner: Person,
		readonly slug: string,
		readonly workspaceId: string,
	) {}

	/** Adds a person to the workspace in the database, with this role. */
	async addMember(name: string, role: "member" | "admin" = "member") {
		const person = await signUp(this.guard, origin, name);
		await this.guard.db
			.prepare(
				"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
			)
			.bind(crypto.randomUUID(), this.workspaceId, person.userId, role, Date.now())
			.run();
		return person;
	}

	/** Someone with an account who is in no workspace of this one's. */
	stranger(name: string) {
		return signUp(this.guard, origin, name);
	}

	async act<T = Record<string, unknown>>(
		person: Person,
		action: ConnectionActionInput,
		slug = this.slug,
		isolate = 0,
	) {
		const response = await this.guard.fetchIn(isolate, `${origin}/api/connections/${slug}`, {
			method: "POST",
			headers: person.headers,
			body: JSON.stringify(action),
		});
		const text = await response.text();
		return {
			status: response.status,
			text,
			body: JSON.parse(text) as { ok: boolean; error?: string } & T,
		};
	}

	async connections(person: Person = this.owner, slug = this.slug) {
		const response = await this.guard.fetch(`${origin}/api/connections/${slug}`, {
			headers: person.headers,
		});
		return { status: response.status, body: (await response.json()) as ConnectionsPage };
	}

	async findings(query = "", person: Person = this.owner, slug = this.slug) {
		const response = await this.guard.fetch(`${origin}/api/findings/${slug}?${query}`, {
			headers: person.headers,
		});
		return { status: response.status, body: (await response.json()) as FindingsPage };
	}

	async changeFinding(person: Person, action: FindingActionInput, slug = this.slug) {
		const response = await this.guard.fetch(`${origin}/api/findings/${slug}`, {
			method: "POST",
			headers: person.headers,
			body: JSON.stringify(action),
		});
		return {
			status: response.status,
			body: (await response.json()) as { ok: boolean; error?: string },
		};
	}

	/** A page as the person gets it, HTML and all. */
	async page(path: string, person: Person = this.owner) {
		const response = await this.guard.fetch(`${origin}${path}`, { headers: person.headers });
		return { status: response.status, text: await response.text() };
	}

	/** Connects a Cloudflare account that the stand-in knows, and returns its connection. */
	async connectCloudflare(accountId: string, token: string, name?: string) {
		const result = await this.act<{ connection: ConnectionView; scan: { outcome: string } }>(
			this.owner,
			{ action: "connect-cloudflare", accountId, token, ...(name ? { name } : {}) },
		);
		expect(result.body.ok, result.text).toBe(true);
		return result.body;
	}

	async connectGithub(repository: string, token: string) {
		const result = await this.act<{ connection: ConnectionView; scan: { outcome: string } }>(
			this.owner,
			{ action: "connect-github", repository, token },
		);
		expect(result.body.ok, result.text).toBe(true);
		return result.body;
	}

	/** Makes a connection due, and runs the hourly trigger once. */
	async scanDue(ids: string[], isolate = 0) {
		for (const id of ids) {
			await this.guard.db
				.prepare("UPDATE connection SET next_scan_at = 0 WHERE id = ?1")
				.bind(id)
				.run();
		}
		await this.guard.runScheduled(isolate, HOURLY);
	}

	async connectionRow(id: string) {
		return this.guard.db.prepare("SELECT * FROM connection WHERE id = ?1").bind(id).first<{
			token_sealed: string;
			token_hint: string;
			last_scan_outcome: string | null;
			last_scan_at: number | null;
			next_scan_at: number;
			scan_started_at: number | null;
			github_repository_id: number | null;
		}>();
	}

	async findingRows(connectionId: string) {
		const answer = await this.guard.db
			.prepare(
				"SELECT id, fingerprint, kind, severity, title, subject, url, fixed_version, first_seen_at, last_seen_at, resolved_at, dismissed_at, dismiss_reason FROM finding WHERE connection_id = ?1 ORDER BY kind, subject",
			)
			.bind(connectionId)
			.all();
		const results = answer.results as {
			id: string;
			fingerprint: string;
			kind: string;
			severity: string;
			title: string;
			subject: string;
			url: string;
			fixed_version: string | null;
			first_seen_at: number;
			last_seen_at: number;
			resolved_at: number | null;
			dismissed_at: number | null;
			dismiss_reason: string | null;
		}[];
		return results;
	}

	/** Everything the database holds about connections, as text, to look for what must not be there. */
	async dump() {
		const tables = ["connection", "finding", "scan"];
		const rows = await Promise.all(
			tables.map((table) => this.guard.db.prepare(`SELECT * FROM ${table}`).all()),
		);
		return JSON.stringify(rows.map((one: { results: unknown[] }) => one.results));
	}

	dispose() {
		return this.guard.dispose();
	}
}

/** A token as a person would paste one, long enough to pass the form's check. */
export const cloudflareToken = (n: number) =>
	`cf-token-${String(n).padStart(2, "0")}-abcdefghijklmnopqrstuv`;
export const githubToken = (n: number) =>
	`github_pat_${String(n).padStart(2, "0")}_abcdefghijklmnopqrstuvwxyz`;

/** Seals a token as the Worker does, for tests that put connections straight into the database. */
export async function sealToken(
	key: string,
	workspaceId: string,
	connectionId: string,
	token: string,
) {
	const sealer = await sealerFor({ SECRETS_KEY: key }, workspaceId);
	if (!isSealer(sealer)) throw new Error(sealer.unavailable);
	return sealer.seal(`connection/${connectionId}/token`, token);
}
