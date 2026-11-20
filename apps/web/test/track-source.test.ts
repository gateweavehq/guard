import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { origin, startWorld, type World } from "./connections-world";
import { ACCOUNT_ID, npmLock } from "./upstreams";

const key = `gws_${"A".repeat(43)}`;
const agent = `gwt_${"B".repeat(43)}`;
const address = "https://track.test";
const token = "cf-test-token-abcdefghijklmn1234";
const insight = { id: "one", issue_class: "dmarc", subject: "example.test", severity: "Moderate" };

describe("reporting findings to a Track source", () => {
	let world: World;
	let id: string;
	let finding: string;
	const save = (value = key) =>
		world.changeTrack(world.owner, { action: "source", connectionId: id, address, key: value });
	const dismiss = () =>
		world.changeFinding(world.owner, { action: "dismiss", id: finding, reason: "accepted" });
	const restore = () => world.changeFinding(world.owner, { action: "undismiss", id: finding });
	beforeEach(async () => {
		world = await startWorld();
		world.upstream.addAccount(ACCOUNT_ID, token, [{ ...insight }]);
		id = (await world.connectCloudflare(ACCOUNT_ID, token)).connection.id;
		const [row] = await world.findingRows(id);
		if (!row) throw Error("missing finding");
		finding = row.id;
	});
	afterEach(async () => {
		await world?.dispose();
	});
	it("switches atomically, keeps MCP links, seals the source key and keeps manual filing disabled", async () => {
		const gh = "github_pat_ghp_abcdefghijklmnopqrGH7X";
		world.upstream.addRepository("acme/shop", gh, 42, { "package-lock.json": npmLock({}) });
		const repo = (await world.connectGithub("acme/shop", gh)).connection;
		world.upstream.track.addWorkspace(
			"acme",
			agent,
			[{ key: "OPS", name: "Operations" }],
			["agent"],
		);
		const legacy = {
			action: "save",
			address,
			workspace: "acme",
			team: "OPS",
			key: agent,
			fixLabel: "agent",
		} as const;
		expect((await world.changeTrack(world.owner, legacy)).status).toBe(200);
		expect((await world.changeFinding(world.owner, { action: "file", id: finding })).status).toBe(
			200,
		);
		const original = await world.findingTrack(finding);
		await world.guard.db
			.prepare(
				"CREATE TRIGGER refuse_source BEFORE INSERT ON track_source BEGIN SELECT RAISE(ABORT,'refused'); END",
			)
			.run();
		expect(
			(
				await world.guard.fetch(`${origin}/api/track/${world.slug}`, {
					method: "POST",
					headers: world.owner.headers,
					body: JSON.stringify({ action: "source", connectionId: id, key }),
				})
			).status,
		).toBe(500);
		expect((await world.trackRow())?.key_sealed).toMatch(/^v2\./);
		await world.guard.db.prepare("DROP TRIGGER refuse_source").run();
		expect((await save()).status).toBe(200);
		expect(await world.trackRow()).toMatchObject({
			address,
			key_sealed: "",
			key_hint: "",
			fix_label: null,
		});
		expect(await world.findingTrack(finding)).toEqual(original);
		expect(world.upstream.track.events).toEqual([]);
		expect((await world.changeTrack(world.owner, legacy)).status).toBe(409);
		const stored = await world.guard.db
			.prepare("SELECT key_sealed,key_hint FROM track_source")
			.first();
		expect(stored).toMatchObject({ key_sealed: expect.stringMatching(/^v2\./), key_hint: "AAAA" });
		expect(JSON.stringify(stored)).not.toContain(key);
		expect(
			(await world.changeTrack(world.owner, { action: "source", connectionId: repo.id, key }))
				.status,
		).toBe(409);
		expect(
			(
				await world.changeTrack(world.owner, {
					action: "source",
					connectionId: repo.id,
					key: `gws_${"C".repeat(43)}`,
				})
			).status,
		).toBe(200);
		const page = await world.page(`/${world.slug}/settings/track`);
		expect(page.text).toContain(origin);
		expect(page.text.match(/To have an agent work on these issues/g)).toHaveLength(1);
		expect(page.text).toContain("Track defaults to high");
		expect(page.text).not.toContain(key);
		const member = await world.addMember("reader");
		expect((await world.trackPage(member)).body.sources).toEqual([]);
		expect(
			(await world.changeTrack(member, { action: "source", connectionId: id, key })).status,
		).toBe(403);
		expect((await world.findings()).body.track).toMatchObject({
			configured: false,
			canAskFix: false,
		});
	});
	it("reports scan changes, remembers null and real links, and opens the issue from Findings", async () => {
		const track = world.upstream.track;
		track.behaviour.noIssue = true;
		expect((await save()).status).toBe(200);
		const [row] = await world.findingRows(id);
		expect(track.events).toEqual([
			expect.objectContaining({
				key: row?.fingerprint,
				severity: "medium",
				state: "open",
				sentAt: new Date(row?.last_seen_at ?? 0).toISOString(),
				url: `${origin}/${world.slug}/findings#finding-${finding}`,
			}),
		]);
		expect(track.requests.at(-1)?.headers.authorization).toBe(`Bearer ${key}`);
		expect((await world.findingTrack(finding))?.track_issue_url).toBeNull();
		await world.scanDue([id]);
		expect(track.events).toHaveLength(1);
		track.behaviour.noIssue = false;
		world.upstream.addAccount(ACCOUNT_ID, token, [{ ...insight, severity: "Critical" }]);
		await world.scanDue([id]);
		expect(track.events.at(-1)).toMatchObject({ severity: "critical" });
		const html = (await world.page(`/${world.slug}/findings`)).text;
		expect(html).toContain("Open SRC-1 in Track");
		expect(html).toContain('href="https://track.test/team/issue/SRC-1"');
		expect((await world.changeFinding(world.owner, { action: "file", id: finding })).status).toBe(
			409,
		);
		world.upstream.addAccount(ACCOUNT_ID, token, []);
		await world.scanDue([id]);
		expect(track.events.map((e) => e.state)).toEqual(["open", "open", "cleared"]);
	});
	it("restores open after Track applied a dismissal whose acknowledgement was lost", async () => {
		await save();
		const track = world.upstream.track;
		track.behaviour.loseReply = true;
		await dismiss();
		expect([...track.signals.values()]).toEqual(["dismissed"]);
		track.behaviour.loseReply = false;
		await restore();
		expect(track.events.map((e) => e.state)).toEqual(["open", "dismissed", "open"]);
		expect(track.events[2]?.sentAt).toBeDefined();
		expect(Date.parse(track.events[2]?.sentAt ?? "")).toBeGreaterThan(
			Date.parse(track.events[1]?.sentAt ?? ""),
		);
	});
	it("holds changed findings across a 429 and suppresses a repeated 400", async () => {
		const track = world.upstream.track;
		track.behaviour.eventStatus = 429;
		await save();
		await world.scanDue([id]);
		expect(track.events).toHaveLength(1);
		const status = (await world.trackPage()).body.sources[0];
		expect(status).toMatchObject({ lastAnswer: "429", answeredAt: expect.any(Number) });
		expect(
			await world.guard.db.prepare("SELECT retry_at FROM track_source").first("retry_at"),
		).toBe((status?.answeredAt ?? 0) + 180000);
		await world.guard.db.prepare("UPDATE track_source SET retry_at=0").run();
		track.behaviour.eventStatus = 400;
		await world.scanDue([id]);
		await world.scanDue([id]);
		expect(track.events).toHaveLength(2);
		track.behaviour.eventStatus = 200;
		world.upstream.addAccount(ACCOUNT_ID, token, [{ ...insight, severity: "Critical" }]);
		await world.scanDue([id]);
		expect(track.events).toHaveLength(3);
	});
	it("stops after seven days of 404 and resumes with a replacement key", async () => {
		const track = world.upstream.track;
		track.behaviour.eventStatus = 404;
		await save();
		await world.scanDue([id]);
		expect(track.events).toHaveLength(2);
		await world.guard.db
			.prepare("UPDATE track_source SET first_missing_at=?")
			.bind(Date.now() - 7 * 86400000)
			.run();
		await world.scanDue([id]);
		await world.scanDue([id]);
		expect(track.events).toHaveLength(3);
		expect((await world.page(`/${world.slug}/settings/track`)).text).toContain(
			"Track has not known this key for seven days",
		);
		expect((await save()).status).toBe(409);
		expect(track.events).toHaveLength(3);
		track.behaviour.eventStatus = 200;
		await save(`gws_${"D".repeat(43)}`);
		expect(track.events).toHaveLength(4);
		expect((await world.trackPage()).body.sources[0]).toMatchObject({
			lastAnswer: "200",
			stopped: false,
		});
	});
	it("refuses invalid keys and origins before saving, and records a locally oversized event once", async () => {
		for (const bad of [agent, `${key}x`, key.slice(1), ` ${key}`])
			expect((await save(bad)).status).toBe(400);
		for (const bad of ["http://track.test", "https://track.test/path", "https://a:b@track.test"]) {
			expect(
				(
					await world.changeTrack(world.owner, {
						action: "source",
						key,
						connectionId: id,
						address: bad,
					})
				).status,
			).toBe(400);
		}
		expect(
			(
				await world.changeTrack(world.owner, {
					action: "source",
					key,
					connectionId: "missing",
					address,
				})
			).status,
		).toBe(404);
		expect(await world.trackRow()).toBeNull();
		await world.guard.db
			.prepare("UPDATE finding SET fingerprint=? WHERE id=?")
			.bind("x".repeat(16384), finding)
			.run();
		await save();
		expect(world.upstream.track.events).toHaveLength(0);
		expect((await world.trackPage()).body.sources[0]?.lastAnswer).toBe("400");
		const log = () =>
			world.guard.logs.filter((line) => line.message.includes("Track refused finding"));
		expect(log()).toHaveLength(1);
		expect(log()[0]?.message).toContain(finding);
		expect(log()[0]?.message).not.toContain("xxxxxxxxxxxx");
		await world.scanDue([id]);
		expect(log()).toHaveLength(1);
	});

	it("starts with open findings only and gives dismissal precedence over resolution", async () => {
		await dismiss();
		await save();
		await world.scanDue([id]);
		expect(world.upstream.track.events).toEqual([]);
		await restore();
		await dismiss();
		world.upstream.addAccount(ACCOUNT_ID, token, []);
		await world.scanDue([id]);
		await restore();
		expect(world.upstream.track.events.map((e) => e.state)).toEqual([
			"open",
			"dismissed",
			"cleared",
		]);
	});
	it("spends at most sixty calls and resumes the remaining lower severity findings", async () => {
		world.upstream.addAccount(
			ACCOUNT_ID,
			token,
			Array.from({ length: 62 }, (_, i) => ({
				...insight,
				id: String(i),
				subject: `zone-${i}`,
				severity: i === 61 ? "Critical" : "Low",
			})),
		);
		await world.scanDue([id]);
		await save();
		const events = world.upstream.track.events;
		expect(events).toHaveLength(60);
		expect(events[0]?.severity).toBe("critical");
		await world.scanDue([id]);
		expect(events).toHaveLength(60);
		await world.guard.db.prepare("UPDATE track_source SET calls='[]'").run();
		await world.scanDue([id]);
		expect(new Set(events.map((e) => e.key)).size).toBe(62);
	});
});
