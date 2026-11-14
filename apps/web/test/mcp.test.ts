import { createHash, randomBytes } from "node:crypto";
import { utcDay } from "@gateweave/guard-scan";
import {
	Client,
	type OAuthClientInformationMixed,
	type OAuthClientProvider,
	type OAuthTokens,
	StreamableHTTPClientTransport,
	UnauthorizedError,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { origin, startWorld, type World } from "./connections-world";
import { ACCOUNT_ID, npmLock } from "./upstreams";

// An AI assistant connecting to Guard from scratch, against the built Worker in workerd: discovery,
// dynamic client registration, sign-in, consent, the PKCE code exchange and tool calls, as someone
// whose role the pages already decide things by.

// Never called: the test reads the code from where consent sends the browser.
const redirectUrl = "http://127.0.0.1:47199/callback";

// Tokens whose last four characters (the hint a page shows) are easy to look for in an answer.
const CF_TOKEN = "cf-token-77-abcdefghijklmnopqrQ7Zk";
const GH_TOKEN = "github_pat_77_abcdefghijklmnopqrstuvwR8Xm";
const HINTS = ["Q7Zk", "R8Xm"];

type Person = Awaited<ReturnType<World["stranger"]>>;
type Call = Awaited<ReturnType<Client["callTool"]>>;

let world: World;
let admin: Person;
let member: Person;
let stranger: Person;
let clients = 0;

/** A fetch from an address of its own, as each person's assistant has: registering a client is limited per address. */
function fromAnAddress(): typeof world.guard.fetch {
	const address = `198.51.100.${++clients}`;
	return (input, init) => {
		const headers = new Headers(init?.headers);
		headers.set("cf-connecting-ip", address);
		return world.guard.fetch(input, { ...init, headers });
	};
}
let cloudflareConnection: string;
let repositoryConnection: string;

const DAY_MS = 86_400_000;
const day = (back: number) => utcDay(Date.now() - back * DAY_MS);

beforeAll(async () => {
	world = await startWorld();
	admin = await world.addMember("ada", "admin");
	member = await world.addMember("mia");
	stranger = await world.stranger("sam");

	const insights = [
		{ id: "i1", issue_class: "dmarc", subject: "example.com", severity: "Critical" },
		{ id: "i2", issue_class: "hsts_not_enabled", subject: "example.com", severity: "Moderate" },
		{ id: "i3", issue_class: "tls_version_old", subject: "example.org", severity: "Moderate" },
		{ id: "i4", issue_class: "spf", subject: "example.org", severity: "Moderate" },
		{ id: "i5", issue_class: "mfa_not_enabled", subject: "dev@example.com", severity: "Low" },
	];
	world.upstream.addAccount(ACCOUNT_ID, CF_TOKEN, insights);
	const zone = world.upstream.addZone(ACCOUNT_ID, "example.com");
	zone.days[day(1)] = {
		actions: [{ action: "block", source: "firewallCustom", count: 12 }],
		countries: [{ name: "US", action: "block", count: 12 }],
		hosts: [{ name: "example.com", action: "block", count: 12 }],
	};
	world.upstream.addRepository("acme/shop", GH_TOKEN, 42, {
		"package-lock.json": npmLock({ lodash: "4.17.20" }),
	});
	world.upstream.addAdvisory({
		id: "GHSA-lodash",
		packageName: "lodash",
		severity: "CRITICAL",
		summary: "Prototype pollution in lodash",
		fixed: "4.17.21",
	});
	cloudflareConnection = (await world.connectCloudflare(ACCOUNT_ID, CF_TOKEN, "Main account"))
		.connection.id;
	repositoryConnection = (await world.connectGithub("acme/shop", GH_TOKEN)).connection.id;
});

afterAll(async () => {
	await world?.dispose();
});

/** Calls Better Auth as a browser on Guard's own pages would. */
async function authApi(path: string, person: Person | null, body: object) {
	const response = await world.guard.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin,
			...(person && { cookie: person.headers.cookie }),
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return response;
}

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
			client_name: "Guard integration test",
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

/** Connects an assistant for this person, the way Claude Code would: discovery to tool calls. */
async function assistantFor(person: Person) {
	const provider = new MemoryProvider();
	const send = fromAnAddress();
	const transport = () =>
		new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
			authProvider: provider,
			fetch: send,
		});
	const client = new Client({ name: "guard-test", version: "1.0.0" });
	// Without a token, the assistant is sent to authorize, after registering itself.
	await expect(client.connect(transport())).rejects.toBeInstanceOf(UnauthorizedError);
	const authorize = provider.authorizationUrl;
	if (!authorize) throw new Error("The assistant was never sent to authorize");
	expect(authorize.searchParams.get("resource")).toBe(`${origin}/mcp`);

	// Signed in, the person lands on the consent page and allows it. Requests from this test arrive
	// as fetches, so Better Auth answers with where to go next instead of redirecting.
	const toConsent = await send(authorize, {
		headers: { cookie: person.headers.cookie },
	});
	const consent = new URL(((await toConsent.json()) as { url: string }).url, origin);
	expect(consent.pathname).toBe("/oauth/consent");
	const decision = await authApi("/oauth2/consent", person, {
		accept: true,
		oauth_query: consent.search.slice(1),
	});
	const callback = new URL(((await decision.json()) as { url: string }).url);
	expect(`${callback.origin}${callback.pathname}`).toBe(redirectUrl);

	await transport().finishAuth(callback.searchParams);
	expect(provider.savedTokens?.scope).toContain("guard");
	await client.connect(transport());
	return {
		client,
		token: provider.savedTokens?.access_token ?? "",
		refreshToken: provider.savedTokens?.refresh_token ?? "",
		clientId: provider.client?.client_id ?? "",
	};
}

/** What a tool answered, as text, to look through. */
const textOf = (call: Call) => JSON.stringify(call);

const callAs = (client: Client, name: string, args: Record<string, unknown> = {}) =>
	client.callTool({ name, arguments: args });

function listed(call: Call) {
	return call.structuredContent as {
		total: number;
		nextCursor: string | null;
		findings: { id: string; title: string; severity: string; kind: string; source: string }[];
	};
}

describe("discovery and refusal", () => {
	it("serves the OAuth documents an assistant starts from", async () => {
		const resource = await world.guard.fetch(`${origin}/.well-known/oauth-protected-resource`);
		expect(resource.status).toBe(200);
		expect(await resource.json()).toMatchObject({
			resource: `${origin}/mcp`,
			authorization_servers: [`${origin}/api/auth`],
			scopes_supported: ["guard"],
		});
		const under = await world.guard.fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
		expect(under.status).toBe(200);
		// The issuer has a path (/api/auth), so its metadata is found as RFC 8414 says: the well-known
		// segment goes between the host and that path.
		for (const path of [
			"/.well-known/oauth-authorization-server/api/auth",
			"/api/auth/.well-known/openid-configuration",
		]) {
			const document = await world.guard.fetch(`${origin}${path}`);
			expect(document.status, path).toBe(200);
			expect(await document.json()).toMatchObject({
				issuer: `${origin}/api/auth`,
				registration_endpoint: expect.stringContaining("/oauth2/register"),
				code_challenge_methods_supported: ["S256"],
			});
		}
	});

	const rpc = (headers: Record<string, string>) =>
		world.guard.fetch(`${origin}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...headers,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});

	it("answers a request without a token with the challenge that starts the flow", async () => {
		const response = await rpc({});
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain(
			`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
		);
	});

	it("answers a bad token the same way", async () => {
		const response = await rpc({ authorization: "Bearer not.a.token" });
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
	});

	it("never takes a session cookie, whoever it belongs to", async () => {
		for (const person of [world.owner, admin, member]) {
			const response = await rpc({ cookie: person.headers.cookie, origin });
			expect(response.status).toBe(401);
			expect(await response.text()).not.toContain("tools");
		}
	});

	it("is off, as a 404, on a server without a pinned address", async () => {
		const unpinned = await startWorld({ settings: { BETTER_AUTH_URL: "" } });
		try {
			const response = await unpinned.guard.fetch(`${origin}/mcp`, { method: "POST", body: "{}" });
			expect(response.status).toBe(404);
			const document = await unpinned.guard.fetch(`${origin}/.well-known/oauth-protected-resource`);
			expect(document.status).toBe(404);
		} finally {
			await unpinned.dispose();
		}
	});
});

describe("a token that is not for this endpoint", () => {
	/** Runs the code flow by hand for a client that asks for these scopes and this audience. */
	async function tokenFor(scope: string, resource: string | null) {
		const send = fromAnAddress();
		const registered = await send(`${origin}/api/auth/oauth2/register`, {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify({
				client_name: "Narrow client",
				redirect_uris: [redirectUrl],
				grant_types: ["authorization_code"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
				scope,
			}),
		});
		const { client_id: clientId } = (await registered.json()) as { client_id: string };
		const verifier = randomBytes(32).toString("base64url");
		const authorize = new URL(`${origin}/api/auth/oauth2/authorize`);
		for (const [key, value] of Object.entries({
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirectUrl,
			scope,
			state: "s",
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			code_challenge_method: "S256",
			...(resource && { resource }),
		})) {
			authorize.searchParams.set(key, value);
		}
		const toConsent = await send(authorize, {
			headers: { cookie: world.owner.headers.cookie },
		});
		const consent = new URL(((await toConsent.json()) as { url: string }).url, origin);
		// An audience the server does not know is turned away before anyone is asked.
		if (consent.pathname !== "/oauth/consent") return { status: 400, body: {} };
		const decision = await authApi("/oauth2/consent", world.owner, {
			accept: true,
			oauth_query: consent.search.slice(1),
		});
		const callback = new URL(((await decision.json()) as { url: string }).url);
		const token = await send(`${origin}/api/auth/oauth2/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", origin },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: callback.searchParams.get("code") ?? "",
				redirect_uri: redirectUrl,
				client_id: clientId,
				code_verifier: verifier,
				...(resource && { resource }),
			}),
		});
		return { status: token.status, body: (await token.json()) as { access_token?: string } };
	}

	const callWith = (accessToken: string) =>
		world.guard.fetch(`${origin}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${accessToken}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});

	it("is refused without the guard scope, however well it is signed", async () => {
		const token = await tokenFor("openid profile email", `${origin}/mcp`);
		expect(token.body.access_token).toBeTruthy();
		const response = await callWith(token.body.access_token ?? "");
		expect([401, 403]).toContain(response.status);
		expect(response.headers.get("www-authenticate")).toContain("insufficient_scope");
	});

	it("is refused when it was made for another audience", async () => {
		const token = await tokenFor("openid guard", "https://elsewhere.test/mcp");
		// The server may refuse to make it at all, or make one that this endpoint then turns away.
		if (token.status === 200 && token.body.access_token) {
			const response = await callWith(token.body.access_token);
			expect(response.status).toBe(401);
		} else {
			expect(token.status).toBeGreaterThanOrEqual(400);
		}
	});

	it("is refused when it names no audience, so it is not a signed token for this endpoint", async () => {
		const token = await tokenFor("openid guard", null);
		if (token.status === 200 && token.body.access_token) {
			expect((await callWith(token.body.access_token)).status).toBe(401);
		}
	});
});

describe("the consent page", () => {
	it("is a page like the others: no framing, a policy with a nonce, and nothing cached", async () => {
		const response = await world.guard.fetch(`${origin}/oauth/consent?client_id=whoever`, {
			headers: { cookie: world.owner.headers.cookie },
		});
		expect(response.status).toBe(200);
		const policy = response.headers.get("content-security-policy") ?? "";
		expect(policy).toContain("frame-ancestors 'none'");
		expect(policy).toMatch(/script-src 'self' 'nonce-/);
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("cache-control")).toContain("no-store");
		// With no authorization in progress, it says so instead of offering a button.
		expect(await response.text()).toContain("no longer valid");
	});
});

describe("an assistant of an owner", () => {
	let owner: { client: Client; token: string };
	beforeAll(async () => {
		owner = await assistantFor(world.owner);
	});
	afterAll(async () => {
		await owner?.client.close();
	});

	it("lists the six tools", async () => {
		const { tools } = await owner.client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"dismiss_finding",
			"get_finding",
			"list_findings",
			"list_workspaces",
			"start_scan",
			"traffic_summary",
		]);
	});

	it("lists the person's workspaces with their role", async () => {
		const result = await callAs(owner.client, "list_workspaces");
		expect(result.structuredContent).toEqual({
			workspaces: [{ slug: world.slug, name: world.slug, role: "owner" }],
		});
		// Someone else's workspaces are not here.
		const other = await assistantFor(stranger);
		try {
			expect((await callAs(other.client, "list_workspaces")).structuredContent).toEqual({
				workspaces: [],
			});
		} finally {
			await other.client.close();
		}
	});

	it("lists findings as the page does, with the page's filters and order", async () => {
		const page = (await world.findings("")).body;
		const all = listed(await callAs(owner.client, "list_findings", { workspace: world.slug }));
		expect(all.total).toBe(page.total);
		expect(all.total).toBe(6);
		expect(all.findings.map((one) => one.id)).toEqual(page.findings.map((one) => one.id));
		expect(all.findings.map((one) => one.severity)).toEqual([
			"critical",
			"critical",
			"moderate",
			"moderate",
			"moderate",
			"low",
		]);
		expect(all.nextCursor).toBeNull();
		expect(all.findings.find((one) => one.kind === "GHSA-lodash")).toMatchObject({
			source: "dependency",
			title: "Prototype pollution in lodash",
			connection: { id: repositoryConnection, name: "acme/shop" },
			url: expect.stringContaining("GHSA-lodash"),
			status: "open",
		});

		const high = listed(
			await callAs(owner.client, "list_findings", { workspace: world.slug, severity: "moderate" }),
		);
		expect(high.findings.map((one) => one.kind).sort()).toEqual([
			"hsts_not_enabled",
			"spf",
			"tls_version_old",
		]);
		const dependencies = listed(
			await callAs(owner.client, "list_findings", { workspace: world.slug, source: "dependency" }),
		);
		expect(dependencies.findings.map((one) => one.kind)).toEqual(["GHSA-lodash"]);
		const kind = listed(
			await callAs(owner.client, "list_findings", { workspace: world.slug, kind: "spf" }),
		);
		expect(kind.findings).toHaveLength(1);
		const byConnection = listed(
			await callAs(owner.client, "list_findings", {
				workspace: world.slug,
				connection: "Main account",
			}),
		);
		expect(byConnection.total).toBe(5);
		const byRepository = listed(
			await callAs(owner.client, "list_findings", {
				workspace: world.slug,
				connection: "acme/shop",
			}),
		);
		expect(byRepository.total).toBe(1);
		const none = listed(
			await callAs(owner.client, "list_findings", { workspace: world.slug, status: "dismissed" }),
		);
		expect(none.total).toBe(0);
	});

	it("pages with a cursor and sends nothing twice", async () => {
		const first = listed(
			await callAs(owner.client, "list_findings", { workspace: world.slug, limit: 4 }),
		);
		expect(first.findings).toHaveLength(4);
		expect(first.nextCursor).toBe("o4");
		const second = listed(
			await callAs(owner.client, "list_findings", {
				workspace: world.slug,
				limit: 4,
				cursor: first.nextCursor ?? "",
			}),
		);
		expect(second.findings).toHaveLength(2);
		expect(second.nextCursor).toBeNull();
		const ids = [...first.findings, ...second.findings].map((one) => one.id);
		expect(new Set(ids).size).toBe(6);
	});

	it("narrows to what is new since the person last opened Findings, as the page's badge counts", async () => {
		const before = listed(
			await callAs(owner.client, "list_findings", { workspace: world.slug, new_only: true }),
		);
		const badge = await world.guard.fetch(`${origin}/api/findings/${world.slug}/new`, {
			headers: world.owner.headers,
		});
		expect(before.total).toBe(((await badge.json()) as { count: number }).count);
	});

	it("gives a dependency finding's package, versions, fix, lockfile and repository", async () => {
		const found = listed(
			await callAs(owner.client, "list_findings", { workspace: world.slug, source: "dependency" }),
		).findings[0];
		const result = await callAs(owner.client, "get_finding", {
			workspace: world.slug,
			id: found?.id,
		});
		expect(result.structuredContent).toMatchObject({
			finding: {
				id: found?.id,
				severity: "critical",
				subject: "lodash@4.17.20 in package-lock.json",
				connection: { name: "acme/shop", kind: "github", target: "acme/shop" },
				dependency: {
					package: "lodash",
					installed: ["4.17.20"],
					fixedVersion: "4.17.21",
					lockfile: "package-lock.json",
					repository: "acme/shop",
					advisories: [{ id: "GHSA-lodash" }],
				},
				track: null,
				dismissal: null,
			},
		});
	});

	it("gives a finding the same answer for a missing id as for another workspace's", async () => {
		const missing = await callAs(owner.client, "get_finding", {
			workspace: world.slug,
			id: "nope",
		});
		expect(missing.structuredContent).toMatchObject({ error: { code: "not_found" } });
		expect(missing.isError).toBe(true);
	});

	it("summarises traffic as the page does, and narrows to a zone", async () => {
		const page = (await world.trafficPage()).body;
		const result = await callAs(owner.client, "traffic_summary", { workspace: world.slug });
		const [zone] = page.connections[0]?.zones ?? [];
		expect(result.structuredContent).toMatchObject({
			yesterday: page.yesterday,
			zones: [
				{
					name: "example.com",
					week: { stoppedOrChallenged: zone?.week.thisSum },
					actions: [{ action: "block", count: 12 }],
					countries: [{ name: "US", count: 12 }],
					hosts: [{ name: "example.com", count: 12 }],
				},
			],
		});
		const one = await callAs(owner.client, "traffic_summary", {
			workspace: world.slug,
			zone: "EXAMPLE.com",
		});
		expect(one.isError).toBeFalsy();
		const missing = await callAs(owner.client, "traffic_summary", {
			workspace: world.slug,
			zone: "nope.example",
		});
		expect(missing.structuredContent).toMatchObject({ error: { code: "not_found" } });
	});

	it("says nothing a token or its hint could be found in, in any answer", async () => {
		const texts: string[] = [];
		const { tools } = await owner.client.listTools();
		texts.push(JSON.stringify(tools));
		texts.push(textOf(await callAs(owner.client, "list_workspaces")));
		const everything = listed(
			await callAs(owner.client, "list_findings", { workspace: world.slug, limit: 200 }),
		);
		texts.push(JSON.stringify(everything));
		for (const found of everything.findings) {
			texts.push(
				textOf(await callAs(owner.client, "get_finding", { workspace: world.slug, id: found.id })),
			);
		}
		texts.push(textOf(await callAs(owner.client, "traffic_summary", { workspace: world.slug })));
		// Errors name connections too.
		texts.push(
			textOf(
				await callAs(owner.client, "start_scan", { workspace: world.slug, connection: "nope" }),
			),
		);

		// The hints are on the pages, so the test would notice if they were looked for in vain.
		const page = JSON.stringify((await world.connections()).body);
		for (const hint of HINTS) expect(page).toContain(hint);
		const sealed = (await world.connectionRow(cloudflareConnection))?.token_sealed ?? "";
		expect(sealed).not.toBe("");
		const dump = texts.join("\n");
		for (const secret of [...HINTS, CF_TOKEN, GH_TOKEN, sealed]) {
			expect(dump, secret).not.toContain(secret);
		}
		// Nor the access token the assistant itself holds.
		expect(dump).not.toContain(owner.token);
	});

	it("scans a connection and returns the outcome, once in a few minutes", async () => {
		const result = await callAs(owner.client, "start_scan", {
			workspace: world.slug,
			connection: "Main account",
		});
		expect(result.structuredContent).toEqual({
			connection: { id: cloudflareConnection, name: "Main account" },
			outcome: "ok",
			found: 5,
			added: 0,
			resolved: 0,
		});
		const again = await callAs(owner.client, "start_scan", {
			workspace: world.slug,
			connection: cloudflareConnection,
		});
		expect(again.isError).toBe(true);
		expect(again.structuredContent).toMatchObject({ error: { code: "rate_limited" } });
		// The page's button says the same.
		const page = await world.act(world.owner, { action: "scan", id: cloudflareConnection });
		expect(page.status).toBe(429);
	});

	it("dismisses a finding with a reason, which the page then shows", async () => {
		const target = listed(
			await callAs(owner.client, "list_findings", { workspace: world.slug, kind: "spf" }),
		).findings[0];
		const bare = await callAs(owner.client, "dismiss_finding", {
			workspace: world.slug,
			id: target?.id,
			reason: " ",
		});
		expect(bare.isError).toBe(true);
		const result = await callAs(owner.client, "dismiss_finding", {
			workspace: world.slug,
			id: target?.id,
			reason: "SPF is set at the registrar",
		});
		expect(result.structuredContent).toEqual({ id: target?.id, status: "dismissed" });

		const page = (await world.findings("status=dismissed")).body;
		expect(page.findings).toMatchObject([
			{ id: target?.id, dismissReason: "SPF is set at the registrar" },
		]);
		const detail = await callAs(owner.client, "get_finding", {
			workspace: world.slug,
			id: target?.id,
		});
		expect(detail.structuredContent).toMatchObject({
			finding: {
				status: "dismissed",
				dismissal: { reason: "SPF is set at the registrar", by: "owner" },
			},
		});
		const open = listed(
			await callAs(owner.client, "list_findings", { workspace: world.slug, severity: "moderate" }),
		);
		expect(open.total).toBe(2);
		// Put back, so the other tests see what they expect.
		await world.changeFinding(world.owner, { action: "undismiss", id: target?.id ?? "" });
	});
});

describe("who may do what, as the pages decide it", () => {
	it("lets a member read, and refuses what the page refuses a member", async () => {
		const assistant = await assistantFor(member);
		try {
			const read = listed(
				await callAs(assistant.client, "list_findings", { workspace: world.slug }),
			);
			expect(read.total).toBeGreaterThan(0);
			expect(
				(await callAs(assistant.client, "traffic_summary", { workspace: world.slug })).isError,
			).toBeFalsy();
			expect((await callAs(assistant.client, "list_workspaces")).structuredContent).toMatchObject({
				workspaces: [{ role: "member" }],
			});

			const target = read.findings[0]?.id ?? "";
			const dismissed = await callAs(assistant.client, "dismiss_finding", {
				workspace: world.slug,
				id: target,
				reason: "I would like to",
			});
			expect(dismissed.structuredContent).toMatchObject({ error: { code: "forbidden" } });
			const scanned = await callAs(assistant.client, "start_scan", {
				workspace: world.slug,
				connection: "acme/shop",
			});
			expect(scanned.structuredContent).toMatchObject({ error: { code: "forbidden" } });

			// The page says no to the same member, and nothing changed.
			const viaPage = await world.changeFinding(member, {
				action: "dismiss",
				id: target,
				reason: "x",
			});
			expect(viaPage.status).toBe(403);
			const scanViaPage = await world.act(member, { action: "scan", id: repositoryConnection });
			expect(scanViaPage.status).toBe(403);
			expect((await world.findings("status=dismissed")).body.total).toBe(0);
		} finally {
			await assistant.client.close();
		}
	});

	it("lets an admin dismiss and scan, as the page does", async () => {
		const assistant = await assistantFor(admin);
		try {
			const target = listed(
				await callAs(assistant.client, "list_findings", {
					workspace: world.slug,
					kind: "tls_version_old",
				}),
			).findings[0];
			const dismissed = await callAs(assistant.client, "dismiss_finding", {
				workspace: world.slug,
				id: target?.id,
				reason: "Needed for an old partner",
			});
			expect(dismissed.isError).toBeFalsy();
			const detail = await callAs(assistant.client, "get_finding", {
				workspace: world.slug,
				id: target?.id,
			});
			expect(detail.structuredContent).toMatchObject({
				finding: { dismissal: { reason: "Needed for an old partner", by: "ada" } },
			});
			const scanned = await callAs(assistant.client, "start_scan", {
				workspace: world.slug,
				connection: "acme/shop",
			});
			expect(scanned.structuredContent).toMatchObject({ outcome: "ok", found: 1 });
			await world.changeFinding(world.owner, { action: "undismiss", id: target?.id ?? "" });
		} finally {
			await assistant.client.close();
		}
	});

	it("answers a stranger about an existing workspace exactly as about a missing one", async () => {
		const assistant = await assistantFor(stranger);
		try {
			const calls: [string, Record<string, unknown>][] = [
				["list_findings", {}],
				["get_finding", { id: "anything" }],
				["dismiss_finding", { id: "anything", reason: "why not" }],
				["start_scan", { connection: "acme/shop" }],
				["traffic_summary", {}],
			];
			for (const [name, args] of calls) {
				const real = await callAs(assistant.client, name, { workspace: world.slug, ...args });
				const missing = await callAs(assistant.client, name, {
					workspace: "no-such-workspace",
					...args,
				});
				expect(real.isError, name).toBe(true);
				expect(real.structuredContent, name).toMatchObject({ error: { code: "not_found" } });
				// Apart from the slug it repeats, the words are the same.
				expect(textOf(real).replaceAll(world.slug, "x")).toBe(
					textOf(missing).replaceAll("no-such-workspace", "x"),
				);
			}
			// Nothing was dismissed or scanned for them.
			expect((await world.findings("status=dismissed")).body.total).toBe(0);
		} finally {
			await assistant.client.close();
		}
	});
});

describe("how often an assistant may call", () => {
	it("is held to a burst a minute, with a Retry-After, and others are not held with it", async () => {
		const noisy = await assistantFor(stranger);
		const calm = await assistantFor(member);
		try {
			const ping = (token: string) =>
				world.guard.fetch(`${origin}/mcp`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
						authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
				});
			const statuses: number[] = [];
			let limited: Response | undefined;
			for (let call = 0; call < 90; call++) {
				const response = await ping(noisy.token);
				statuses.push(response.status);
				if (response.status === 429) {
					limited = response;
					break;
				}
			}
			expect(statuses.at(-1)).toBe(429);
			expect(statuses.length).toBeGreaterThan(30);
			expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0);
			expect((await ping(calm.token)).status).toBe(200);
		} finally {
			await noisy.client.close();
			await calm.client.close();
		}
	});
});

describe("the assistants a person allowed", () => {
	type Listed = {
		clientId: string;
		name: string | null;
		destination: string;
		allowedAt: number;
		lastUsedAt: number | null;
	};

	const listFor = async (person: Person) => {
		const response = await world.guard.fetch(`${origin}/api/assistants`, {
			headers: { cookie: person.headers.cookie },
		});
		expect(response.status).toBe(200);
		const text = await response.text();
		return { grants: (JSON.parse(text) as { grants: Listed[] }).grants, text };
	};

	const takeBack = (person: Person, clientId: string) =>
		world.guard.fetch(`${origin}/api/assistants`, {
			method: "POST",
			headers: { "content-type": "application/json", origin, cookie: person.headers.cookie },
			body: JSON.stringify({ clientId }),
		});

	const ping = (token: string) =>
		world.guard.fetch(`${origin}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});

	const refresh = (clientId: string, refreshToken: string) =>
		fromAnAddress()(`${origin}/api/auth/oauth2/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", origin },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: clientId,
				resource: `${origin}/mcp`,
			}),
		});

	/** Lets a second person allow an app that already exists, by its client id, as a second browser would. */
	async function allowAlso(person: Person, clientId: string) {
		const send = fromAnAddress();
		const verifier = randomBytes(32).toString("base64url");
		const authorize = new URL(`${origin}/api/auth/oauth2/authorize`);
		for (const [key, value] of Object.entries({
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirectUrl,
			scope: "openid guard offline_access",
			state: "s",
			resource: `${origin}/mcp`,
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			code_challenge_method: "S256",
		})) {
			authorize.searchParams.set(key, value);
		}
		const toConsent = await send(authorize, { headers: { cookie: person.headers.cookie } });
		const consent = new URL(((await toConsent.json()) as { url: string }).url, origin);
		expect(consent.pathname).toBe("/oauth/consent");
		const decision = await authApi("/oauth2/consent", person, {
			accept: true,
			oauth_query: consent.search.slice(1),
		});
		const callback = new URL(((await decision.json()) as { url: string }).url);
		const token = await send(`${origin}/api/auth/oauth2/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", origin },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: callback.searchParams.get("code") ?? "",
				redirect_uri: redirectUrl,
				client_id: clientId,
				code_verifier: verifier,
				resource: `${origin}/mcp`,
			}),
		});
		return (await token.json()) as { access_token: string; refresh_token: string };
	}

	it("lists an app with the name it gave, where it goes and when it was allowed, never used until it refreshes", async () => {
		const person = await world.stranger("gail");
		const before = Date.now();
		const assistant = await assistantFor(person);
		try {
			const { grants, text } = await listFor(person);
			expect(grants).toEqual([
				{
					clientId: assistant.clientId,
					name: "Guard integration test",
					destination: "an app on this computer",
					allowedAt: expect.any(Number),
					lastUsedAt: null,
				},
			]);
			expect(grants[0]?.allowedAt).toBeGreaterThanOrEqual(before - 1000);
			// Nothing the app holds is in the answer.
			expect(text).not.toContain(assistant.token);
			expect(text).not.toContain(assistant.refreshToken);

			const refreshed = await refresh(assistant.clientId, assistant.refreshToken);
			expect(refreshed.status).toBe(200);
			const issued = (await refreshed.json()) as { access_token: string; refresh_token: string };
			const after = await listFor(person);
			expect(after.grants[0]?.lastUsedAt).toBeGreaterThanOrEqual(before - 1000);
			for (const secret of [
				assistant.token,
				assistant.refreshToken,
				issued.access_token,
				issued.refresh_token,
			]) {
				expect(after.text).not.toContain(secret);
			}
		} finally {
			await assistant.client.close();
		}
	});

	it("lists nothing for someone who is not signed in, and nothing of anyone else's", async () => {
		const signedOut = await world.guard.fetch(`${origin}/api/assistants`);
		expect(signedOut.status).toBe(401);
		const nobody = await world.stranger("hal");
		expect((await listFor(nobody)).grants).toEqual([]);
	});

	it("ends access at once: the token still in date, the refresh and the list, and spares the rest", async () => {
		const person = await world.stranger("ida");
		const other = await world.stranger("jon");
		const doomed = await assistantFor(person);
		const kept = await assistantFor(person);
		const sameApp = await allowAlso(other, doomed.clientId);
		try {
			expect((await ping(doomed.token)).status).toBe(200);
			expect((await listFor(person)).grants).toHaveLength(2);

			const response = await takeBack(person, doomed.clientId);
			expect(response.status).toBe(200);

			// Its access token is a signed JWT with most of its hour left, and is turned away anyway.
			const refused = await ping(doomed.token);
			expect(refused.status).toBe(401);
			// Word for word what a token that is not valid gets, so a client asks the person again.
			const invalid = await ping("not.a.token");
			expect(refused.headers.get("www-authenticate")).toBe(invalid.headers.get("www-authenticate"));
			expect(refused.headers.get("www-authenticate")).toContain("resource_metadata=");
			expect(await refused.json()).toEqual(await invalid.json());
			const refreshed = await refresh(doomed.clientId, doomed.refreshToken);
			expect(refreshed.status).toBeGreaterThanOrEqual(400);

			expect((await listFor(person)).grants.map((one) => one.clientId)).toEqual([kept.clientId]);
			// Another app of theirs, and another person who allowed the very same app, carry on.
			expect((await ping(kept.token)).status).toBe(200);
			expect((await ping(sameApp.access_token)).status).toBe(200);
			expect((await refresh(doomed.clientId, sameApp.refresh_token)).status).toBe(200);
			expect((await listFor(other)).grants.map((one) => one.clientId)).toEqual([doomed.clientId]);

			// Asking again shows the consent page, as a new app would, and works once allowed.
			const again = await allowAlso(person, doomed.clientId);
			expect((await ping(again.access_token)).status).toBe(200);
		} finally {
			await doomed.client.close();
			await kept.client.close();
		}
	});

	it("answers not found for someone else's grant or an app that does not exist, and deletes nothing", async () => {
		const owner = await world.stranger("kim");
		const intruder = await world.stranger("lee");
		const assistant = await assistantFor(owner);
		try {
			for (const clientId of [assistant.clientId, "no-such-client"]) {
				const response = await takeBack(intruder, clientId);
				expect(response.status).toBe(404);
				expect(await response.json()).toEqual({ ok: false, error: "Not found" });
			}
			expect((await listFor(owner)).grants).toHaveLength(1);
			expect((await ping(assistant.token)).status).toBe(200);
			expect((await refresh(assistant.clientId, assistant.refreshToken)).status).toBe(200);
		} finally {
			await assistant.client.close();
		}
	});

	it("takes back only from the app's own pages, and only for someone signed in", async () => {
		const person = await world.stranger("nina");
		const assistant = await assistantFor(person);
		try {
			const send = (headers: Record<string, string>) =>
				world.guard.fetch(`${origin}/api/assistants`, {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: JSON.stringify({ clientId: assistant.clientId }),
				});
			expect((await send({ cookie: person.headers.cookie })).status).toBe(403);
			expect(
				(await send({ cookie: person.headers.cookie, origin: "https://evil.test" })).status,
			).toBe(403);
			expect((await send({ origin })).status).toBe(401);
			expect((await listFor(person)).grants).toHaveLength(1);
		} finally {
			await assistant.client.close();
		}
	});
});
