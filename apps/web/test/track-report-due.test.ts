import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOURLY, startWorld, type World } from "./connections-world";
import { ACCOUNT_ID } from "./upstreams";

const address = "https://track.test";
const token = "cf-test-token-abcdefghijklmn1234";
const sourceKey = (index: number) => `gws_${String(index).padStart(43, "A")}`;

describe("hourly Track reporting", () => {
	let world: World;
	const save = (connectionId: string, index = 0) =>
		world.changeTrack(world.owner, {
			action: "source",
			connectionId,
			address,
			key: sourceKey(index),
		});
	const run = (at: number) => world.guard.runScheduled(0, HOURLY, new Date(at));
	const reports = () =>
		world.guard.logs
			.filter(({ message }) => message.startsWith("reports: "))
			.map(({ message }) => message);
	const sourceTimes = (id: string) =>
		world.guard.db
			.prepare("SELECT answered_at, retry_at FROM track_source WHERE connection_id=?")
			.bind(id)
			.first<{ answered_at: number; retry_at: number | null }>();

	async function connect(count: number) {
		world.upstream.addAccount(
			ACCOUNT_ID,
			token,
			Array.from({ length: count }, (_, index) => ({
				id: String(index),
				issue_class: "dmarc",
				subject: `zone-${index}.test`,
				severity: "Moderate",
			})),
		);
		return (await world.connectCloudflare(ACCOUNT_ID, token)).connection.id;
	}

	// Set up many sources without spending the workspace's Cloudflare connection-check allowance.
	// Save each key through the API before adding a pending finding so setup sends no events.
	async function addSources(template: string, count: number) {
		const db = world.guard.db;
		const ids = Array.from(
			{ length: count },
			(_, index) => `source-${String(index).padStart(2, "0")}`,
		);
		for (const [index, id] of ids.entries()) {
			await db
				.prepare(`INSERT INTO connection (id, organization_id, kind, target, name, token_sealed, token_hint, added_by, added_at, next_scan_at)
					SELECT ?, organization_id, kind, ?, ?, token_sealed, token_hint, added_by, added_at, next_scan_at FROM connection WHERE id=?`)
				.bind(id, (index + 1).toString(16).padStart(32, "0"), id, template)
				.run();
			expect((await save(id, index + 1)).status).toBe(200);
			await db
				.prepare(`INSERT INTO finding (id, organization_id, connection_id, fingerprint, source, severity, kind, subject, title, url, first_seen_at, last_seen_at)
					WITH copies AS (
						SELECT *, ?1 || CASE WHEN count(*) OVER () > 1 THEN '/' || fingerprint ELSE '' END AS copy_key
						FROM finding WHERE connection_id=?2
					)
					SELECT copy_key, organization_id, ?1, copy_key, source, severity, kind, subject, title, url, first_seen_at, last_seen_at FROM copies`)
				.bind(id, template)
				.run();
		}
		return ids;
	}

	beforeEach(async () => {
		world = await startWorld({ scheduledClock: true });
	});
	afterEach(async () => {
		await world?.dispose();
	});

	it("drains 129 findings over two hourly runs after saving the source key", async () => {
		const id = await connect(129);
		const events = world.upstream.track.events;
		expect((await save(id)).status).toBe(200);
		expect(events).toHaveLength(50);
		const at = Date.now();
		await run(at + 3_600_000);
		expect(events).toHaveLength(100);
		await run(at + 7_200_000);
		expect(events).toHaveLength(129);
		expect(new Set(events.map((event) => event.key))).toEqual(
			new Set((await world.findingRows(id)).map((row) => row.fingerprint)),
		);
		expect(reports()).toEqual([
			'reports: {"connections":1,"sent":50}',
			'reports: {"connections":1,"sent":29}',
		]);
	});

	it("retries a 503 on the hourly run once Retry-After is due", async () => {
		const id = await connect(1);
		const track = world.upstream.track;
		track.behaviour.eventStatus = 503;
		track.behaviour.retryAfter = "60";
		expect((await save(id)).status).toBe(200);
		expect(track.events).toHaveLength(1);
		const times = await sourceTimes(id);
		if (!times) throw new Error("Missing source");
		expect(times.retry_at).toBe(times.answered_at + 60_000);
		track.behaviour.eventStatus = 200;
		await run(times.answered_at + 59_000);
		expect(track.events).toHaveLength(1);
		expect(reports()).toEqual([]);
		await run(times.answered_at + 61_000);
		expect(track.events).toHaveLength(2);
		expect(track.events[1]?.key).toBe(track.events[0]?.key);
		expect(track.events[1]?.sentAt).toBeDefined();
		expect(Date.parse(track.events[1]?.sentAt ?? "")).toBeGreaterThan(
			Date.parse(track.events[0]?.sentAt ?? ""),
		);
		expect(reports()).toEqual(['reports: {"connections":1,"sent":1}']);
	});

	it("skips stopped, leased and settled sources and continues after a reporter throws", async () => {
		const template = await connect(1);
		const [stopped, leased, settled, broken, ready] = await addSources(template, 5);
		if (!stopped || !leased || !settled || !broken || !ready) throw new Error("Missing source");
		const at = Date.now();
		const db = world.guard.db;
		await db.batch([
			db.prepare("UPDATE track_source SET stopped=1 WHERE connection_id=?").bind(stopped),
			db
				.prepare("UPDATE track_source SET lease='other', lease_until=? WHERE connection_id=?")
				.bind(at + 60_000, leased),
			db
				.prepare(
					"UPDATE finding SET source_state='open', source_severity=severity WHERE connection_id=?",
				)
				.bind(settled),
			db.prepare("UPDATE track_source SET answered_at=? WHERE connection_id=?").bind(at, ready),
		]);
		await db
			.prepare(`CREATE TRIGGER refuse_report BEFORE UPDATE OF lease ON track_source
				WHEN OLD.connection_id = 'source-03'
				BEGIN SELECT RAISE(ABORT, 'fixture refused the report lease'); END`)
			.run();

		await run(at);
		expect(world.upstream.track.events.map((event) => event.key)).toEqual([ready]);
		expect(reports()).toEqual(['reports: {"connections":2,"sent":1}']);
		expect(world.guard.logs.some(({ message }) => message.startsWith("d1: a query failed"))).toBe(
			true,
		);
	});

	it("reports at most 20 connections, never-answered and oldest first", async () => {
		const template = await connect(1);
		const ids = await addSources(template, 25);
		const at = Date.now();
		const db = world.guard.db;
		await db.batch(
			ids.map((id, index) =>
				db
					.prepare("UPDATE track_source SET answered_at=? WHERE connection_id=?")
					.bind(index === 0 ? null : at - index * 1000, id),
			),
		);
		const expected = [...ids.slice(0, 1), ...ids.slice(1).reverse()];
		const delivered = () => world.upstream.track.events.map((event) => event.key);
		await run(at);
		expect(delivered()).toEqual(expected.slice(0, 20));
		await run(at + 3_600_000);
		expect(delivered()).toEqual(expected);
		expect(reports()).toEqual([
			'reports: {"connections":20,"sent":20}',
			'reports: {"connections":5,"sent":5}',
		]);
	});

	it("sends 150 of 200 pending events and leaves the fourth connection for the next hour", async () => {
		const template = await connect(50);
		const ids = await addSources(template, 4);
		const events = world.upstream.track.events;
		const at = Date.now();
		const deliveries = () => events.map((event) => event.key.split("/")[0]);

		await run(at);
		expect(events).toHaveLength(150);
		expect(deliveries()).toEqual(ids.slice(0, 3).flatMap((id) => Array(50).fill(id)));
		await run(at + 3_600_000);
		expect(events).toHaveLength(200);
		expect(deliveries().slice(150)).toEqual(Array(50).fill(ids[3]));
		expect(new Set(events.map((event) => event.key)).size).toBe(200);
		expect(reports()).toEqual([
			'reports: {"connections":3,"sent":150}',
			'reports: {"connections":1,"sent":50}',
		]);
	});

	it("limits a connection to the remaining events when the hourly budget is partly spent", async () => {
		const template = await connect(50);
		const [first, , , fourth] = await addSources(template, 4);
		if (!first || !fourth) throw new Error("Missing source");
		await world.guard.db
			.prepare(`UPDATE finding SET source_state='open', source_severity=severity
				WHERE id IN (SELECT id FROM finding WHERE connection_id=? ORDER BY id LIMIT 10)`)
			.bind(first)
			.run();
		const events = world.upstream.track.events;
		const fromFourth = () => events.filter((event) => event.key.startsWith(`${fourth}/`));
		const at = Date.now();

		await run(at);
		expect(events).toHaveLength(150);
		expect(fromFourth()).toHaveLength(10);
		await run(at + 3_600_000);
		expect(events).toHaveLength(190);
		expect(fromFourth()).toHaveLength(50);
		expect(reports()).toEqual([
			'reports: {"connections":4,"sent":150}',
			'reports: {"connections":1,"sent":40}',
		]);
	});
});
