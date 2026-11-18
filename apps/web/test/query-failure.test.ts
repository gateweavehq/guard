import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	Client,
	type OAuthClientInformationMixed,
	type OAuthClientProvider,
	type OAuthTokens,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOURLY, origin, startWorld, type World } from "./connections-world";
import { ACCOUNT_ID, OTHER_ACCOUNT_ID } from "./upstreams";

// A query of D1 that failed for good, in the Worker as it deploys. Drizzle's error for it is
// `Failed query: select … params: …`, with every value the statement was given. A page whose read
// failed showed it and had it in its HTML, Better Auth logged the one for a session read, with the
// session's token among the values, and the one for a refresh token, and a token that could not be
// replaced was logged sealed, beside its last four characters. What Guard asks of the binding
// itself failed in D1's own words, which `/mcp` answered an assistant with. A table that is gone
// makes every query of it fail, as the database being down would.

// Tokens whose last four characters (the hint a page shows) are easy to look for.
const CF_TOKEN = "cf-token-77-abcdefghijklmnopqrQ7Zk";
const NEW_TOKEN = "cf-token-78-abcdefghijklmnopqrW9Xy";
const OTHER_TOKEN = "cf-token-79-abcdefghijklmnopqrJ4Hn";
// How long a connection waits for its next scan: a day, and an hour after a failure that passes.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// What a scan takes from the account, which is the workspace's own business.
const SUBJECT = "zone-nobody-should-log.example";
// Never called: the test reads the code from where consent sends the browser.
const redirectUrl = "http://127.0.0.1:47199/callback";

/** A sealed value, as `secrets.ts` writes one. */
const SEALED = /v2\.[\w-]+\.[\w-]+\.[\w-]+/;

let world: World;
let connectionId: string;
/** A second account's connection, made by the test that connects it. */
let otherConnectionId: string;
/** The stand-in Cloudflare account, whose token a test changes as its owner would. */
let account: { token: string };

beforeAll(async () => {
	world = await startWorld();
	account = world.upstream.addAccount(ACCOUNT_ID, CF_TOKEN, [
		{ id: "i1", issue_class: "dmarc", subject: SUBJECT, severity: "Critical" },
	]);
	connectionId = (await world.connectCloudflare(ACCOUNT_ID, CF_TOKEN, "Main")).connection.id;
});

afterAll(async () => {
	await world?.dispose();
});

/** Runs `work` with a table out of reach, and puts it back. */
async function without<Result>(table: string, work: () => Promise<Result>): Promise<Result> {
	await world.guard.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_gone`);
	try {
		return await work();
	} finally {
		await world.guard.db.exec(`ALTER TABLE ${table}_gone RENAME TO ${table}`);
	}
}

/** Runs `work` with every such write refused, as a database that cannot be written to would. */
async function refusing<Result>(write: string, work: () => Promise<Result>): Promise<Result> {
	await world.guard.db.exec(
		`CREATE TRIGGER made_to_fail BEFORE ${write} BEGIN SELECT RAISE(ABORT, 'made to fail'); END`,
	);
	try {
		return await work();
	} finally {
		await world.guard.db.exec("DROP TRIGGER made_to_fail");
	}
}

/** What the Worker logged since `from`, as one text. */
const loggedSince = (from: number) =>
	world.guard.logs
		.slice(from)
		.map((log) => log.message)
		.join("\n");

/** What the Worker logged about failed queries since `from`. */
function failuresSince(from: number) {
	return world.guard.logs.slice(from).flatMap((log) => {
		const found = /d1: a query failed \((.+?)\), reference ([0-9a-f]{8})(?:: (.+))?/.exec(
			log.message,
		);
		return found ? [{ kind: found[1], reference: found[2], statement: found[3] }] : [];
	});
}

const kindsSince = (from: number) => failuresSince(from).map(({ kind }) => kind);

/** The reference the error notice shows. */
const shownIn = (html: string) => /<code>([0-9a-f]{8})<\/code>/.exec(html)?.[1];

async function get(path: string, cookie: string) {
	const response = await world.guard.fetch(`${origin}${path}`, { headers: { cookie } });
	return { status: response.status, text: await response.text() };
}

/** A change to the workspace's connections, as its page asks for one, whatever the answer. */
async function change(action: object) {
	const response = await world.guard.fetch(`${origin}/api/connections/${world.slug}`, {
		method: "POST",
		headers: world.owner.headers,
		body: JSON.stringify(action),
	});
	return { status: response.status, text: await response.text() };
}

async function count(table: string, where = "1 = 1") {
	const row = await world.guard.db
		.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

// Server functions, called as the browser does: the workspace's pages are not rendered on the
// server, so their reads fail in the answer to one of these.
const assets = join(resolve(import.meta.dirname, ".."), "dist/server/assets");
function serverFnUrl(name: string) {
	for (const file of readdirSync(assets).filter((each) => each.endsWith(".js"))) {
		const id = new RegExp(
			`"([0-9a-f]{64})": \\{\\s*functionName: "${name}_createServerFn_handler"`,
		).exec(readFileSync(join(assets, file), "utf8"))?.[1];
		if (id) return `${origin}/_serverFn/${id}`;
	}
	throw new Error(`No server function ${name} in the build`);
}

/** Calls a GET server function with one string, or with nothing, and answers what came back. */
async function serverFn(name: string, cookie: string, data?: string) {
	// Seroval's JSON for `{ data }`.
	const value = data === undefined ? { t: 2, s: 1 } : { t: 1, s: data };
	const payload = JSON.stringify({
		t: { t: 10, i: 0, p: { k: ["data"], v: [value] }, o: 0 },
		f: 0,
		m: [],
	});
	const response = await world.guard.fetch(
		`${serverFnUrl(name)}?payload=${encodeURIComponent(payload)}`,
		{ headers: { "x-tsr-serverFn": "true", accept: "application/json", origin, cookie } },
	);
	return { text: await response.text() };
}

describe("a page whose read of the database failed", () => {
	it("shows no statement and no values, and a reference that is in the log", async () => {
		const { cookie } = world.owner.headers;
		const page = "/settings/account";
		expect((await get(page, cookie)).status).toBe(200);

		const from = world.guard.logs.length;
		// The page asks which sign-ins the account has, by the person's id.
		const answer = await without("account", () => get(page, cookie));

		expect(answer.status).toBe(500);
		const html = answer.text;
		expect(html).not.toContain("Failed query");
		expect(html).not.toContain("params");
		expect(html).not.toMatch(/select\b[^<]*\bfrom\b/i);
		expect(html).not.toContain("provider_id");
		expect(html).not.toContain(world.owner.userId);

		expect(html).toContain("This page could not be loaded.");
		const failures = failuresSince(from);
		expect(failures.length).toBeGreaterThan(0);
		for (const { kind } of failures) {
			expect(kind).toBe("D1_ERROR, SQLITE_ERROR, no such table: account");
		}
		expect(shownIn(html)).toBeDefined();
		expect(failures.map(({ reference }) => reference)).toContain(shownIn(html));
		expect(loggedSince(from)).not.toContain("Failed query");
		expect(loggedSince(from)).not.toContain(world.owner.userId);
	});
});

describe("a session read that failed", () => {
	it("puts no token in the log or the page", async () => {
		const { cookie } = world.owner.headers;
		const signed = /session_token=([^;]+)/.exec(cookie)?.[1] ?? "";
		const token = decodeURIComponent(signed).split(".")[0] ?? "";
		expect(token.length).toBeGreaterThan(16);

		const from = world.guard.logs.length;
		const answer = await without("session", () => get("/", cookie));

		expect(answer.status).toBe(500);
		const html = answer.text;
		const logged = loggedSince(from);
		// Better Auth logs the failure it caught.
		expect(logged).toContain("[Better Auth]");
		expect(logged).not.toContain(token);
		expect(logged).not.toContain("Failed query");
		expect(logged).not.toContain("params");
		expect(html).not.toContain(token);
		expect(html).not.toContain("Failed query");
		expect(html).toContain("This page could not be loaded.");
		expect(kindsSince(from)).toContain("D1_ERROR, SQLITE_ERROR, no such table: session");
		// The log has the statement that failed, with a `?` where the token was.
		expect(logged).toMatch(/where "session"\."token" = \?/);

		// Better Auth throws its own error for this, with the database's as the cause. The page
		// shows that one's reference.
		const references = failuresSince(from).map(({ reference }) => reference);
		expect(shownIn(html)).toBeDefined();
		expect(references).toContain(shownIn(html));
	});
});

// `/$workspace` and everything under it asks server functions for what it shows. So the failure
// reaches the page as a server function's error, of which only the message crosses.
describe("a server function whose read failed", () => {
	it("answers the workspace's page with the reference and nothing of the statement", async () => {
		const { cookie } = world.owner.headers;
		const found = await serverFn("getWorkspace", cookie, world.slug);
		expect(found.text).toContain(world.owner.userId);

		const from = world.guard.logs.length;
		const answer = await without("member", () => serverFn("getWorkspace", cookie, world.slug));

		// An error, which crosses as its message alone.
		expect(answer.text).toContain("$TSR/Error");
		expect(answer.text).not.toContain("Failed query");
		expect(answer.text).not.toContain("params");
		expect(answer.text).not.toContain("organization_id");
		// The membership is looked up by who is asking, so their id was among the values.
		expect(answer.text).not.toContain(world.owner.userId);
		expect(answer.text).not.toContain(world.slug);
		const failures = failuresSince(from);
		expect(failures.map(({ kind }) => kind)).toEqual([
			"D1_ERROR, SQLITE_ERROR, no such table: member",
		]);
		expect(answer.text).toContain(`A database query failed (reference ${failures[0]?.reference})`);
		expect(loggedSince(from)).not.toContain("Failed query");
		expect(loggedSince(from)).not.toContain(world.owner.userId);
	});

	it("keeps the reference of a failed session read, which is in the error's cause", async () => {
		const from = world.guard.logs.length;
		const answer = await without("session", () =>
			serverFn("getSession", world.owner.headers.cookie),
		);

		expect(answer.text).toContain("$TSR/Error");
		expect(answer.text).not.toContain("Failed query");
		const references = failuresSince(from).map(({ reference }) => reference);
		expect(references).toHaveLength(1);
		expect(answer.text).toContain(`Failed to get session (reference ${references[0]})`);
	});
});

// The workspace's endpoints catch no failed query, so what it says is what the runtime logs for
// the request. They answer 500 in words that were never the error's.
describe("a workspace's endpoints", () => {
	it("log no statement's values when findings cannot be read", async () => {
		const { cookie } = world.owner.headers;
		const path = `/api/findings/${world.slug}`;
		expect((await get(path, cookie)).text).toContain(SUBJECT);

		const from = world.guard.logs.length;
		const answer = await without("finding", () => get(path, cookie));

		expect(answer.status).toBe(500);
		expect(answer.text).not.toContain("Failed query");
		expect(answer.text).not.toContain(world.workspaceId);
		expect(loggedSince(from)).not.toContain("Failed query");
		expect(loggedSince(from)).not.toContain("params:");
		// The findings are read by the workspace's id, which was the statement's value.
		expect(loggedSince(from)).not.toContain(world.workspaceId);
		// The page of findings and their count are asked for together, and both failed.
		expect(new Set(kindsSince(from))).toEqual(
			new Set(["D1_ERROR, SQLITE_ERROR, no such table: finding"]),
		);
	});

	it("log the kind of failure, and not D1's words, for what is asked of the binding itself", async () => {
		const { cookie } = world.owner.headers;
		const path = `/api/traffic/${world.slug}`;
		expect((await get(path, cookie)).status).toBe(200);

		const from = world.guard.logs.length;
		const answer = await without("traffic_count", () => get(path, cookie));

		expect(answer.status).toBe(500);
		expect(answer.text).not.toContain("traffic_count");
		// D1's own error, as it came.
		expect(loggedSince(from)).not.toContain("no such table: traffic_count: SQLITE_ERROR");
		expect(loggedSince(from)).not.toContain(world.workspaceId);
		// The page's reads are asked for together, and each one of that table failed.
		const failures = failuresSince(from);
		expect(new Set(failures.map(({ kind }) => kind))).toEqual(
			new Set(["D1_ERROR, SQLITE_ERROR, no such table: traffic_count"]),
		);
		// The statements as the code wrote them, with their `?1`.
		for (const { statement } of failures) {
			expect(statement).toContain("FROM traffic_count WHERE organization_id = ?1");
		}
		// What the runtime logs for the request is the error, under one of those references.
		const thrown = /A database query failed \(reference ([0-9a-f]{8})\)/.exec(loggedSince(from));
		expect(failures.map(({ reference }) => reference)).toContain(thrown?.[1]);
	});

	it("Better Auth's endpoint answers 500, and logs nothing of what it was asked to store", async () => {
		const slug = "a-slug-nobody-should-log";

		const from = world.guard.logs.length;
		const answer = await without("organization", async () => {
			const response = await world.guard.fetch(`${origin}/api/auth/organization/create`, {
				method: "POST",
				headers: world.owner.headers,
				body: JSON.stringify({ name: "Quiet", slug }),
			});
			return { status: response.status, text: await response.text() };
		});

		expect(answer.status).toBe(500);
		expect(answer.text).not.toContain(slug);
		expect(answer.text).not.toContain("Failed query");
		expect(loggedSince(from)).not.toContain(slug);
		expect(loggedSince(from)).not.toContain("Failed query");
		expect(kindsSince(from)).toContain("D1_ERROR, SQLITE_ERROR, no such table: organization");
	});
});

// A token is sealed before it is written, and pages see its last four characters. Both were the
// values of the statement that writes them.
describe("a connection's token", () => {
	it("is not logged, sealed or by its last four, when a new one cannot be written", async () => {
		const before = await world.connectionRow(connectionId);

		const from = world.guard.logs.length;
		const answer = await refusing("UPDATE OF token_sealed ON connection", async () => {
			account.token = NEW_TOKEN;
			return change({ action: "replace-token", id: connectionId, token: NEW_TOKEN });
		});
		account.token = CF_TOKEN;

		expect(answer.status).toBe(500);
		const logged = loggedSince(from);
		for (const said of [answer.text, logged]) {
			expect(said).not.toMatch(SEALED);
			expect(said).not.toContain(NEW_TOKEN);
			expect(said).not.toContain("W9Xy");
			expect(said).not.toContain("Failed query");
			expect(said).not.toContain("params:");
		}
		expect(logged).not.toContain(connectionId);
		// The trigger's words are this test's, and no migration's, so they are not repeated.
		expect(logged).not.toContain("made to fail");
		expect(failuresSince(from)).toEqual([
			{
				kind: "D1_ERROR, SQLITE_CONSTRAINT",
				reference: expect.stringMatching(/^[0-9a-f]{8}$/),
				statement:
					'update "connection" set "token_sealed" = ?, "token_hint" = ? where "connection"."id" = ?',
			},
		]);

		// The token it had is the one it has. The scans below still open it.
		const after = await world.connectionRow(connectionId);
		expect(after?.token_sealed).toBe(before?.token_sealed);
		expect(after?.token_hint).toBe("Q7Zk");
	});

	// The one place that catches a failed write to tell a person something. It asks the failure's
	// kind whether the unique index refused, and says so only then.
	it("still says the account is connected already, and logs the constraint without the token", async () => {
		const from = world.guard.logs.length;
		const answer = await change({
			action: "connect-cloudflare",
			accountId: ACCOUNT_ID,
			token: CF_TOKEN,
		});

		expect(answer.status).toBe(409);
		expect(JSON.parse(answer.text)).toEqual({
			ok: false,
			error: "That account is already connected.",
		});
		const logged = loggedSince(from);
		expect(logged).not.toMatch(SEALED);
		expect(logged).not.toContain(CF_TOKEN);
		expect(logged).not.toContain("Q7Zk");
		expect(logged).not.toContain(ACCOUNT_ID);
		expect(kindsSince(from)).toEqual([
			"D1_ERROR, SQLITE_CONSTRAINT, UNIQUE constraint failed: connection.organization_id, connection.kind, connection.target",
		]);
		expect(await count("connection")).toBe(1);
	});

	// It said "already connected, or this workspace is full" for whatever the insert threw, so a
	// database that could not be written to told a person their account was connected.
	it("is not called connected already when the insert fails for another reason, and connects when asked again", async () => {
		world.upstream.addAccount(OTHER_ACCOUNT_ID, OTHER_TOKEN, []);
		const connect = {
			action: "connect-cloudflare",
			accountId: OTHER_ACCOUNT_ID,
			token: OTHER_TOKEN,
		};

		const from = world.guard.logs.length;
		const answer = await refusing("INSERT ON connection", () => change(connect));

		expect(answer.status).toBe(500);
		expect(answer.text).not.toContain("already connected");
		expect(answer.text).not.toContain("up to 50");
		const logged = loggedSince(from);
		for (const said of [answer.text, logged]) {
			expect(said).not.toMatch(SEALED);
			expect(said).not.toContain(OTHER_TOKEN);
			expect(said).not.toContain("J4Hn");
		}
		expect(logged).not.toContain(OTHER_ACCOUNT_ID);
		expect(kindsSince(from)).toEqual(["D1_ERROR, SQLITE_CONSTRAINT"]);
		expect(await count("connection")).toBe(1);

		const again = await change(connect);
		expect(again.status).toBe(200);
		otherConnectionId = (JSON.parse(again.text) as { connection: { id: string } }).connection.id;
		expect(JSON.parse(again.text)).toMatchObject({
			scan: { outcome: "ok" },
			scanState: "recorded",
		});
		expect(await count("connection")).toBe(2);
	});
});

/** What a member sees of a connection on the Connections page. */
async function shown(id: string) {
	return (await world.connections()).body.connections.find((one) => one.id === id);
}

// A scan takes the connection, reads the account, and writes what it found in one batch. What it
// found is the workspace's own business, and is the batch's values.
describe("a scan whose queries fail", () => {
	it("writes nothing, logs nothing it found, says the scan could not be saved, and scans once when asked again", async () => {
		const findings = await count("finding");
		const scans = await count("scan");
		expect(findings).toBe(1);

		const from = world.guard.logs.length;
		const before = Date.now();
		const answer = await without("finding", () => change({ action: "scan", id: connectionId }));

		// Not what a connection someone else is scanning gets, a 409 and "already running": this
		// scan ran, and that is what the person is told.
		expect(answer.status).toBe(500);
		expect(JSON.parse(answer.text)).toEqual({
			ok: false,
			error: "The scan ran, but what it found could not be saved. Try again in a few minutes.",
		});
		const logged = loggedSince(from);
		expect(logged).toContain("scan: could not record DatabaseError");
		expect(logged).not.toContain(SUBJECT);
		expect(logged).not.toContain(connectionId);
		expect(logged).not.toMatch(SEALED);
		expect(kindsSince(from)).toEqual(["D1_ERROR, SQLITE_ERROR, no such table: finding"]);
		// The update that took the connection was sent once, and the scan let it go.
		expect(logged).not.toContain("is sent again");
		const row = await world.connectionRow(connectionId);
		expect(row?.scan_started_at).toBeNull();
		expect(await count("scan")).toBe(scans);
		// The connection says so, where a member sees it, and waits an hour.
		expect(row?.last_scan_outcome).toBe("unrecorded");
		expect(row?.last_scan_at).toBeGreaterThanOrEqual(before);
		expect((row?.next_scan_at ?? 0) - (row?.last_scan_at ?? 0)).toBe(HOUR);
		expect(await shown(connectionId)).toMatchObject({ lastScanOutcome: "unrecorded" });

		// The scan read the account, so the allowance of "Scan now" is spent, and it says to wait
		// rather than that a scan is running. The next scan is the hour's.
		expect((await change({ action: "scan", id: connectionId })).status).toBe(429);
		await world.scanDue([connectionId]);
		expect(await count("finding")).toBe(findings);
		expect(await count("scan")).toBe(scans + 1);
		expect((await world.connectionRow(connectionId))?.last_scan_outcome).toBe("ok");
	});

	// Left due, it was read every hour for nothing, 24 times a day instead of once, and came first
	// in every hourly run: ten of them took all ten places of a run from the rest.
	it("the hourly run records no scan it could not write, backs the connection off, and records one when it is due again", async () => {
		const scans = await count("scan");
		const read = () =>
			world.upstream.seen.filter((request) => request.path.endsWith("/security-center/insights"))
				.length;

		const from = world.guard.logs.length;
		const before = Date.now();
		await refusing("INSERT ON scan", () => world.scanDue([connectionId]));

		const logged = loggedSince(from);
		expect(logged).toContain("scan: could not record DatabaseError");
		expect(logged).not.toContain(SUBJECT);
		// The batch failed whole: a batch names no statement, and this trigger's words are not a
		// migration's.
		expect(failuresSince(from)).toEqual([
			{
				kind: "D1_ERROR, SQLITE_CONSTRAINT",
				reference: expect.stringMatching(/^[0-9a-f]{8}$/),
				statement: undefined,
			},
		]);
		expect(await count("scan")).toBe(scans);
		const row = await world.connectionRow(connectionId);
		expect(row?.scan_started_at).toBeNull();
		// Not due any more: the first time, the next try is an hour away.
		expect(row?.last_scan_outcome).toBe("unrecorded");
		expect(row?.last_scan_at).toBeGreaterThanOrEqual(before);
		expect((row?.next_scan_at ?? 0) - (row?.last_scan_at ?? 0)).toBe(HOUR);

		// So an hourly run that comes before then leaves it alone, and asks Cloudflare nothing.
		const reads = read();
		await refusing("INSERT ON scan", () => world.guard.runScheduled(0, HOURLY));
		expect(read()).toBe(reads);
		expect((await world.connectionRow(connectionId))?.next_scan_at).toBe(row?.next_scan_at);

		// Its next scan cannot be written either, so the one after that is a day away.
		await refusing("INSERT ON scan", () => world.scanDue([connectionId]));
		expect(read()).toBe(reads + 1);
		const again = await world.connectionRow(connectionId);
		expect(again?.last_scan_outcome).toBe("unrecorded");
		expect((again?.next_scan_at ?? 0) - (again?.last_scan_at ?? 0)).toBe(DAY);
		expect(await count("scan")).toBe(scans);

		// Once it can be written, it is, and the connection is as any other.
		await world.scanDue([connectionId]);
		expect(await count("scan")).toBe(scans + 1);
		expect(await count("finding", `connection_id = '${connectionId}'`)).toBe(1);
		const after = await world.connectionRow(connectionId);
		expect(after?.last_scan_outcome).toBe("ok");
		expect((after?.next_scan_at ?? 0) - (after?.last_scan_at ?? 0)).toBe(DAY);
	});

	// The token is saved either way, so this is no refusal. Its `scan: null` once meant both
	// "another scan has it" and "it ran and could not be saved".
	it("a new token's scan that cannot be written is told apart from one that did not run", async () => {
		const answer = await refusing("INSERT ON scan", () =>
			change({ action: "replace-token", id: connectionId, token: CF_TOKEN }),
		);

		expect(answer.status).toBe(200);
		expect(JSON.parse(answer.text)).toEqual({ ok: true, scan: null, scanState: "unrecorded" });
		expect(await shown(connectionId)).toMatchObject({ lastScanOutcome: "unrecorded" });

		await world.scanDue([connectionId]);
		expect(await shown(connectionId)).toMatchObject({ lastScanOutcome: "ok" });
	});

	it("the daily run's failure is logged by its kind, without the time it cleared by", async () => {
		const from = world.guard.logs.length;
		await without("verification", () => world.guard.runScheduled(0).catch(() => undefined));

		const logged = loggedSince(from);
		expect(logged).not.toContain("Failed query");
		expect(logged).not.toContain("params:");
		const [failure, ...others] = failuresSince(from);
		expect(others).toEqual([]);
		expect(failure?.kind).toBe("D1_ERROR, SQLITE_ERROR, no such table: verification");
		expect(failure?.statement).toBe(
			'delete from "verification" where "verification"."id" in (select "id" from "verification" where "verification"."expires_at" < ? limit ?)',
		);
	});
});

/** An MCP client's OAuth state, kept in memory. */
class MemoryProvider implements OAuthClientProvider {
	client: OAuthClientInformationMixed | undefined;
	savedTokens: OAuthTokens | undefined;
	verifier = "";
	authorizationUrl: URL | undefined;

	get redirectUrl() {
		return redirectUrl;
	}
	get clientMetadata() {
		return {
			client_name: "Query failure test",
			redirect_uris: [redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}
	clientInformation() {
		return this.client;
	}
	saveClientInformation(client: OAuthClientInformationMixed) {
		this.client = client;
	}
	tokens() {
		return this.savedTokens;
	}
	saveTokens(tokens: OAuthTokens) {
		this.savedTokens = tokens;
	}
	saveCodeVerifier(verifier: string) {
		this.verifier = verifier;
	}
	codeVerifier() {
		return this.verifier;
	}
	redirectToAuthorization(url: URL) {
		this.authorizationUrl = url;
	}
}

// An assistant acts as the person who allowed it. `/mcp` asks D1 on every call whether they still
// do, and each tool asks what the pages ask.
describe("an assistant", () => {
	let client: Client;
	let provider: MemoryProvider;
	const send: typeof world.guard.fetch = (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set("cf-connecting-ip", "198.51.100.77");
		return world.guard.fetch(input, { ...init, headers });
	};

	/** What a tool call came to, a result or a failure, as text to look through. */
	const called = (name: string, args: Record<string, unknown> = {}) =>
		client.callTool({ name, arguments: args }).then(
			(result) => JSON.stringify(result),
			(error: unknown) => `thrown: ${String(error)}`,
		);

	/** Asks for new tokens with the refresh token, as the assistant would when its token ran out. */
	async function refresh(refreshToken: string) {
		const response = await send(`${origin}/api/auth/oauth2/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: provider.client?.client_id ?? "",
				resource: `${origin}/mcp`,
			}).toString(),
		});
		return { status: response.status, text: await response.text() };
	}

	async function takeBack() {
		const response = await world.guard.fetch(`${origin}/api/assistants`, {
			method: "POST",
			headers: world.owner.headers,
			body: JSON.stringify({ clientId: provider.client?.client_id }),
		});
		return { status: response.status, text: await response.text() };
	}

	// Connects as Claude Code would: discovery, registering itself, sign-in, consent and the code.
	beforeAll(async () => {
		provider = new MemoryProvider();
		const transport = () =>
			new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
				authProvider: provider,
				fetch: send,
			});
		client = new Client({ name: "query-failure-test", version: "1.0.0" });
		await client.connect(transport()).catch(() => undefined);
		const authorize = provider.authorizationUrl;
		if (!authorize) throw new Error("The assistant was never sent to authorize");
		const { cookie } = world.owner.headers;
		const toConsent = await send(authorize, { headers: { cookie } });
		const consent = new URL(((await toConsent.json()) as { url: string }).url, origin);
		const decision = await world.guard.fetch(`${origin}/api/auth/oauth2/consent`, {
			method: "POST",
			headers: { "content-type": "application/json", origin, cookie },
			body: JSON.stringify({ accept: true, oauth_query: consent.search.slice(1) }),
		});
		expect(decision.status).toBe(200);
		const callback = new URL(((await decision.json()) as { url: string }).url);
		await transport().finishAuth(callback.searchParams);
		await client.connect(transport());
	});

	afterAll(async () => {
		await client?.close();
	});

	it("is told that a tool failed, in words that were never the database's", async () => {
		expect(await called("list_workspaces")).toContain(world.slug);

		const from = world.guard.logs.length;
		const told = await without("member", () => called("list_workspaces"));

		expect(JSON.parse(told)).toMatchObject({
			isError: true,
			structuredContent: {
				error: {
					code: "upstream",
					message: "Guard could not do that just now. Try again in a moment.",
				},
			},
		});
		expect(told).not.toContain("reference");
		expect(told).not.toContain("member");
		expect(loggedSince(from)).toContain("mcp: tool failed (DatabaseError)");
		expect(loggedSince(from)).not.toContain(world.owner.userId);
		expect(kindsSince(from)).toEqual(["D1_ERROR, SQLITE_ERROR, no such table: member"]);
	});

	it("is told nothing of what a workspace's findings hold when they cannot be read", async () => {
		expect(await called("list_findings", { workspace: world.slug })).toContain(SUBJECT);

		const from = world.guard.logs.length;
		const told = await without("finding", () => called("list_findings", { workspace: world.slug }));

		expect(JSON.parse(told)).toMatchObject({ isError: true });
		expect(told).not.toMatch(/select\b.*\bfrom\b/i);
		expect(told).not.toContain(SUBJECT);
		expect(told).not.toContain(world.workspaceId);
		expect(loggedSince(from)).not.toContain(world.workspaceId);
		expect(loggedSince(from)).not.toContain("Failed query");
		expect(new Set(kindsSince(from))).toEqual(
			new Set(["D1_ERROR, SQLITE_ERROR, no such table: finding"]),
		);
	});

	// Asked of the binding itself, before any tool runs, and caught by nothing: the local runtime
	// answers a request with what was thrown, which was D1's own words.
	it("is answered without D1's words when what the person allowed cannot be read", async () => {
		const from = world.guard.logs.length;
		const told = await without("oauth_consent", () => called("list_workspaces"));

		expect(told).not.toContain(world.slug);
		expect(told).not.toContain("D1_ERROR");
		expect(told).not.toContain("no such table");
		expect(told).not.toContain("oauth_consent");
		expect(told).not.toMatch(/select\b.*\bfrom\b/i);
		expect(failuresSince(from)).toEqual([
			{
				kind: "D1_ERROR, SQLITE_ERROR, no such table: oauth_consent",
				reference: expect.stringMatching(/^[0-9a-f]{8}$/),
				statement: "SELECT scopes FROM oauth_consent WHERE user_id = ?1 AND client_id = ?2",
			},
		]);
		expect(loggedSince(from)).not.toContain(world.owner.userId);
		expect(loggedSince(from)).not.toContain(provider.client?.client_id);

		// With the table back, it is allowed as it was.
		expect(await called("list_workspaces")).toContain(world.slug);
	});

	it("keeps its refresh token out of the log when it cannot be looked up, and can still use it", async () => {
		const refreshToken = provider.savedTokens?.refresh_token ?? "";
		expect(refreshToken.length).toBeGreaterThan(16);
		const stored = await world.guard.db
			.prepare("SELECT token FROM oauth_refresh_token")
			.all<{ token: string }>();
		expect(stored.results).toHaveLength(1);

		const from = world.guard.logs.length;
		const answer = await without("oauth_refresh_token", () => refresh(refreshToken));

		expect(answer.status).toBe(500);
		expect(answer.text).not.toContain("Failed query");
		const logged = loggedSince(from);
		expect(logged).not.toContain("Failed query");
		expect(logged).not.toContain("params:");
		expect(logged).not.toContain(refreshToken);
		// The token is kept as a hash, which was the value the statement looked for.
		expect(logged).not.toContain(stored.results[0]?.token);
		expect(kindsSince(from)).toContain(
			"D1_ERROR, SQLITE_ERROR, no such table: oauth_refresh_token",
		);

		// The failed exchange spent nothing: the same token is good for one, as before.
		const again = await refresh(refreshToken);
		expect(again.status).toBe(200);
		expect(JSON.parse(again.text)).toMatchObject({ token_type: "Bearer" });
	});

	// `start_scan` goes where the page's button goes. It was told `rate_limited` and "A scan of this
	// connection is already running", for a scan that had run and was running no more.
	it("is told that a scan ran and could not be saved, not that one is running", async () => {
		const told = await without("finding", () =>
			called("start_scan", { workspace: world.slug, connection: otherConnectionId }),
		);

		expect(JSON.parse(told)).toMatchObject({
			isError: true,
			structuredContent: {
				error: {
					code: "upstream",
					message:
						"The scan ran, but what it found could not be saved. Try again in a few minutes.",
				},
			},
		});
		expect((await world.connectionRow(otherConnectionId))?.last_scan_outcome).toBe("unrecorded");
	});

	it("is not half taken back when that fails, and is taken back when asked again", async () => {
		const clientId = provider.client?.client_id ?? "";
		const granted = () => count("oauth_consent", `client_id = '${clientId.replaceAll("'", "''")}'`);
		expect(await granted()).toBe(1);

		const from = world.guard.logs.length;
		// The third of the batch's three deletes cannot be done, so none is.
		const answer = await refusing("DELETE ON oauth_consent", takeBack);

		expect(answer.status).toBe(500);
		expect(answer.text).not.toContain("oauth_consent");
		expect(answer.text).not.toContain("D1_ERROR");
		expect(loggedSince(from)).not.toContain(world.owner.userId);
		expect(loggedSince(from)).not.toContain(clientId);
		expect(kindsSince(from)).toEqual(["D1_ERROR, SQLITE_CONSTRAINT"]);
		expect(await granted()).toBe(1);
		expect(await count("oauth_refresh_token")).toBeGreaterThan(0);
		expect(await called("list_workspaces")).toContain(world.slug);

		expect((await takeBack()).status).toBe(200);
		expect(await granted()).toBe(0);
		expect(await count("oauth_refresh_token")).toBe(0);
		expect(await called("list_workspaces")).not.toContain(world.slug);
	});
});
