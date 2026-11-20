import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TrackActionInput } from "../src/lib/track-schemas";
import { sealToken, startWorld, type World } from "./connections-world";
import { ACCOUNT_ID, npmLock } from "./upstreams";

// Filing a finding in Gateweave Track, and asking Agents for a fix through it, through the
// built Worker, with a stand-in Track MCP server (`fake-track.ts`).

/** Tokens and keys with endings no other text in these tests has, to look for where they must not be. */
const CF_TOKEN = "cf-secret-token-abcdefghijklmnCNH7";
const GH_TOKEN = "github_pat_ghp_abcdefghijklmnopqrGH7X";
const KEY = `gwt_${"A".repeat(39)}Q7Z9`;
const OTHER_KEY = `gwt_${"B".repeat(39)}ZZ99`;
const HINTS = ["CNH7", "GH7X", "Q7Z9"];

const TRACK = "https://track.test";
const form = (
	over: Partial<Extract<TrackActionInput, { action: "save" }>> = {},
): TrackActionInput => ({
	action: "save",
	address: TRACK,
	workspace: "acme",
	team: "DEMO",
	key: KEY,
	...over,
});

/** A world with a Cloudflare account, a repository and a Track workspace, none of it filed yet. */
async function startFiling(labels = ["security", "agent"]) {
	const world = await startWorld();
	world.upstream.addAccount(ACCOUNT_ID, CF_TOKEN, [
		{ id: "i1", issue_class: "hsts_not_enabled", subject: "example.com", severity: "Moderate" },
		{ id: "i2", issue_class: "dmarc", subject: "a.example", severity: "Low" },
	]);
	world.upstream.addRepository("acme/shop", GH_TOKEN, 42, {
		"package-lock.json": npmLock({ lodash: "4.17.20" }),
	});
	world.upstream.addAdvisory({
		id: "GHSA-lodash",
		packageName: "lodash",
		severity: "HIGH",
		summary: "Prototype pollution in lodash",
		fixed: "4.17.21",
	});
	world.upstream.track.addWorkspace(
		"acme",
		KEY,
		[
			{ key: "DEMO", name: "Guard" },
			{ key: "OPS", name: "Operations" },
		],
		labels,
	);
	await world.connectCloudflare(ACCOUNT_ID, CF_TOKEN);
	await world.connectGithub("acme/shop", GH_TOKEN);
	return world;
}

async function findingOf(world: World, kind: string, person = world.owner) {
	const found = (await world.findings("", person)).body.findings.find((one) => one.kind === kind);
	if (!found) throw new Error(`no finding of kind ${kind}`);
	return found;
}

const created = (world: World) =>
	world.upstream.track.calls.filter((c) => c.tool === "create_issue");
const updated = (world: World) =>
	world.upstream.track.calls.filter((c) => c.tool === "update_issue");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean) {
	for (let tries = 0; tries < 200 && !condition(); tries++) await wait(25);
	expect(condition()).toBe(true);
}

describe("connecting Track in Settings", () => {
	let world: World;
	beforeAll(async () => {
		world = await startFiling();
	});
	afterAll(async () => {
		await world?.dispose();
	});
	beforeEach(async () => {
		await world.guard.db.prepare("DELETE FROM track_integration").run();
		world.upstream.track.requests.length = 0;
		world.upstream.track.calls.length = 0;
	});

	it("checks the key against the workspace and team, and seals it", async () => {
		const saved = await world.changeTrack(world.owner, form({ fixLabel: "AGENT" }));
		expect(saved.status, saved.text).toBe(200);
		// Track was asked what the key can see, with the key as a bearer token.
		expect(world.upstream.track.calls).toEqual([
			{ tool: "get_workspace", args: { workspace: "acme" } },
		]);
		expect(world.upstream.track.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);

		const row = await world.trackRow();
		expect(row).toMatchObject({
			address: TRACK,
			workspace_slug: "acme",
			team_key: "DEMO",
			// Track's own spelling of the label, not what was typed.
			fix_label: "agent",
			key_hint: "Q7Z9",
			last_check_outcome: "ok",
		});
		expect(row?.key_sealed).toMatch(/^v2\.[A-Za-z0-9_-]{11}\./);
		expect(row?.key_sealed).not.toContain(KEY);
		expect(await world.dumpTrack()).not.toContain(KEY);
		expect(await world.dump()).not.toContain(KEY);

		// The key is in no answer, and only owners and admins see even its last four characters.
		const admin = await world.trackPage();
		expect(admin.text).not.toContain(KEY);
		expect(admin.body.integration).toMatchObject({
			team: "DEMO",
			fixLabel: "agent",
			keyHint: "Q7Z9",
		});
		const member = await world.addMember("mia");
		const page = await world.trackPage(member);
		expect(page.body.integration).toMatchObject({ team: "DEMO", keyHint: null });
		expect(page.text).not.toContain("Q7Z9");
	});

	it("refuses a key Track does not accept, in a sentence, and saves nothing", async () => {
		const refused = await world.changeTrack(world.owner, form({ key: OTHER_KEY }));
		expect(refused.status).toBe(400);
		expect(refused.body.error).toMatch(/refused the key.*revoked/);
		expect(await world.trackRow()).toBeNull();
	});

	it("refuses a revoked key the same way", async () => {
		world.upstream.track.addWorkspace("beta", OTHER_KEY);
		world.upstream.track.revoke(OTHER_KEY);
		const refused = await world.changeTrack(
			world.owner,
			form({ key: OTHER_KEY, workspace: "beta" }),
		);
		expect(refused.body.error).toMatch(/revoked/);
	});

	it("says when the workspace or the team is not there", async () => {
		const noWorkspace = await world.changeTrack(world.owner, form({ workspace: "nowhere" }));
		expect(noWorkspace.body.error).toMatch(/no workspace "nowhere"/i);
		// A workspace the key cannot see answers as a missing one does.
		world.upstream.track.addWorkspace("beta", OTHER_KEY);
		const notYours = await world.changeTrack(world.owner, form({ workspace: "beta" }));
		expect(notYours.body.error).toMatch(/no workspace "beta"/i);
		const noTeam = await world.changeTrack(world.owner, form({ team: "NOPE" }));
		expect(noTeam.body.error).toMatch(/no team with the key NOPE.*DEMO, OPS/);
		expect(await world.trackRow()).toBeNull();
	});

	it("says when the label is not in Track, since Guard never makes one", async () => {
		const refused = await world.changeTrack(world.owner, form({ fixLabel: "autofix" }));
		expect(refused.body.error).toMatch(/no label "autofix".*Make it in Track/);
		expect(await world.trackRow()).toBeNull();
	});

	it("says when Track cannot be reached, or is not Track", async () => {
		const gone = await world.changeTrack(world.owner, form({ address: "https://gone.test" }));
		expect(gone.body.error).toMatch(/could not be reached/);
		expect(await world.trackRow()).toBeNull();
	});

	it("keeps no address the key would be sent to in the clear or by a trick", async () => {
		for (const address of [
			"http://track.test",
			"https://user:pw@track.test",
			"https://track.test/app",
			"ftp://track.test",
		]) {
			const refused = await world.changeTrack(world.owner, form({ address }));
			expect(refused.status, address).toBe(400);
		}
		expect(world.upstream.track.requests).toEqual([]);
		expect(await world.trackRow()).toBeNull();
	});

	it("reuses the kept key when it is left out, but never at another address", async () => {
		await world.changeTrack(world.owner, form());
		world.upstream.track.calls.length = 0;
		world.upstream.track.requests.length = 0;
		const kept = await world.changeTrack(world.owner, form({ key: undefined, team: "OPS" }));
		expect(kept.status, kept.text).toBe(200);
		expect((await world.trackRow())?.team_key).toBe("OPS");
		expect(world.upstream.track.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);

		// Another address would be handed the key to this Track, so it needs a key of its own.
		world.guard.outbound.length = 0;
		const other = await world.changeTrack(
			world.owner,
			form({ key: undefined, address: "https://other-track.test" }),
		);
		expect(other.status).toBe(400);
		expect(other.body.error).toMatch(/different address needs its own agent key/);
		expect(world.guard.outbound.join()).not.toContain("other-track.test");
	});

	it("replaces the key, and removes the integration", async () => {
		await world.changeTrack(world.owner, form());
		world.upstream.track.addWorkspace(
			"acme",
			OTHER_KEY,
			[
				{ key: "DEMO", name: "Guard" },
				{ key: "OPS", name: "Operations" },
			],
			["security", "agent"],
		);
		const replaced = await world.changeTrack(world.owner, form({ key: OTHER_KEY }));
		expect(replaced.status, replaced.text).toBe(200);
		expect((await world.trackRow())?.key_hint).toBe("ZZ99");

		const removed = await world.changeTrack(world.owner, { action: "remove" });
		expect(removed.status).toBe(200);
		expect(await world.trackRow()).toBeNull();
		expect((await world.trackPage()).body.integration).toBeNull();
	});

	it("lets members see it and not change it, and a stranger see nothing", async () => {
		await world.changeTrack(world.owner, form());
		const member = await world.addMember("max");
		const tried = await world.changeTrack(member, form({ team: "OPS" }));
		expect(tried.status).toBe(403);
		expect(tried.body.error).toMatch(/owner or admin/);
		const removing = await world.changeTrack(member, { action: "remove" });
		expect(removing.status).toBe(403);
		expect((await world.trackRow())?.team_key).toBe("DEMO");

		const admin = await world.addMember("ada", "admin");
		expect((await world.changeTrack(admin, form({ team: "OPS" }))).status).toBe(200);

		const stranger = await world.stranger("sam");
		const real = await world.changeTrack(stranger, form());
		const missing = await world.changeTrack(stranger, form(), "no-such-workspace");
		expect(real.status).toBe(404);
		expect(real.text).toBe(missing.text);
		expect((await world.trackPage(stranger)).status).toBe(404);
	});

	it("is refused when the server cannot keep secrets", async () => {
		const bare = await startWorld({ withoutKey: true });
		try {
			bare.upstream.track.addWorkspace("acme", KEY);
			const refused = await bare.changeTrack(bare.owner, form());
			expect(refused.status).toBe(400);
			expect(refused.body.error).toMatch(/SECRETS_KEY/);
			expect(bare.upstream.track.requests).toEqual([]);
		} finally {
			await bare.dispose();
		}
	});
});

describe("filing a finding in Track", () => {
	let world: World;
	beforeAll(async () => {
		world = await startFiling();
	});
	afterAll(async () => {
		await world?.dispose();
	});
	beforeEach(async () => {
		const track = world.upstream.track;
		track.reset();
		track.addWorkspace(
			"acme",
			KEY,
			[
				{ key: "DEMO", name: "Guard" },
				{ key: "OPS", name: "Operations" },
			],
			["security", "agent"],
		);
		await world.guard.db
			.prepare(
				"UPDATE finding SET track_state = NULL, track_issue_key = NULL, track_issue_url = NULL, track_filed_at = NULL, track_filed_by = NULL, fix_requested_at = NULL, resolved_at = NULL, dismissed_at = NULL",
			)
			.run();
		await world.guard.db.prepare("DELETE FROM track_integration").run();
		const saved = await world.changeTrack(world.owner, form({ fixLabel: "agent" }));
		expect(saved.status, saved.text).toBe(200);
		track.calls.length = 0;
		track.requests.length = 0;
	});

	it("makes one issue, with the finding's title, priority, label and a link back", async () => {
		const finding = await findingOf(world, "hsts_not_enabled");
		const filed = await world.changeFinding(world.owner, { action: "file", id: finding.id });
		expect(filed.status).toBe(200);
		expect(filed.body.track).toMatchObject({ state: "filed", key: "DEMO-1", fixRequested: false });

		const [call] = created(world);
		expect(created(world)).toHaveLength(1);
		expect(call?.args).toMatchObject({
			workspace: "acme",
			team: "DEMO",
			title: "HSTS is off (example.com)",
			priority: "medium",
			labels: ["security"],
		});
		const body = String(call?.args.description);
		expect(body).toContain("**Severity:** Moderate");
		expect(body).toContain("hsts_not_enabled");
		expect(body).toContain("example.com");
		expect(body).toContain("https://dash.cloudflare.com/");
		expect(body).toContain(`https://guard.test/${world.slug}/findings#finding-${finding.id}`);

		expect(await world.findingTrack(finding.id)).toMatchObject({
			track_state: "filed",
			track_issue_key: "DEMO-1",
			track_issue_url: "https://track.test/acme/issue/DEMO-1",
			track_filed_by: world.owner.userId,
		});
		// The page shows it as the real issue.
		const shown = await findingOf(world, "hsts_not_enabled");
		expect(shown.track).toEqual({
			state: "filed",
			key: "DEMO-1",
			url: "https://track.test/acme/issue/DEMO-1",
			fixRequested: false,
		});
	});

	it("files nothing twice, and says where it already is", async () => {
		const finding = await findingOf(world, "hsts_not_enabled");
		const first = await world.changeFinding(world.owner, { action: "file", id: finding.id });
		const again = await world.changeFinding(world.owner, { action: "file", id: finding.id });
		expect(again.status).toBe(200);
		expect(again.body.track).toEqual(first.body.track);
		expect(created(world)).toHaveLength(1);
	});

	it("maps each severity to a priority", async () => {
		const high = await findingOf(world, "GHSA-lodash");
		const low = await findingOf(world, "dmarc");
		await world.changeFinding(world.owner, { action: "file", id: high.id });
		await world.changeFinding(world.owner, { action: "file", id: low.id });
		expect(created(world).map((call) => call.args.priority)).toEqual(["high", "low"]);
	});

	it("adds the security label only when the team's workspace has one", async () => {
		world.upstream.track.addWorkspace("acme", KEY, [{ key: "DEMO", name: "Guard" }], ["bug"]);
		const finding = await findingOf(world, "dmarc");
		const filed = await world.changeFinding(world.owner, { action: "file", id: finding.id });
		expect(filed.status).toBe(200);
		expect(created(world)[0]?.args).not.toHaveProperty("labels");
	});

	it("writes what Guard knows about a dependency", async () => {
		const finding = await findingOf(world, "GHSA-lodash");
		await world.changeFinding(world.owner, { action: "file", id: finding.id });
		const call = created(world)[0];
		expect(call?.args.title).toBe(
			"Prototype pollution in lodash (lodash@4.17.20 in package-lock.json)",
		);
		const body = String(call?.args.description);
		expect(body).toContain("acme/shop");
		expect(body).toContain("lodash");
		expect(body).toContain("4.17.20");
		expect(body).toContain("4.17.21");
		expect(body).toContain("package-lock.json");
		expect(body).toContain("GHSA-lodash");
		expect(body).toContain("https://osv.dev/");
	});

	it("sends Track no token, hint or key beyond the Authorization header", async () => {
		for (const kind of ["hsts_not_enabled", "GHSA-lodash"]) {
			const finding = await findingOf(world, kind);
			const filed = await world.changeFinding(world.owner, {
				action: kind === "GHSA-lodash" ? "ask-fix" : "file",
				id: finding.id,
			});
			expect(filed.status, JSON.stringify(filed.body)).toBe(200);
		}
		expect(world.upstream.track.requests.length).toBeGreaterThan(3);
		for (const { body, headers } of world.upstream.track.requests) {
			for (const secret of [CF_TOKEN, GH_TOKEN, KEY, world.key, ...HINTS]) {
				expect(body).not.toContain(secret);
			}
			// Nothing of the person's own request goes along: not their cookie, not their origin.
			expect(JSON.stringify(headers)).not.toContain("cookie");
			expect(headers.authorization).toBe(`Bearer ${KEY}`);
		}
	});

	it("makes one issue of two clicks at once, from two members", async () => {
		const finding = await findingOf(world, "hsts_not_enabled");
		const member = await world.addMember(`nia${Date.now()}`);
		let release = () => {};
		world.upstream.track.behaviour.holdCreate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = world.changeFinding(world.owner, { action: "file", id: finding.id });
		const second = world.changeFinding(member, { action: "file", id: finding.id });
		await until(() => created(world).length > 0);
		// The other click arrives while the first is still waiting for Track.
		await wait(300);
		release();
		const answers = await Promise.all([first, second]);
		expect(created(world)).toHaveLength(1);
		expect(world.upstream.track.issues).toHaveLength(1);
		expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
		const refused = answers.find((answer) => answer.status === 409);
		expect(refused?.body.error).toMatch(/filing this finding right now/);
		expect((await world.findingTrack(finding.id))?.track_state).toBe("filed");
	});

	it("makes one issue of a burst of clicks, however they interleave", async () => {
		const finding = await findingOf(world, "hsts_not_enabled");
		const members = await Promise.all(
			[1, 2, 3].map((n) => world.addMember(`burst${n}${Date.now()}`)),
		);
		let release = () => {};
		world.upstream.track.behaviour.holdCreate = new Promise<void>((resolve) => {
			release = resolve;
		});
		// All of them are sent before any is answered: each reads the finding as not filed yet.
		const clicks = [world.owner, world.owner, ...members, ...members].map((person) =>
			world.changeFinding(person, { action: "file", id: finding.id }),
		);
		await wait(500);
		release();
		const answers = await Promise.all(clicks);
		expect(created(world)).toHaveLength(1);
		expect(world.upstream.track.issues).toHaveLength(1);
		expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
		expect(answers.filter((answer) => answer.status === 409)).toHaveLength(clicks.length - 1);
	});

	it("lets go of its claim when Track fails, so the next click can file", async () => {
		const finding = await findingOf(world, "hsts_not_enabled");
		world.upstream.track.behaviour.failCreates = 1;
		const failed = await world.changeFinding(world.owner, { action: "file", id: finding.id });
		expect(failed.status).toBe(502);
		expect(failed.body.error).toMatch(/could not be reached.*nothing was filed/);
		expect(await world.findingTrack(finding.id)).toMatchObject({
			track_state: null,
			track_issue_key: null,
			track_filed_by: null,
		});
		const retried = await world.changeFinding(world.owner, { action: "file", id: finding.id });
		expect(retried.status).toBe(200);
		expect(world.upstream.track.issues).toHaveLength(1);
	});

	it("lets go of its claim when the key was revoked, and says so", async () => {
		const finding = await findingOf(world, "hsts_not_enabled");
		world.upstream.track.revoke(KEY);
		const failed = await world.changeFinding(world.owner, { action: "file", id: finding.id });
		expect(failed.status).toBe(502);
		expect(failed.body.error).toMatch(/revoked/);
		expect((await world.findingTrack(finding.id))?.track_state).toBeNull();
		expect((await world.trackRow())?.last_check_outcome).toBe("unauthorized");
	});

	it("takes a claim nobody finished, after its lease", async () => {
		const finding = await findingOf(world, "hsts_not_enabled");
		await world.guard.db
			.prepare("UPDATE finding SET track_state = 'filing', track_filed_at = ?2 WHERE id = ?1")
			.bind(finding.id, Date.now() - 10 * 60 * 1000)
			.run();
		const filed = await world.changeFinding(world.owner, { action: "file", id: finding.id });
		expect(filed.status, JSON.stringify(filed.body)).toBe(200);
		expect(created(world)).toHaveLength(1);

		// A fresh claim is respected.
		const other = await findingOf(world, "dmarc");
		await world.guard.db
			.prepare("UPDATE finding SET track_state = 'filing', track_filed_at = ?2 WHERE id = ?1")
			.bind(other.id, Date.now())
			.run();
		const refused = await world.changeFinding(world.owner, { action: "file", id: other.id });
		expect(refused.status).toBe(409);
		expect(created(world)).toHaveLength(1);
	});

	it("stores a proposal as one, shows it, and does not file again", async () => {
		world.upstream.track.behaviour.propose = true;
		const finding = await findingOf(world, "hsts_not_enabled");
		const filed = await world.changeFinding(world.owner, { action: "file", id: finding.id });
		expect(filed.status).toBe(200);
		expect(filed.body.track).toMatchObject({ state: "proposed", key: "DEMO-1" });
		expect((await world.findingTrack(finding.id))?.track_state).toBe("proposed");
		expect((await findingOf(world, "hsts_not_enabled")).track?.state).toBe("proposed");

		const again = await world.changeFinding(world.owner, { action: "file", id: finding.id });
		expect(again.status).toBe(200);
		expect(again.body.track?.state).toBe("proposed");
		expect(created(world)).toHaveLength(1);
		// Nor can Agents be asked about an issue that waits for a person.
		const dependency = await findingOf(world, "GHSA-lodash");
		await world.changeFinding(world.owner, { action: "file", id: dependency.id });
		const asked = await world.changeFinding(world.owner, { action: "ask-fix", id: dependency.id });
		expect(asked.status).toBe(409);
		expect(asked.body.error).toMatch(/waits for a person/);
		expect(updated(world)).toHaveLength(0);
	});

	it("works with a Track that answers in JSON rather than an event stream", async () => {
		world.upstream.track.behaviour.json = true;
		const finding = await findingOf(world, "dmarc");
		const filed = await world.changeFinding(world.owner, { action: "file", id: finding.id });
		expect(filed.status, JSON.stringify(filed.body)).toBe(200);
	});

	it("does not file what is resolved, dismissed or somebody else's", async () => {
		const finding = await findingOf(world, "dmarc");
		await world.guard.db
			.prepare("UPDATE finding SET resolved_at = ?2 WHERE id = ?1")
			.bind(finding.id, Date.now())
			.run();
		const resolved = await world.changeFinding(world.owner, { action: "file", id: finding.id });
		expect(resolved.status).toBe(409);
		expect(created(world)).toHaveLength(0);

		const missing = await world.changeFinding(world.owner, {
			action: "file",
			id: "no-such-finding",
		});
		expect(missing.status).toBe(404);
	});

	it("keeps the links when the integration is removed", async () => {
		const finding = await findingOf(world, "hsts_not_enabled");
		await world.changeFinding(world.owner, { action: "file", id: finding.id });
		await world.changeTrack(world.owner, { action: "remove" });
		const page = (await world.findings()).body;
		expect(page.track).toEqual({ configured: false, canAskFix: false });
		expect(page.findings.find((one) => one.id === finding.id)?.track).toMatchObject({
			state: "filed",
			key: "DEMO-1",
		});
		// Nothing can be filed without it.
		const other = await findingOf(world, "dmarc");
		const refused = await world.changeFinding(world.owner, { action: "file", id: other.id });
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/isn't connected/);
	});

	it("lets members file but not read the key, and a stranger do nothing", async () => {
		const member = await world.addMember(`mo${Date.now()}`);
		const finding = await findingOf(world, "hsts_not_enabled", member);
		const filed = await world.changeFinding(member, { action: "file", id: finding.id });
		expect(filed.status, JSON.stringify(filed.body)).toBe(200);
		expect((await world.findingTrack(finding.id))?.track_filed_by).toBe(member.userId);
		// Dismissing stays for admins.
		const dismissed = await world.changeFinding(member, {
			action: "dismiss",
			id: finding.id,
			reason: "no",
		});
		expect(dismissed.status).toBe(403);

		const stranger = await world.stranger(`sue${Date.now()}`);
		const other = await findingOf(world, "dmarc");
		const calls = world.upstream.track.calls.length;
		const real = await world.changeFinding(stranger, { action: "file", id: other.id });
		const missing = await world.changeFinding(
			stranger,
			{ action: "file", id: other.id },
			"no-such-workspace",
		);
		expect(real.status).toBe(404);
		expect(real.body).toEqual(missing.body);
		expect(world.upstream.track.calls).toHaveLength(calls);
	});
});

describe("asking Agents for a fix, through a label", () => {
	let world: World;
	beforeAll(async () => {
		world = await startFiling();
	});
	afterAll(async () => {
		await world?.dispose();
	});
	beforeEach(async () => {
		const track = world.upstream.track;
		track.reset();
		await world.guard.db
			.prepare(
				"UPDATE finding SET track_state = NULL, track_issue_key = NULL, track_issue_url = NULL, track_filed_at = NULL, track_filed_by = NULL, fix_requested_at = NULL",
			)
			.run();
		await world.guard.db.prepare("DELETE FROM track_integration").run();
		const saved = await world.changeTrack(world.owner, form({ fixLabel: "agent" }));
		expect(saved.status, saved.text).toBe(200);
		track.calls.length = 0;
	});

	it("is offered only when a label is set", async () => {
		expect((await world.findings()).body.track).toEqual({ configured: true, canAskFix: true });
		await world.changeTrack(world.owner, form({ fixLabel: "" }));
		world.upstream.track.calls.length = 0;
		expect((await world.findings()).body.track).toEqual({ configured: true, canAskFix: false });
		const finding = await findingOf(world, "GHSA-lodash");
		const refused = await world.changeFinding(world.owner, { action: "ask-fix", id: finding.id });
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/No label is set/);
		expect(created(world)).toHaveLength(0);
		expect(updated(world)).toHaveLength(0);
	});

	it("is only for a dependency with a version that fixes it", async () => {
		const insight = await findingOf(world, "hsts_not_enabled");
		const refused = await world.changeFinding(world.owner, { action: "ask-fix", id: insight.id });
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/dependency/);

		const dependency = await findingOf(world, "GHSA-lodash");
		await world.guard.db
			.prepare("UPDATE finding SET fixed_version = NULL WHERE id = ?1")
			.bind(dependency.id)
			.run();
		const noFix = await world.changeFinding(world.owner, { action: "ask-fix", id: dependency.id });
		expect(noFix.status).toBe(409);
		expect(created(world)).toHaveLength(0);
		await world.guard.db
			.prepare("UPDATE finding SET fixed_version = '4.17.21' WHERE id = ?1")
			.bind(dependency.id)
			.run();
	});

	it("files the issue with the label when it was not filed yet", async () => {
		const finding = await findingOf(world, "GHSA-lodash");
		const asked = await world.changeFinding(world.owner, { action: "ask-fix", id: finding.id });
		expect(asked.status, JSON.stringify(asked.body)).toBe(200);
		expect(asked.body.track).toMatchObject({ state: "filed", key: "DEMO-1", fixRequested: true });
		expect(created(world)).toHaveLength(1);
		expect(created(world)[0]?.args.labels).toEqual(["security", "agent"]);
		expect(updated(world)).toHaveLength(0);
		const row = await world.findingTrack(finding.id);
		expect(row?.fix_requested_at).not.toBeNull();
		expect((await findingOf(world, "GHSA-lodash")).track?.fixRequested).toBe(true);
	});

	it("adds the label to an issue that was already filed, once", async () => {
		const finding = await findingOf(world, "GHSA-lodash");
		await world.changeFinding(world.owner, { action: "file", id: finding.id });
		expect(created(world)[0]?.args.labels).toEqual(["security"]);

		const asked = await world.changeFinding(world.owner, { action: "ask-fix", id: finding.id });
		expect(asked.status, JSON.stringify(asked.body)).toBe(200);
		expect(asked.body.track).toMatchObject({ key: "DEMO-1", fixRequested: true });
		expect(updated(world).map((call) => call.args)).toEqual([
			{ workspace: "acme", key: "DEMO-1", add_labels: ["agent"] },
		]);
		expect(created(world)).toHaveLength(1);
		expect(world.upstream.track.issues[0]?.labels).toEqual(["security", "agent"]);

		// A second ask changes nothing in Track: its trigger would fire only on the label being added.
		const again = await world.changeFinding(world.owner, { action: "ask-fix", id: finding.id });
		expect(again.status).toBe(200);
		expect(updated(world)).toHaveLength(1);
	});

	it("says when Track keeps the label as a proposal", async () => {
		const finding = await findingOf(world, "GHSA-lodash");
		await world.changeFinding(world.owner, { action: "file", id: finding.id });
		world.upstream.track.behaviour.propose = true;
		const asked = await world.changeFinding(world.owner, { action: "ask-fix", id: finding.id });
		expect(asked.status).toBe(200);
		expect(asked.body.waiting).toBe(true);
		expect(world.upstream.track.issues[0]?.labels).toEqual(["security"]);
	});

	it("says when the label has gone from Track, and files nothing", async () => {
		world.upstream.track.addWorkspace("acme", KEY, [{ key: "DEMO", name: "Guard" }], ["security"]);
		const finding = await findingOf(world, "GHSA-lodash");
		const asked = await world.changeFinding(world.owner, { action: "ask-fix", id: finding.id });
		expect(asked.status).toBe(409);
		expect(asked.body.error).toMatch(/label "agent" is not in Track any more/);
		expect(created(world)).toHaveLength(0);
		expect((await world.findingTrack(finding.id))?.track_state).toBeNull();
	});
});

describe("how often findings can be filed", () => {
	let world: World;
	beforeAll(async () => {
		world = await startFiling();
	});
	afterAll(async () => {
		await world?.dispose();
	});

	it("holds a workspace to about 30 a minute", async () => {
		const [connection] = (await world.connections()).body.connections;
		await world.changeTrack(world.owner, form());
		const source = await world.guard.db
			.prepare("SELECT organization_id FROM finding LIMIT 1")
			.first<{ organization_id: string }>();
		const ids: string[] = [];
		for (let n = 0; n < 45; n++) {
			const id = `bulk-${n}`;
			ids.push(id);
			await world.guard.db
				.prepare(
					`INSERT INTO finding (id, organization_id, connection_id, fingerprint, source, severity, kind, subject, title, url, first_seen_at, last_seen_at, raised_at)
					VALUES (?1, ?2, ?3, ?1, 'cloudflare', 'low', 'dmarc', 'x.example', 'DMARC', 'https://dash.cloudflare.com/', 1, 1, 1)`,
				)
				.bind(id, source?.organization_id, connection?.id)
				.run();
		}
		// All at once, so that the bucket has no time to refill while they are counted.
		const statuses = (
			await Promise.all(ids.map((id) => world.changeFinding(world.owner, { action: "file", id })))
		).map((answer) => answer.status);
		const allowed = statuses.filter((status) => status === 200).length;
		const limited = statuses.filter((status) => status === 429).length;
		expect(allowed + limited).toBe(ids.length);
		// 30 in a minute, and a token or two refilled while the requests were in flight.
		expect(allowed).toBeGreaterThanOrEqual(30);
		expect(allowed).toBeLessThanOrEqual(33);
		expect(limited).toBeGreaterThanOrEqual(ids.length - 33);
		expect(created(world)).toHaveLength(allowed);
	});
});

describe("a changed SECRETS_KEY", () => {
	it("has the daily run seal the Track key again, and filing keeps working", async () => {
		const OLD = Buffer.alloc(32, 1).toString("base64");
		const NEW = Buffer.alloc(32, 2).toString("base64");
		// The first copy has only the old key, as the deployment before the change; the second has the
		// new one and keeps the old as the previous, as after it.
		const world = await startWorld({
			isolates: 2,
			settings: { SECRETS_KEY: OLD },
			isolateSettings: [{}, { SECRETS_KEY: NEW, SECRETS_KEY_PREVIOUS: OLD }],
		});
		try {
			world.upstream.track.addWorkspace("acme", KEY);
			expect((await world.changeTrack(world.owner, form())).status).toBe(200);
			const connectionId = "conn-1";
			await world.guard.db
				.prepare(
					"INSERT INTO connection (id, organization_id, kind, target, name, token_sealed, token_hint, added_by, added_at, next_scan_at) VALUES (?1, ?2, 'cloudflare', ?3, ?3, ?4, 'abcd', 'x', ?5, ?6)",
				)
				.bind(
					connectionId,
					world.workspaceId,
					"a".repeat(32),
					await sealToken(OLD, world.workspaceId, connectionId, "some-token-some-token-1"),
					Date.now(),
					Date.now() + 1e9,
				)
				.run();
			await world.guard.db
				.prepare(
					"INSERT INTO finding (id, organization_id, connection_id, fingerprint, source, severity, kind, subject, title, url, first_seen_at, last_seen_at, raised_at) VALUES ('f1', ?1, ?2, 'f1', 'cloudflare', 'low', 'dmarc', 'x.example', 'DMARC', 'https://dash.cloudflare.com/', 1, 1, 1)",
				)
				.bind(world.workspaceId, connectionId)
				.run();
			const before = (await world.trackRow())?.key_sealed ?? "";
			const newId = (await sealToken(NEW, world.workspaceId, connectionId, "x")).split(".")[1];
			expect(before.split(".")[1]).not.toBe(newId);

			await world.guard.runScheduled(1);

			const after = (await world.trackRow())?.key_sealed ?? "";
			expect(after.split(".")[1]).toBe(newId);
			expect(after).not.toContain(KEY);
			expect(
				world.guard.logs.some(
					(log) =>
						log.message ===
						`secrets: primary=${newId} previous=${before.split(".")[1]} resealed=2 unopened=0 left=0 settled=false`,
				),
			).toBe(true);
			// The new key opens it: filing from the second copy works.
			const filed = await world.guard.fetchIn(1, `https://guard.test/api/findings/${world.slug}`, {
				method: "POST",
				headers: world.owner.headers,
				body: JSON.stringify({ action: "file", id: "f1" }),
			});
			expect(filed.status, await filed.text()).toBe(200);
			expect(created(world)).toHaveLength(1);
		} finally {
			await world.dispose();
		}
	});
});
