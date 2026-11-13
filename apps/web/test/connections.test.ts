import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cloudflareToken,
	githubToken,
	origin,
	sealToken,
	startWorld,
	type World,
} from "./connections-world";
import { ACCOUNT_ID, npmLock, OTHER_ACCOUNT_ID } from "./upstreams";

const insight = (
	id: string,
	issueClass: string,
	subject = "example.com",
	severity = "Moderate",
) => ({
	id,
	issue_class: issueClass,
	subject,
	severity,
});

describe("who may connect", () => {
	let world: World;
	beforeAll(async () => {
		world = await startWorld();
		world.upstream.addAccount(ACCOUNT_ID, cloudflareToken(1));
	});
	afterAll(async () => {
		await world?.dispose();
	});

	it("lets an owner connect, and refuses a member in words", async () => {
		const member = await world.addMember("mia");
		const refused = await world.act(member, {
			action: "connect-cloudflare",
			accountId: ACCOUNT_ID,
			token: cloudflareToken(1),
		});
		expect(refused.status).toBe(403);
		expect(refused.body.error).toMatch(/owner or admin/);
		expect(world.upstream.seen).toEqual([]);

		// Members still see the connections, without tokens.
		expect((await world.connections(member)).status).toBe(200);
		const admin = await world.addMember("ada", "admin");
		const connected = await world.act(admin, {
			action: "connect-cloudflare",
			accountId: ACCOUNT_ID,
			token: cloudflareToken(1),
		});
		expect(connected.status).toBe(200);
	});

	it("answers a non-member, a stranger to the workspace and a missing workspace alike", async () => {
		const stranger = await world.stranger("sam");
		const action = {
			action: "connect-cloudflare",
			accountId: ACCOUNT_ID,
			token: cloudflareToken(1),
		} as const;
		const asked = world.upstream.seen.length;
		const missing = await world.act(world.owner, action, "no-such-workspace");
		const notMember = await world.act(stranger, action);
		expect(missing.status).toBe(404);
		expect(notMember.status).toBe(404);
		expect(notMember.text).toBe(missing.text);
		const list = await world.connections(stranger);
		expect(list.status).toBe(404);
		expect((await world.findings("", stranger)).status).toBe(404);
		const signedOut = await world.guard.fetch(`${origin}/api/connections/${world.slug}`);
		expect(signedOut.status).toBe(404);
		// Nothing was asked of Cloudflare for any of them.
		expect(world.upstream.seen).toHaveLength(asked);
	});

	it("refuses a request that does not come from the app's own origin", async () => {
		const response = await world.guard.fetch(`${origin}/api/connections/${world.slug}`, {
			method: "POST",
			headers: { ...world.owner.headers, origin: "https://evil.test" },
			body: JSON.stringify({ action: "remove", id: "x" }),
		});
		expect(response.status).toBe(403);
	});

	it("checks every input at the boundary", async () => {
		const bad = [
			{ action: "connect-cloudflare", accountId: "nope", token: cloudflareToken(1) },
			{ action: "connect-cloudflare", accountId: ACCOUNT_ID, token: "short" },
			{ action: "connect-cloudflare", accountId: ACCOUNT_ID, token: `${cloudflareToken(1)} x` },
			{ action: "connect-github", repository: "not a repository", token: githubToken(1) },
			{ action: "connect-github", repository: "acme/shop", token: "x".repeat(401) },
			{
				action: "connect-cloudflare",
				accountId: ACCOUNT_ID,
				token: cloudflareToken(1),
				name: "n".repeat(101),
			},
			{ action: "something-else" },
		] as const;
		for (const action of bad) {
			const result = await world.act(world.owner, action as never);
			expect(result.status, JSON.stringify(action)).toBe(400);
			expect(result.body.ok).toBe(false);
		}
	});
});

describe("connecting without a SECRETS_KEY", () => {
	it("refuses with a clear message, asks nobody, and the page says the server is not set up", async () => {
		const world = await startWorld({ withoutKey: true });
		try {
			world.upstream.addAccount(ACCOUNT_ID, cloudflareToken(1));
			const result = await world.act(world.owner, {
				action: "connect-cloudflare",
				accountId: ACCOUNT_ID,
				token: cloudflareToken(1),
			});
			expect(result.status).toBe(400);
			expect(result.body.error).toContain("SECRETS_KEY");
			expect(world.upstream.seen).toEqual([]);
			expect((await world.connections()).body.sealingProblem).toContain("SECRETS_KEY");
			const page = await world.page(`/${world.slug}/connections`);
			expect(page.text).toContain("SECRETS_KEY");
		} finally {
			await world.dispose();
		}
	});

	it("refuses a key that is too short as well", async () => {
		const world = await startWorld({
			settings: { SECRETS_KEY: Buffer.alloc(16).toString("base64") },
		});
		try {
			const result = await world.act(world.owner, {
				action: "connect-cloudflare",
				accountId: ACCOUNT_ID,
				token: cloudflareToken(1),
			});
			expect(result.status).toBe(400);
			expect(result.body.error).toContain("32 bytes");
		} finally {
			await world.dispose();
		}
	});
});

describe("checking a token before keeping it", () => {
	let world: World;
	beforeAll(async () => {
		world = await startWorld();
		world.upstream.addAccount(ACCOUNT_ID, cloudflareToken(1));
	});
	afterAll(async () => {
		await world?.dispose();
	});

	it("refuses a Cloudflare token that is not accepted, and names the permission", async () => {
		const result = await world.act(world.owner, {
			action: "connect-cloudflare",
			accountId: ACCOUNT_ID,
			token: cloudflareToken(2),
		});
		expect(result.status).toBe(400);
		expect(result.body.error).toContain("Account › Security Center Insights › Read");
		expect((await world.connections()).body.connections).toEqual([]);
		// Nothing of a refused token is kept.
		expect(await world.dump()).not.toContain(cloudflareToken(2));
	});

	it("refuses a token for an account Cloudflare does not know in the same words", async () => {
		const result = await world.act(world.owner, {
			action: "connect-cloudflare",
			accountId: OTHER_ACCOUNT_ID,
			token: cloudflareToken(1),
		});
		expect(result.status).toBe(400);
		expect(result.body.error).toContain("Security Center Insights");
	});

	it("says Cloudflare is unavailable rather than blame the token", async () => {
		const account = world.upstream.accounts.get(ACCOUNT_ID);
		if (!account) throw new Error("expected the account");
		account.status = 503;
		const result = await world.act(world.owner, {
			action: "connect-cloudflare",
			accountId: ACCOUNT_ID,
			token: cloudflareToken(1),
		});
		account.status = undefined as never;
		expect(result.status).toBe(400);
		expect(result.body.error).not.toContain("Security Center Insights");
		expect(result.body.error).toMatch(/try again/i);
	});

	it("checks a repository, then that the token can read its files", async () => {
		world.upstream.addRepository("acme/shop", githubToken(1), 42);
		const wrong = await world.act(world.owner, {
			action: "connect-github",
			repository: "acme/shop",
			token: githubToken(2),
		});
		expect(wrong.status).toBe(400);
		expect(wrong.body.error).toMatch(/see that repository/);

		const metadataOnly = world.upstream.addRepository("acme/api", githubToken(3), 43);
		metadataOnly.contents = false;
		const noContents = await world.act(world.owner, {
			action: "connect-github",
			repository: "acme/api",
			token: githubToken(3),
		});
		expect(noContents.status).toBe(400);
		expect(noContents.body.error).toContain("Contents: Read-only");
		expect((await world.connections()).body.connections).toEqual([]);
	});

	it("refuses the same account or repository twice, whichever way the repository is written", async () => {
		await world.connectCloudflare(ACCOUNT_ID, cloudflareToken(1));
		const again = await world.act(world.owner, {
			action: "connect-cloudflare",
			accountId: ACCOUNT_ID.toUpperCase(),
			token: cloudflareToken(1),
		});
		expect(again.status).toBe(409);

		await world.connectGithub("https://github.com/acme/shop", githubToken(1));
		const twice = await world.act(world.owner, {
			action: "connect-github",
			repository: "ACME/Shop",
			token: githubToken(1),
		});
		expect(twice.status).toBe(409);
		expect((await world.connections()).body.connections).toHaveLength(2);
	});
});

describe("a token once it is connected", () => {
	it("is sealed in D1, and shows up in no page, answer, log or table", async () => {
		const world = await startWorld();
		try {
			const cf = cloudflareToken(7);
			const gh = githubToken(7);
			world.upstream.addAccount(ACCOUNT_ID, cf, [insight("i1", "hsts_not_enabled")]);
			world.upstream.addRepository("acme/shop", gh, 42, {
				"package-lock.json": npmLock({ lodash: "4.17.20" }),
			});
			world.upstream.addAdvisory({
				id: "GHSA-lodash",
				packageName: "lodash",
				severity: "HIGH",
				summary: "Prototype pollution in lodash",
				fixed: "4.17.21",
			});
			const texts: string[] = [];
			const first = await world.act(world.owner, {
				action: "connect-cloudflare",
				accountId: ACCOUNT_ID,
				token: cf,
				name: "Main account",
			});
			const second = await world.act(world.owner, {
				action: "connect-github",
				repository: "acme/shop",
				token: gh,
			});
			texts.push(first.text, second.text);
			expect(first.status, first.text).toBe(200);
			expect(second.status, second.text).toBe(200);

			const connection = (first.body as unknown as { connection: { id: string } }).connection;
			const row = await world.connectionRow(connection.id);
			expect(row?.token_sealed).toMatch(/^v2\.[A-Za-z0-9_-]{11}\./);
			expect(row?.token_sealed).not.toContain(cf);
			expect(row?.token_hint).toBe(cf.slice(-4));
			expect(row?.github_repository_id).toBeNull();

			const list = await world.guard.fetch(`${origin}/api/connections/${world.slug}`, {
				headers: world.owner.headers,
			});
			texts.push(await list.text());
			for (const query of ["", "status=resolved", "status=dismissed", "severity=high"]) {
				texts.push(
					await (
						await world.guard.fetch(`${origin}/api/findings/${world.slug}?${query}`, {
							headers: world.owner.headers,
						})
					).text(),
				);
			}
			const connectionsPage = await world.page(`/${world.slug}/connections`);
			const findingsPage = await world.page(`/${world.slug}/findings`);
			expect(connectionsPage.status).toBe(200);
			expect(findingsPage.status).toBe(200);
			// The pages carry the real connection, so what is missing from them is not just empty.
			expect(connectionsPage.text).toContain("Main account");
			expect(findingsPage.text).toContain("HSTS is off");
			texts.push(connectionsPage.text, findingsPage.text);
			// A member sees the same.
			const member = await world.addMember("mia");
			texts.push((await world.page(`/${world.slug}/connections`, member)).text);

			for (const text of texts) {
				expect(text).not.toContain(cf);
				expect(text).not.toContain(gh);
			}
			expect(texts.join("")).toContain(cf.slice(-4));
			expect(await world.dump()).not.toContain(cf);
			expect(await world.dump()).not.toContain(gh);
			expect(world.guard.logs.map((log) => log.message).join("\n")).not.toContain(cf);
			expect(world.guard.logs.map((log) => log.message).join("\n")).not.toContain(gh);

			// The token went to its own service and nowhere else, and Guard only read.
			for (const seen of world.upstream.seen) {
				if (seen.host === "osv.test") expect(seen.authorization).toBeNull();
				else expect(seen.method).toBe("GET");
				if (seen.authorization?.includes(cf)) expect(seen.host).toBe("cloudflare.test");
				if (seen.authorization?.includes(gh)) expect(seen.host).toBe("github.test");
			}
			expect(
				world.guard.outbound.every((url) => /\/\/(cloudflare|github|osv)\.test\//.test(url)),
			).toBe(true);
		} finally {
			await world.dispose();
		}
	});

	it("opens only where it was sealed: not in another connection's row", async () => {
		const world = await startWorld();
		try {
			world.upstream.addAccount(ACCOUNT_ID, cloudflareToken(1), [insight("i1", "dmarc")]);
			world.upstream.addAccount(OTHER_ACCOUNT_ID, cloudflareToken(2), [
				insight("i9", "spf", "other.example"),
			]);
			const a = await world.connectCloudflare(ACCOUNT_ID, cloudflareToken(1));
			const b = await world.connectCloudflare(OTHER_ACCOUNT_ID, cloudflareToken(2));
			const rowA = await world.connectionRow(a.connection.id);
			// Someone with write access to D1 copies a sealed token into another row.
			await world.guard.db
				.prepare("UPDATE connection SET token_sealed = ?1 WHERE id = ?2")
				.bind(rowA?.token_sealed, b.connection.id)
				.run();
			await world.scanDue([b.connection.id]);
			expect((await world.connectionRow(b.connection.id))?.last_scan_outcome).toBe("unreadable");
		} finally {
			await world.dispose();
		}
	});
});

describe("scans by fingerprint", () => {
	let world: World;
	beforeAll(async () => {
		world = await startWorld();
	});
	afterAll(async () => {
		await world?.dispose();
	});

	it("inserts, updates, resolves and reopens what Cloudflare reports", async () => {
		const token = cloudflareToken(1);
		const account = world.upstream.addAccount(ACCOUNT_ID, token, [
			insight("i1", "hsts_not_enabled", "example.com", "Moderate"),
			insight("i2", "dmarc", "example.com", "Critical"),
			{ ...insight("i3", "tls_not_enabled"), dismissed: true },
			{ ...insight("i4", "spf"), status: "resolved" as const },
		]);
		const { connection, scan } = await world.connectCloudflare(ACCOUNT_ID, token, "Main");
		// Dismissed and resolved insights in Cloudflare are not problems now.
		expect(scan).toMatchObject({ outcome: "ok", found: 2, added: 2, resolved: 0 });
		const first = await world.findingRows(connection.id);
		expect(first.map(({ kind, title, severity }) => ({ kind, title, severity }))).toEqual([
			{ kind: "dmarc", title: "DMARC is missing or misconfigured", severity: "critical" },
			{ kind: "hsts_not_enabled", title: "HSTS is off", severity: "moderate" },
		]);
		expect(first[0]?.url).toMatch(/^https:\/\/dash\.cloudflare\.com\//);
		const hsts = first.find((row) => row.kind === "hsts_not_enabled");

		// Next scan: HSTS gets less severe, DMARC is fixed, a class Guard has no title for appears.
		account.insights = [
			insight("i1", "hsts_not_enabled", "example.com", "Low"),
			insight("i5", "some_new_check_class", "api.example.com"),
		];
		await world.scanDue([connection.id]);
		const second = await world.findingRows(connection.id);
		const byKind = (rows: typeof second, kind: string) => rows.find((row) => row.kind === kind);
		expect(second).toHaveLength(3);
		expect(byKind(second, "hsts_not_enabled")).toMatchObject({
			id: hsts?.id,
			severity: "low",
			first_seen_at: hsts?.first_seen_at,
			resolved_at: null,
		});
		expect(byKind(second, "hsts_not_enabled")?.last_seen_at).toBeGreaterThan(
			hsts?.last_seen_at ?? 0,
		);
		expect(byKind(second, "dmarc")?.resolved_at).not.toBeNull();
		expect(byKind(second, "some_new_check_class")?.title).toBe("Some new check class");
		const scans = await world.guard.db
			.prepare(
				"SELECT found, new, resolved, outcome FROM scan WHERE connection_id = ?1 ORDER BY started_at",
			)
			.bind(connection.id)
			.all();
		expect(scans.results.at(-1)).toEqual({ found: 2, new: 1, resolved: 1, outcome: "ok" });

		// DMARC comes back, under another insight id: the same finding, open again.
		account.insights.push(insight("i2-again", "dmarc", "example.com", "Critical"));
		await world.scanDue([connection.id]);
		const third = await world.findingRows(connection.id);
		expect(third).toHaveLength(3);
		expect(byKind(third, "dmarc")).toMatchObject({
			id: byKind(first, "dmarc")?.id,
			resolved_at: null,
			first_seen_at: byKind(first, "dmarc")?.first_seen_at,
		});

		// The page lists open findings by severity, critical first.
		const listed = (await world.findings()).body;
		expect(listed.hasConnections).toBe(true);
		expect(listed.findings.map((one) => one.severity)).toEqual(["critical", "moderate", "low"]);
		expect(listed.findings.every((one) => one.connectionName === "Main")).toBe(true);
	});

	it("keeps only the last 30 scans of a connection", async () => {
		const token = cloudflareToken(3);
		world.upstream.addAccount(OTHER_ACCOUNT_ID, token, []);
		const { connection } = await world.connectCloudflare(OTHER_ACCOUNT_ID, token);
		const now = Date.now();
		await world.guard.db.batch(
			Array.from({ length: 40 }, (_, n) =>
				world.guard.db
					.prepare(
						"INSERT INTO scan (id, connection_id, started_at, finished_at, outcome) VALUES (?1, ?2, ?3, ?3, 'ok')",
					)
					.bind(`old-${n}`, connection.id, now - 1_000_000 + n),
			),
		);
		await world.scanDue([connection.id]);
		const count = await world.guard.db
			.prepare("SELECT count(*) AS n FROM scan WHERE connection_id = ?1")
			.bind(connection.id)
			.first<{ n: number }>();
		expect(count?.n).toBe(30);
	});
});

describe("dismissing", () => {
	it("stays dismissed whatever a scan sees, until an admin undoes it", async () => {
		const world = await startWorld();
		try {
			const token = cloudflareToken(1);
			const account = world.upstream.addAccount(ACCOUNT_ID, token, [
				insight("i1", "hsts_not_enabled"),
			]);
			const { connection } = await world.connectCloudflare(ACCOUNT_ID, token);
			const [found] = await world.findingRows(connection.id);
			if (!found) throw new Error("expected a finding");
			const member = await world.addMember("mia");
			const admin = await world.addMember("ada", "admin");
			const stranger = await world.stranger("sam");

			expect(
				(await world.changeFinding(member, { action: "dismiss", id: found.id, reason: "ok" }))
					.status,
			).toBe(403);
			expect(
				(await world.changeFinding(stranger, { action: "dismiss", id: found.id, reason: "ok" }))
					.status,
			).toBe(404);
			for (const reason of ["", "   ", "x".repeat(201)]) {
				const refused = await world.changeFinding(admin, {
					action: "dismiss",
					id: found.id,
					reason,
				});
				expect(refused.status).toBe(400);
			}
			expect((await world.findingRows(connection.id))[0]?.dismissed_at).toBeNull();

			const done = await world.changeFinding(admin, {
				action: "dismiss",
				id: found.id,
				reason: "The marketing site has its own HSTS",
			});
			expect(done.status).toBe(200);
			expect((await world.findings()).body.findings).toEqual([]);
			const dismissed = (await world.findings("status=dismissed")).body.findings;
			expect(dismissed).toMatchObject([
				{ id: found.id, status: "dismissed", dismissReason: "The marketing site has its own HSTS" },
			]);

			// Cloudflare still reports it, with new details: it stays dismissed, and is kept up to date.
			account.insights = [insight("i1", "hsts_not_enabled", "example.com", "Low")];
			await world.scanDue([connection.id]);
			expect((await world.findings()).body.findings).toEqual([]);
			const afterScan = (await world.findingRows(connection.id))[0];
			expect(afterScan).toMatchObject({ severity: "low", resolved_at: null });
			expect(afterScan?.dismissed_at).not.toBeNull();
			expect(afterScan?.dismiss_reason).toBe("The marketing site has its own HSTS");

			// It goes away and comes back: still dismissed through both.
			account.insights = [];
			await world.scanDue([connection.id]);
			expect((await world.findingRows(connection.id))[0]?.resolved_at).not.toBeNull();
			expect((await world.findings("status=dismissed")).body.findings).toHaveLength(1);
			account.insights = [insight("i1", "hsts_not_enabled")];
			await world.scanDue([connection.id]);
			expect((await world.findings()).body.findings).toEqual([]);
			expect((await world.findings("status=dismissed")).body.findings).toHaveLength(1);

			// Undoing it needs an admin, and brings the finding back as it now is.
			expect(
				(await world.changeFinding(member, { action: "undismiss", id: found.id })).status,
			).toBe(403);
			expect((await world.changeFinding(admin, { action: "undismiss", id: found.id })).status).toBe(
				200,
			);
			expect((await world.findings()).body.findings).toHaveLength(1);
			const after = (await world.findingRows(connection.id))[0];
			expect(after).toMatchObject({ dismissed_at: null, dismiss_reason: null });
		} finally {
			await world.dispose();
		}
	});

	it("can't reach another workspace's finding", async () => {
		const world = await startWorld();
		try {
			world.upstream.addAccount(ACCOUNT_ID, cloudflareToken(1), [insight("i1", "dmarc")]);
			const { connection } = await world.connectCloudflare(ACCOUNT_ID, cloudflareToken(1));
			const [found] = await world.findingRows(connection.id);
			const other = await world.stranger("olivia");
			const { createWorkspace } = await import("./accounts");
			await createWorkspace(world.guard, origin, other.headers, "elsewhere");
			const result = await world.changeFinding(
				other,
				{ action: "dismiss", id: found?.id ?? "", reason: "mine now" },
				"elsewhere",
			);
			expect(result.status).toBe(404);
			expect((await world.findingRows(connection.id))[0]?.dismissed_at).toBeNull();
		} finally {
			await world.dispose();
		}
	});
});

describe("listing findings", () => {
	it("orders by severity then newest, and filters by severity, source and status", async () => {
		const world = await startWorld();
		try {
			world.upstream.addAccount(ACCOUNT_ID, cloudflareToken(1), [
				insight("a", "dmarc", "a.example", "Low"),
				insight("b", "spf", "b.example", "Critical"),
			]);
			world.upstream.addRepository("acme/shop", githubToken(1), 42, {
				"package-lock.json": npmLock({ lodash: "4.17.20" }),
			});
			world.upstream.addAdvisory({
				id: "GHSA-lodash",
				packageName: "lodash",
				severity: "HIGH",
				summary: "Prototype pollution in lodash",
				fixed: "4.17.21",
			});
			const cf = await world.connectCloudflare(ACCOUNT_ID, cloudflareToken(1));
			await world.connectGithub("acme/shop", githubToken(1));
			// Make the Cloudflare findings older than the dependency one and one another.
			await world.guard.db
				.prepare(
					"UPDATE finding SET first_seen_at = first_seen_at - 100000 WHERE connection_id = ?1",
				)
				.bind(cf.connection.id)
				.run();

			const all = (await world.findings()).body;
			expect(all.total).toBe(3);
			expect(all.findings.map((one) => `${one.severity}:${one.kind}`)).toEqual([
				"critical:spf",
				"high:GHSA-lodash",
				"low:dmarc",
			]);
			const dependency = all.findings[1];
			expect(dependency).toMatchObject({
				source: "dependency",
				subject: "lodash@4.17.20 in package-lock.json",
				title: "Prototype pollution in lodash",
				fixedVersion: "4.17.21",
				url: "https://osv.dev/vulnerability/GHSA-lodash",
				connectionKind: "github",
				connectionName: "acme/shop",
			});
			expect((await world.findings("source=cloudflare")).body.findings).toHaveLength(2);
			expect((await world.findings("source=dependency")).body.findings).toHaveLength(1);
			expect((await world.findings("severity=low")).body.findings.map((one) => one.kind)).toEqual([
				"dmarc",
			]);
			expect((await world.findings("status=resolved")).body.findings).toEqual([]);
			// Filters the app does not know are ignored rather than trusted.
			expect((await world.findings("severity=bogus&status=bogus")).body.findings).toHaveLength(3);
		} finally {
			await world.dispose();
		}
	});
});

describe("scanning a repository", () => {
	let world: World;
	const token = githubToken(1);
	beforeAll(async () => {
		world = await startWorld();
		world.upstream.addAdvisory({
			id: "GHSA-lodash",
			packageName: "lodash",
			severity: "CRITICAL",
			summary: "Prototype pollution in lodash",
			fixed: "4.17.21",
		});
	});
	afterAll(async () => {
		await world?.dispose();
	});

	it("keeps findings of a lockfile it could not read, and closes them once they are gone", async () => {
		const repository = world.upstream.addRepository("acme/shop", token, 42, {
			"package-lock.json": npmLock({ lodash: "4.17.20" }),
		});
		const { connection, scan } = await world.connectGithub("acme/shop", token);
		expect(scan).toMatchObject({ outcome: "ok", found: 1, added: 1 });
		const row = await world.connectionRow(connection.id);
		expect(row?.github_repository_id).toBe(42);
		const [found] = await world.findingRows(connection.id);
		expect(found).toMatchObject({
			kind: "GHSA-lodash",
			severity: "critical",
			subject: "lodash@4.17.20 in package-lock.json",
			fixed_version: "4.17.21",
			resolved_at: null,
		});

		// npm's version 1 lockfile cannot be read: nothing is seen, so nothing is called gone.
		repository.lockfiles["package-lock.json"] = JSON.stringify({
			lockfileVersion: 1,
			dependencies: {},
		});
		await world.scanDue([connection.id]);
		expect((await world.findingRows(connection.id))[0]?.resolved_at).toBeNull();

		// Now it reads, and lodash has moved on: the finding is closed.
		repository.lockfiles["package-lock.json"] = npmLock({ lodash: "4.17.21" });
		world.upstream.advisories.clear();
		await world.scanDue([connection.id]);
		expect((await world.findingRows(connection.id))[0]?.resolved_at).not.toBeNull();
		expect((await world.findings()).body.findings).toEqual([]);
	});

	it("records an outage of OSV and changes no finding", async () => {
		const repository = world.upstream.repositories.get("acme/shop");
		if (!repository) throw new Error("expected the repository");
		const { results } = (await world.guard.db.prepare("SELECT id FROM connection").all()) as {
			results: { id: string }[];
		};
		const id = results[0]?.id ?? "";
		repository.lockfiles["package-lock.json"] = npmLock({ lodash: "4.17.20" });
		world.upstream.addAdvisory({
			id: "GHSA-lodash",
			packageName: "lodash",
			severity: "CRITICAL",
			summary: "Prototype pollution in lodash",
			fixed: "4.17.21",
		});
		await world.scanDue([id]);
		const before = await world.findingRows(id);
		expect(before[0]?.resolved_at).toBeNull();

		world.upstream.osv.down = true;
		await world.scanDue([id]);
		world.upstream.osv.down = false;
		expect((await world.connectionRow(id))?.last_scan_outcome).toBe("unavailable");
		expect(await world.findingRows(id)).toEqual(before);
	});
});

describe("a scan that fails", () => {
	it("changes no findings, says what failed, and tries again when it makes sense", async () => {
		const world = await startWorld();
		try {
			const token = cloudflareToken(1);
			const account = world.upstream.addAccount(ACCOUNT_ID, token, [insight("i1", "dmarc")]);
			const { connection } = await world.connectCloudflare(ACCOUNT_ID, token);
			const before = await world.findingRows(connection.id);
			expect(before).toHaveLength(1);

			// A revoked token needs someone's attention: the next try is a day away.
			account.token = "revoked";
			const start = Date.now();
			await world.scanDue([connection.id]);
			let row = await world.connectionRow(connection.id);
			expect(row?.last_scan_outcome).toBe("forbidden");
			expect(row?.scan_started_at).toBeNull();
			expect(row?.next_scan_at).toBeGreaterThan(start + 23 * 3600_000);
			expect(await world.findingRows(connection.id)).toEqual(before);
			const listed = (await world.connections()).body.connections[0];
			expect(listed).toMatchObject({ lastScanOutcome: "forbidden", openFindings: 1 });
			const scanRow = await world.guard.db
				.prepare(
					"SELECT outcome, found, new, resolved FROM scan WHERE connection_id = ?1 ORDER BY started_at DESC",
				)
				.bind(connection.id)
				.first();
			expect(scanRow).toEqual({ outcome: "forbidden", found: 0, new: 0, resolved: 0 });

			// An outage passes with time: the next try is within the hour.
			account.token = token;
			account.status = 503;
			await world.scanDue([connection.id]);
			row = await world.connectionRow(connection.id);
			expect(row?.last_scan_outcome).toBe("unavailable");
			expect(row?.next_scan_at).toBeLessThan(Date.now() + 3600_000 + 60_000);
			expect(await world.findingRows(connection.id)).toEqual(before);

			// And when it works again, the connection is well.
			account.status = undefined as never;
			await world.scanDue([connection.id]);
			expect((await world.connectionRow(connection.id))?.last_scan_outcome).toBe("ok");
		} finally {
			await world.dispose();
		}
	});

	it("marks a token that no longer opens as unreadable, and leaves the findings", async () => {
		const other = Buffer.alloc(32, 5).toString("base64");
		const world = await startWorld({ isolates: 2, isolateSettings: [{}, { SECRETS_KEY: other }] });
		try {
			world.upstream.addAccount(ACCOUNT_ID, cloudflareToken(1), [insight("i1", "dmarc")]);
			const { connection } = await world.connectCloudflare(ACCOUNT_ID, cloudflareToken(1));
			// The second copy of the Worker has another key, as a deployment whose key was swapped.
			await world.scanDue([connection.id], 1);
			expect((await world.connectionRow(connection.id))?.last_scan_outcome).toBe("unreadable");
			expect(await world.findingRows(connection.id)).toHaveLength(1);
			expect((await world.findings()).body.findings).toHaveLength(1);
		} finally {
			await world.dispose();
		}
	});
});

describe("the hourly run", () => {
	it("scans at most 10 connections, oldest due first, and the rest next time", async () => {
		const world = await startWorld();
		try {
			const now = Date.now();
			const ids: string[] = [];
			for (let n = 0; n < 12; n++) {
				const accountId = n.toString(16).padStart(32, "0");
				const token = cloudflareToken(n);
				world.upstream.addAccount(accountId, token, [insight(`i${n}`, "dmarc")]);
				const id = `due-${String(n).padStart(2, "0")}`;
				ids.push(id);
				await world.guard.db
					.prepare(
						"INSERT INTO connection (id, organization_id, kind, target, name, token_sealed, token_hint, added_by, added_at, next_scan_at) VALUES (?1, ?2, 'cloudflare', ?3, ?3, ?4, ?5, 'x', ?6, ?7)",
					)
					.bind(
						id,
						world.workspaceId,
						accountId,
						await sealToken(world.key, world.workspaceId, id, token),
						token.slice(-4),
						now,
						// Oldest first: the later ones are due more recently.
						1000 + n,
					)
					.run();
			}
			// One that is not due yet is left alone.
			const later = "not-due";
			await world.guard.db
				.prepare(
					"INSERT INTO connection (id, organization_id, kind, target, name, token_sealed, token_hint, added_by, added_at, next_scan_at) VALUES (?1, ?2, 'cloudflare', ?3, ?3, 'v2.x.y.z', 'abcd', 'x', ?4, ?5)",
				)
				.bind(later, world.workspaceId, "f".repeat(32), now, now + 3600_000)
				.run();

			await world.guard.runScheduled(0, "0 * * * *");
			const scanned = async () =>
				(
					(
						await world.guard.db
							.prepare("SELECT id FROM connection WHERE last_scan_at IS NOT NULL ORDER BY id")
							.all()
					).results as { id: string }[]
				).map((row) => row.id);
			expect(await scanned()).toEqual(ids.slice(0, 10));
			expect(world.upstream.seen.filter((seen) => seen.host === "cloudflare.test")).toHaveLength(
				10,
			);
			expect(
				world.guard.logs.some((log) => log.message.includes('scans: {"scanned":10,"failed":0}')),
			).toBe(true);

			await world.guard.runScheduled(0, "0 * * * *");
			expect(await scanned()).toEqual(ids);
			expect((await world.connectionRow(later))?.last_scan_at).toBeNull();
			// Each was then set a day ahead.
			expect((await world.connectionRow(ids[0] ?? ""))?.next_scan_at).toBeGreaterThan(
				now + 23 * 3600_000,
			);
		} finally {
			await world.dispose();
		}
	});

	it("never scans one connection twice at once", async () => {
		const world = await startWorld({ isolates: 2 });
		try {
			const token = cloudflareToken(1);
			world.upstream.addAccount(ACCOUNT_ID, token, [insight("i1", "dmarc")]);
			const { connection } = await world.connectCloudflare(ACCOUNT_ID, token);
			const cloudflareCalls = () =>
				world.upstream.seen.filter((seen) => seen.host === "cloudflare.test").length;
			const before = cloudflareCalls();
			await world.guard.db
				.prepare("UPDATE connection SET next_scan_at = 0 WHERE id = ?1")
				.bind(connection.id)
				.run();

			// One copy of the Worker starts, and Cloudflare is slow.
			let release: () => void = () => undefined;
			world.upstream.hold.until = new Promise<void>((resolve) => {
				release = resolve;
			});
			const running = world.guard.runScheduled(0, "0 * * * *");
			await expect.poll(cloudflareCalls, { timeout: 10_000 }).toBe(before + 1);

			// Meanwhile another copy's hourly run, and an admin's "Scan now", find it taken.
			await world.guard.runScheduled(1, "0 * * * *");
			const busy = await world.act(
				world.owner,
				{ action: "scan", id: connection.id },
				world.slug,
				1,
			);
			expect(busy.status).toBe(409);
			expect(busy.body.error).toMatch(/already running/);
			expect(cloudflareCalls()).toBe(before + 1);

			release();
			world.upstream.hold.until = null;
			await running;
			expect(cloudflareCalls()).toBe(before + 1);
			const row = await world.connectionRow(connection.id);
			expect(row?.scan_started_at).toBeNull();
			expect(row?.last_scan_outcome).toBe("ok");
		} finally {
			await world.dispose();
		}
	});

	it("takes up a scan whose copy of the Worker died, after ten minutes", async () => {
		const world = await startWorld();
		try {
			const token = cloudflareToken(1);
			world.upstream.addAccount(ACCOUNT_ID, token, [insight("i1", "dmarc")]);
			const { connection } = await world.connectCloudflare(ACCOUNT_ID, token);
			const calls = () =>
				world.upstream.seen.filter((seen) => seen.host === "cloudflare.test").length;
			const before = calls();
			const set = (startedAgo: number) =>
				world.guard.db
					.prepare("UPDATE connection SET next_scan_at = 0, scan_started_at = ?2 WHERE id = ?1")
					.bind(connection.id, Date.now() - startedAgo)
					.run();
			await set(60_000);
			await world.guard.runScheduled(0, "0 * * * *");
			expect(calls()).toBe(before);
			await set(11 * 60_000);
			await world.guard.runScheduled(0, "0 * * * *");
			expect(calls()).toBe(before + 1);
		} finally {
			await world.dispose();
		}
	});

	it("leaves the daily work to the daily run", async () => {
		const world = await startWorld();
		try {
			await world.guard.db
				.prepare(
					"INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at) VALUES ('v', 'x', 'y', 1000, 1000, 1000)",
				)
				.run();
			await world.guard.runScheduled(0, "0 * * * *");
			const left = await world.guard.db
				.prepare("SELECT count(*) AS n FROM verification")
				.first<{ n: number }>();
			expect(left?.n).toBe(1);
			await world.guard.runScheduled(0);
			const gone = await world.guard.db
				.prepare("SELECT count(*) AS n FROM verification")
				.first<{ n: number }>();
			expect(gone?.n).toBe(0);
		} finally {
			await world.dispose();
		}
	});
});

describe("Scan now", () => {
	it("is for admins, once in five minutes per connection", async () => {
		const world = await startWorld();
		try {
			const token = cloudflareToken(1);
			const account = world.upstream.addAccount(ACCOUNT_ID, token, []);
			const { connection } = await world.connectCloudflare(ACCOUNT_ID, token);
			const member = await world.addMember("mia");
			const stranger = await world.stranger("sam");
			const scan = { action: "scan", id: connection.id } as const;
			expect((await world.act(member, scan)).status).toBe(403);
			expect((await world.act(stranger, scan)).status).toBe(404);

			account.insights = [insight("i1", "hsts_not_enabled")];
			const first = await world.act<{ scan: { outcome: string; found: number; added: number } }>(
				world.owner,
				scan,
			);
			expect(first.status).toBe(200);
			expect(first.body.scan).toMatchObject({ outcome: "ok", found: 1, added: 1 });
			const again = await world.act(world.owner, scan);
			expect(again.status).toBe(429);
			expect(again.body.error).toMatch(/few minutes/);
			// Another connection has its own allowance.
			world.upstream.addAccount(OTHER_ACCOUNT_ID, cloudflareToken(2), []);
			const other = await world.connectCloudflare(OTHER_ACCOUNT_ID, cloudflareToken(2));
			expect(
				(await world.act(world.owner, { action: "scan", id: other.connection.id })).status,
			).toBe(200);
			// A connection of another workspace is not found, and costs no allowance.
			const ownWorkspace = await world.stranger("olivia");
			const { createWorkspace } = await import("./accounts");
			await createWorkspace(world.guard, origin, ownWorkspace.headers, "elsewhere");
			expect((await world.act(ownWorkspace, scan, "elsewhere")).status).toBe(404);
		} finally {
			await world.dispose();
		}
	});
});

describe("replacing a token", () => {
	it("checks the new one first, seals it, and scans again", async () => {
		const world = await startWorld();
		try {
			const old = cloudflareToken(1);
			const account = world.upstream.addAccount(ACCOUNT_ID, old, [insight("i1", "dmarc")]);
			const { connection } = await world.connectCloudflare(ACCOUNT_ID, old);
			account.token = cloudflareToken(2);
			await world.scanDue([connection.id]);
			expect((await world.connectionRow(connection.id))?.last_scan_outcome).toBe("forbidden");

			const member = await world.addMember("mia");
			expect(
				(
					await world.act(member, {
						action: "replace-token",
						id: connection.id,
						token: cloudflareToken(2),
					})
				).status,
			).toBe(403);
			const wrong = await world.act(world.owner, {
				action: "replace-token",
				id: connection.id,
				token: cloudflareToken(3),
			});
			expect(wrong.status).toBe(400);
			expect(wrong.body.error).toContain("Security Center Insights");
			expect((await world.connectionRow(connection.id))?.token_hint).toBe(old.slice(-4));

			const fresh = await world.act<{ scan: { outcome: string } }>(world.owner, {
				action: "replace-token",
				id: connection.id,
				token: cloudflareToken(2),
			});
			expect(fresh.body.scan.outcome).toBe("ok");
			const row = await world.connectionRow(connection.id);
			expect(row?.token_hint).toBe(cloudflareToken(2).slice(-4));
			expect(row?.token_sealed).not.toContain(cloudflareToken(2));
			expect(row?.last_scan_outcome).toBe("ok");
		} finally {
			await world.dispose();
		}
	});

	it("won't take a token for another repository under the same connection", async () => {
		const world = await startWorld();
		try {
			world.upstream.addRepository("acme/shop", githubToken(1), 42);
			world.upstream.addRepository("acme/other", githubToken(2), 43);
			const { connection } = await world.connectGithub("acme/shop", githubToken(1));
			// The same name, a different repository: deleted and made again.
			world.upstream.repositories.set("acme/shop", {
				id: 99,
				token: githubToken(2),
				branch: "main",
				contents: true,
				lockfiles: {},
			});
			const result = await world.act(world.owner, {
				action: "replace-token",
				id: connection.id,
				token: githubToken(2),
			});
			expect(result.status).toBe(400);
			expect(result.body.error).toMatch(/different repository/);
		} finally {
			await world.dispose();
		}
	});
});

describe("removing a connection", () => {
	it("deletes its token, findings and scans at once, and no one else's", async () => {
		const world = await startWorld();
		try {
			world.upstream.addAccount(ACCOUNT_ID, cloudflareToken(1), [insight("i1", "dmarc")]);
			world.upstream.addAccount(OTHER_ACCOUNT_ID, cloudflareToken(2), [insight("i2", "spf")]);
			const a = await world.connectCloudflare(ACCOUNT_ID, cloudflareToken(1));
			const b = await world.connectCloudflare(OTHER_ACCOUNT_ID, cloudflareToken(2));
			const member = await world.addMember("mia");
			const stranger = await world.stranger("sam");
			const remove = { action: "remove", id: a.connection.id } as const;

			expect((await world.act(member, remove)).status).toBe(403);
			expect((await world.act(stranger, remove)).status).toBe(404);
			expect(await world.connectionRow(a.connection.id)).not.toBeNull();

			expect((await world.act(world.owner, remove)).status).toBe(200);
			expect(await world.connectionRow(a.connection.id)).toBeNull();
			const counts = async (id: string) => ({
				findings: (
					await world.guard.db
						.prepare("SELECT count(*) AS n FROM finding WHERE connection_id = ?1")
						.bind(id)
						.first<{ n: number }>()
				)?.n,
				scans: (
					await world.guard.db
						.prepare("SELECT count(*) AS n FROM scan WHERE connection_id = ?1")
						.bind(id)
						.first<{ n: number }>()
				)?.n,
			});
			expect(await counts(a.connection.id)).toEqual({ findings: 0, scans: 0 });
			expect(await counts(b.connection.id)).toEqual({ findings: 1, scans: 1 });
			expect((await world.findings()).body.findings.map((one) => one.kind)).toEqual(["spf"]);
			expect((await world.act(world.owner, remove)).status).toBe(404);
			// What a removed connection held is gone from every table, its sealed token included.
			const dump = await world.dump();
			expect(dump).not.toContain(a.connection.id);
			expect(dump).not.toContain(a.connection.target);
		} finally {
			await world.dispose();
		}
	});

	it("is not hindered by a scan that ends after it", async () => {
		const world = await startWorld({ isolates: 2 });
		try {
			const token = cloudflareToken(1);
			world.upstream.addAccount(ACCOUNT_ID, token, [insight("i1", "dmarc")]);
			const { connection } = await world.connectCloudflare(ACCOUNT_ID, token);
			await world.guard.db
				.prepare("UPDATE connection SET next_scan_at = 0 WHERE id = ?1")
				.bind(connection.id)
				.run();
			let release: () => void = () => undefined;
			world.upstream.hold.until = new Promise<void>((resolve) => {
				release = resolve;
			});
			const running = world.guard.runScheduled(0, "0 * * * *");
			await expect
				.poll(() => world.upstream.seen.filter((seen) => seen.host === "cloudflare.test").length, {
					timeout: 10_000,
				})
				.toBeGreaterThan(2);
			expect(
				(await world.act(world.owner, { action: "remove", id: connection.id }, world.slug, 1))
					.status,
			).toBe(200);
			release();
			world.upstream.hold.until = null;
			await running;
			// The scan found its connection gone and wrote nothing.
			expect(await world.dump()).toBe("[[],[],[]]");
		} finally {
			await world.dispose();
		}
	});
});

describe("the cap on connections", () => {
	it("is said in words by the endpoint and held by the database", async () => {
		const world = await startWorld();
		try {
			const now = Date.now();
			const insert = (n: number) =>
				world.guard.db
					.prepare(
						"INSERT INTO connection (id, organization_id, kind, target, name, token_sealed, token_hint, added_by, added_at, next_scan_at) VALUES (?1, ?2, 'cloudflare', ?3, ?3, 'v2.x.y.z', 'abcd', 'x', ?4, ?5)",
					)
					.bind(`cap-${n}`, world.workspaceId, n.toString(16).padStart(32, "0"), now, now + 1e9);
			await world.guard.db.batch(Array.from({ length: 50 }, (_, n) => insert(n)));

			world.upstream.addAccount(ACCOUNT_ID, cloudflareToken(1));
			const refused = await world.act(world.owner, {
				action: "connect-cloudflare",
				accountId: ACCOUNT_ID,
				token: cloudflareToken(1),
			});
			expect(refused.status).toBe(400);
			expect(refused.body.error).toContain("50");
			expect(world.upstream.seen).toEqual([]);
			// A path that forgot to ask is stopped by the trigger.
			await expect(insert(50).run()).rejects.toThrow(/at most 50 connections/);
			// Another workspace has its own 50.
			const other = await world.stranger("olivia");
			const { createWorkspace } = await import("./accounts");
			const otherId = await createWorkspace(world.guard, origin, other.headers, "elsewhere");
			await world.guard.db
				.prepare(
					"INSERT INTO connection (id, organization_id, kind, target, name, token_sealed, token_hint, added_by, added_at, next_scan_at) VALUES ('o-1', ?1, 'cloudflare', ?2, ?2, 'v2.x.y.z', 'abcd', 'x', ?3, ?3)",
				)
				.bind(otherId, "e".repeat(32), now)
				.run();
		} finally {
			await world.dispose();
		}
	});
});

describe("a changed SECRETS_KEY", () => {
	it("has the daily run seal tokens again under the new key, and scans keep working", async () => {
		const OLD = Buffer.alloc(32, 1).toString("base64");
		const NEW = Buffer.alloc(32, 2).toString("base64");
		const OTHER = Buffer.alloc(32, 3).toString("base64");
		// The first copy has only the old key, as the deployment before the change; the second has
		// the new one and keeps the old as the previous, as after it.
		const world = await startWorld({
			isolates: 2,
			settings: { SECRETS_KEY: OLD },
			isolateSettings: [{}, { SECRETS_KEY: NEW, SECRETS_KEY_PREVIOUS: OLD }],
		});
		try {
			const token = cloudflareToken(1);
			world.upstream.addAccount(ACCOUNT_ID, token, [insight("i1", "dmarc")]);
			const { connection } = await world.connectCloudflare(ACCOUNT_ID, token);
			// Another token, sealed under a key this deployment never had.
			const lost = "lost-connection";
			await world.guard.db
				.prepare(
					"INSERT INTO connection (id, organization_id, kind, target, name, token_sealed, token_hint, added_by, added_at, next_scan_at) VALUES (?1, ?2, 'cloudflare', ?3, ?3, ?4, 'abcd', 'x', ?5, ?6)",
				)
				.bind(
					lost,
					world.workspaceId,
					"a".repeat(32),
					await sealToken(OTHER, world.workspaceId, lost, "never-opens-never-opens"),
					Date.now(),
					Date.now() + 1e9,
				)
				.run();
			const before = (await world.connectionRow(connection.id))?.token_sealed ?? "";
			const newId = (await sealToken(NEW, world.workspaceId, connection.id, "x")).split(".")[1];
			expect(before.split(".")[1]).not.toBe(newId);

			await world.guard.runScheduled(1);

			const after = (await world.connectionRow(connection.id))?.token_sealed ?? "";
			expect(after.split(".")[1]).toBe(newId);
			expect(after).not.toContain(token);
			expect(
				world.guard.logs.some(
					(log) => log.message === 'secrets: {"resealed":1,"unopened":1,"left":1}',
				),
			).toBe(true);
			// The new key opens it: a scan from the second copy works.
			await world.scanDue([connection.id], 1);
			expect((await world.connectionRow(connection.id))?.last_scan_outcome).toBe("ok");
			// The old key no longer does: a copy that still has only it cannot read the token.
			await world.scanDue([connection.id], 0);
			expect((await world.connectionRow(connection.id))?.last_scan_outcome).toBe("unreadable");
			// What opens with neither key stays as it was.
			const stays = await world.connectionRow(lost);
			expect(stays?.token_sealed.split(".")[1]).not.toBe(newId);
		} finally {
			await world.dispose();
		}
	});
});
