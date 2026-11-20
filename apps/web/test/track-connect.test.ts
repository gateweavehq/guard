import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSealer, sealerFor } from "../src/server/secrets";
import { secretsKeys } from "../src/server/secrets-key";
import { sourceKeyPlace } from "../src/server/track/key";
import { createWorkspace } from "./accounts";
import { origin, startWorld, World } from "./connections-world";
import { serverFnUrl } from "./server-fn-url";
import { ACCOUNT_ID, OTHER_ACCOUNT_ID } from "./upstreams";

async function rotationPrefix(current: string, old: string) {
	const keys = await secretsKeys({ SECRETS_KEY: current, SECRETS_KEY_PREVIOUS: old });
	return `secrets: primary=${keys.current?.id} previous=${keys.previous?.id}`;
}

const address = "https://track.test";
const refused = "Track was not connected";
let world: World;
let id: string;
let observe: ((phase: "before" | "after") => Promise<void>) | undefined;
let demote: (() => Promise<void>) | undefined;
beforeEach(async () => {
	demote = undefined;
	observe = undefined;
	world = await startWorld({
		beforeClaim: async () => {
			await demote?.();
		},
		sourceBatch: async (phase) => {
			await observe?.(phase);
		},
	});
	const token = "cf-test-token-abcdefghijklmn1234";
	world.upstream.addAccount(ACCOUNT_ID, token, []);
	id = (await world.connectCloudflare(ACCOUNT_ID, token, "Production")).connection.id;
});
afterEach(async () => {
	await world?.dispose();
});

// The browser sends Seroval's object representation to the built server function.
async function post(name: string, fields: Record<string, string>, person = world.owner) {
	const data = { slug: world.slug, ...fields };
	const object = {
		t: 10,
		i: 1,
		p: { k: Object.keys(data), v: Object.values(data).map((s) => ({ t: 1, s })) },
		o: 0,
	};
	const body = { t: { t: 10, i: 0, p: { k: ["data"], v: [object] }, o: 0 }, f: 0, m: [] };
	const response = await world.guard.fetch(serverFnUrl(name), {
		method: "POST",
		headers: { ...person.headers, "x-tsr-serverFn": "true", accept: "application/json" },
		body: JSON.stringify(body),
	});
	return response.text();
}
async function start(person = world.owner, connectionId = id) {
	const result = await post("startTrackConnect", { address, connectionId }, person);
	const href = result.match(/https:\/\/track\.test\/connect\/source\?[^"]+/)?.[0];
	if (!href) throw Error("No approval URL");
	const url = new URL(href);
	const state = url.searchParams.get("state");
	if (!state) throw Error("No state");
	return { url, state, code: world.upstream.track.approve(url) };
}
function finish({ state, code }: { state: string; code: string }, person = world.owner) {
	return post("finishTrackConnect", { state, code }, person);
}
function attempt(liveOnly = false) {
	return world.guard.db
		.prepare(
			"SELECT * FROM track_connect WHERE organization_id=? AND connection_id=? AND (?=0 OR status<>'saved')",
		)
		.bind(world.workspaceId, id, Number(liveOnly))
		.first<{ state_hash: string; verifier_sealed: string | null; undo_sealed: string | null }>();
}
describe("connecting a Track source by approval", () => {
	it("keeps the verifier sealed, saves the first address only on return, and spends each state once", async () => {
		const a = await start();
		expect([...a.url.searchParams.keys()].sort()).toEqual([
			"challenge",
			"links",
			"name",
			"product",
			"return",
			"state",
		]);
		expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Object.fromEntries(a.url.searchParams)).toMatchObject({
			product: "guard",
			name: "Production",
			links: origin,
			return: `${origin}/${world.slug}/settings/track/connected`,
		});
		const row = await attempt();
		expect(row?.state_hash).toBe(createHash("sha256").update(a.state).digest("base64url"));
		expect(row?.verifier_sealed?.startsWith("v2.")).toBe(true);
		expect(JSON.stringify(row).includes(a.state)).toBe(false);
		expect(await world.trackRow()).toBeNull();
		const page = await world.page(
			`/${world.slug}/settings/track/connected?state=${a.state}&code=${a.code}`,
		);
		expect(page.status).toBe(200);
		expect(page.text).toContain("Connecting Track");
		expect(world.upstream.track.exchanges.length).toBe(0);
		// The source insert must see a durable undo token in the claimed row.
		await world.guard.db
			.prepare(`CREATE TRIGGER needs_undo BEFORE INSERT ON track_source
			WHEN NOT EXISTS (SELECT 1 FROM track_connect a JOIN connection c ON c.id=NEW.connection_id
				WHERE a.organization_id=c.organization_id AND a.connection_id=c.id AND a.status='exchanging'
				AND a.undo_sealed LIKE 'v2.%')
			BEGIN SELECT RAISE(ABORT,'missing sealed undo'); END`)
			.run();
		const hold = Promise.withResolvers<void>();
		world.upstream.track.behaviour.holdExchange = hold.promise;
		const first = finish(a);
		try {
			await expect.poll(() => world.upstream.track.exchanges.length).toBe(1);
			expect(await finish(a)).toContain(refused);
		} finally {
			hold.resolve();
		}
		expect(await first).toContain("Operations");
		expect(await finish(a)).toContain(refused);
		const exchanges = world.upstream.track.exchanges;
		expect(exchanges).toHaveLength(1);
		expect(JSON.stringify(row).includes(exchanges[0]?.verifier ?? "")).toBe(false);
		expect(await world.trackRow()).toMatchObject({ address, source_mode: 1 });
		expect(await attempt()).toMatchObject({
			status: "saved",
			verifier_sealed: null,
			undo_sealed: null,
		});
		expect(await attempt(true)).toBeNull();
		expect(
			await world.guard.db
				.prepare(
					"SELECT key_hint FROM track_source s JOIN connection c ON c.id=s.connection_id WHERE c.organization_id=? AND c.id=?",
				)
				.bind(world.workspaceId, id)
				.first(),
		).toEqual({
			key_hint: world.upstream.track.sourceKeys[0]?.slice(-4),
		});
	});
	it("switches a workspace from its existing agent key", async () => {
		const key = `gwt_${"A".repeat(43)}`;
		world.upstream.track.addWorkspace("acme", key);
		expect(
			(
				await world.changeTrack(world.owner, {
					action: "save",
					address,
					workspace: "acme",
					team: "DEMO",
					key,
				})
			).status,
		).toBe(200);
		expect(await finish(await start())).toContain("Operations");
		expect(await world.trackRow()).toMatchObject({ key_sealed: "", key_hint: "", source_mode: 1 });
	});
	it("reconnects with a replacement sealed key and leaves the previous source in Track", async () => {
		const track = world.upstream.track;
		expect(await finish(await start())).toContain("Operations");
		expect(await finish(await start())).toContain("Operations");
		const rows = await world.guard.db
			.prepare(
				"SELECT s.key_sealed FROM track_source s JOIN connection c ON c.id=s.connection_id WHERE c.organization_id=? AND c.id=?",
			)
			.bind(world.workspaceId, id)
			.all<{ key_sealed: string }>();
		expect(rows.results).toHaveLength(1);
		const sealer = await sealerFor({ SECRETS_KEY: world.key }, world.workspaceId);
		if (!isSealer(sealer) || !rows.results[0]) throw Error("Missing source");
		expect(await sealer.open(sourceKeyPlace(id), rows.results[0].key_sealed)).toBe(
			track.sourceKeys[1],
		);
		expect([...track.sources.keys()]).toEqual(track.sourceKeys);
		expect(track.undos).toEqual([]);
	});
	it("replaces a pending state and consumes a denial", async () => {
		const first = await start();
		const second = await start();
		expect(await finish(first)).toContain(refused);
		expect(await post("finishTrackConnect", { state: second.state, error: "denied" })).toContain(
			refused,
		);
		expect(await attempt()).toBeNull();
		expect(await world.trackRow()).toBeNull();
		expect(world.upstream.track.exchanges).toHaveLength(0);
	});
	it("refuses another admin's state and a demoted starter", async () => {
		const admin = await world.addMember("admin", "admin");
		const a = await start(admin);
		expect(await finish(a)).toContain(refused);
		await world.guard.db
			.prepare("UPDATE member SET role='member' WHERE organization_id=? AND user_id=?")
			.bind(world.workspaceId, admin.userId)
			.run();
		expect(await finish(a, admin)).toContain(refused);
		expect(world.upstream.track.exchanges).toHaveLength(0);
	});
	it("refuses an expired state and sweeps it", async () => {
		const a = await start();
		await world.guard.db
			.prepare("UPDATE track_connect SET expires_at=0 WHERE organization_id=? AND connection_id=?")
			.bind(world.workspaceId, id)
			.run();
		expect(await finish(a)).toContain(refused);
		expect(world.upstream.track.exchanges).toHaveLength(0);
		await world.guard.runScheduled();
		expect(await attempt()).toBeNull();
	});
	it("refuses a connection removed during approval", async () => {
		const a = await start();
		await world.guard.db
			.prepare("DELETE FROM connection WHERE organization_id=? AND id=?")
			.bind(world.workspaceId, id)
			.run();
		expect(await finish(a)).toContain(refused);
		expect(world.upstream.track.exchanges).toHaveLength(0);
	});
	it.each([
		"endpoint",
		"product",
		"name",
		"key",
		"redirect",
		"timeout",
		"rate limit",
		"long undo",
		"missing deadline",
		"bad deadline",
		"oversized",
	])("refuses a Track response with fault %s", async (fault) => {
		world.upstream.track.behaviour.exchangeFault = fault;
		expect(await finish(await start())).toContain(refused);
		expect(await world.trackRow()).toBeNull();
		expect(await attempt()).toBeNull();
		if (["endpoint", "product", "name", "key", "missing deadline", "bad deadline"].includes(fault))
			expect(world.upstream.track.sources.size).toBe(0);
		expect(world.guard.outbound).not.toContain(`${address}/unexpected`);
	});
	it.each([200, 400, 429, 500])("records rollback cleanup after undo HTTP %i", async (status) => {
		const track = world.upstream.track;
		track.behaviour.undoStatus = status;
		await world.guard.db
			.prepare(
				"CREATE TRIGGER refuse_source BEFORE INSERT ON track_source BEGIN SELECT RAISE(ABORT,'refused'); END",
			)
			.run();
		expect(await finish(await start())).toContain(refused);
		expect(track.undos).toHaveLength(1);
		expect(await world.trackRow()).toBeNull();
		if (status === 429 || status === 500) {
			expect(await attempt()).toMatchObject({
				status: "undoing",
				undo_attempts: 1,
				undo_status: status,
			});
			expect(track.sources.size).toBe(1);
			track.behaviour.undoStatus = 200;
			await world.guard.runScheduled();
			expect(track.sources.size).toBe(0);
		} else {
			expect(track.sources.size).toBe(status === 200 ? 0 : 1);
		}
		expect(await attempt()).toBeNull();
	});

	it("reports success when D1 loses the acknowledgement after committing the save", async () => {
		let lost = false;
		observe = async (phase) => {
			if (phase === "after") {
				lost = true;
				throw Error();
			}
		};
		expect(await finish(await start())).toContain("Operations");
		expect(lost).toBe(true);
		expect(await attempt()).toMatchObject({
			status: "saved",
			verifier_sealed: null,
			undo_sealed: null,
		});
		expect(await attempt(true)).toBeNull();
		const track = world.upstream.track;
		expect(track.undos).toHaveLength(0);
		expect([...track.sources.keys()]).toEqual([await savedKey()]);
	});

	async function savedKey() {
		const saved = await world.guard.db
			.prepare(
				"SELECT s.key_sealed FROM track_source s JOIN connection c ON c.id=s.connection_id WHERE c.organization_id=? AND c.id=?",
			)
			.bind(world.workspaceId, id)
			.first<string>("key_sealed");
		const sealer = await sealerFor({ SECRETS_KEY: world.key }, world.workspaceId);
		if (!saved || !isSealer(sealer)) throw Error("Missing key");
		return sealer.open(sourceKeyPlace(id), saved);
	}
	async function expire() {
		await world.guard.db
			.prepare("UPDATE track_connect SET expires_at=0 WHERE organization_id=? AND connection_id=?")
			.bind(world.workspaceId, id)
			.run();
	}
	async function stalledSave(expired = true) {
		const a = await start();
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		observe = async (phase) => {
			if (phase === "before") {
				entered.resolve();
				await resume.promise;
			}
		};
		const result = finish(a);
		await entered.promise;
		if (expired) await expire();
		return { resume: resume.resolve, result };
	}
	it.each(["paste", "stop", "remove connection"] as const)(
		"a later %s supersedes the live approval",
		async (action) => {
			expect(await finish(await start())).toContain("Operations");
			const save = await stalledSave(false);
			const key = `gws_${"P".repeat(43)}`;
			let superseded: Awaited<ReturnType<typeof attempt>>;
			try {
				const changed =
					action === "remove connection"
						? await world.act(world.owner, { action: "remove", id })
						: await world.changeTrack(
								world.owner,
								action === "paste"
									? { action: "source", address, connectionId: id, key }
									: { action: "remove" },
							);
				expect(changed.status).toBe(200);
				superseded = await attempt(true);
			} finally {
				save.resume();
			}
			expect(await save.result).toContain(refused);
			expect(superseded).toMatchObject({ superseded: 1 });
			expect(world.upstream.track.undos).toHaveLength(1);
			expect([...world.upstream.track.sources.keys()]).toEqual(
				world.upstream.track.sourceKeys.slice(0, 1),
			);
			if (action === "paste") expect(await savedKey()).toBe(key);
			if (action === "stop") expect(await world.trackRow()).toBeNull();
		},
	);

	it("invalidates pending approvals within each settings action's scope", async () => {
		const token = "cf-other-token-abcdefghijklmn1234";
		world.upstream.addAccount(OTHER_ACCOUNT_ID, token, []);
		const other = (await world.connectCloudflare(OTHER_ACCOUNT_ID, token, "Development")).connection
			.id;
		const pending = async () =>
			(
				await world.guard.db
					.prepare(
						"SELECT connection_id FROM track_connect WHERE organization_id=? AND status='pending'",
					)
					.bind(world.workspaceId)
					.all<{ connection_id: string }>()
			).results;
		await start();
		await start(world.owner, other);
		expect(
			(
				await world.changeTrack(world.owner, {
					action: "source",
					address,
					connectionId: id,
					key: `gws_${"P".repeat(43)}`,
				})
			).status,
		).toBe(200);
		expect(await pending()).toEqual([{ connection_id: other }]);
		await start();
		expect((await world.act(world.owner, { action: "remove", id })).status).toBe(200);
		expect(await pending()).toEqual([{ connection_id: other }]);
		expect((await world.changeTrack(world.owner, { action: "remove" })).status).toBe(200);
		expect(await pending()).toEqual([]);
	});

	it("keeps the installed source when a paste has the same key digest", async () => {
		const save = await stalledSave(false);
		const [key] = world.upstream.track.sourceKeys;
		try {
			if (!key) throw Error("Missing source");
			expect(
				(await world.changeTrack(world.owner, { action: "source", address, connectionId: id, key }))
					.status,
			).toBe(200);
		} finally {
			save.resume();
		}
		expect(await save.result).toContain("Operations");
		expect(world.upstream.track.undos).toHaveLength(0);
		expect([...world.upstream.track.sources.keys()]).toEqual([await savedKey()]);
		expect(await attempt()).toMatchObject({
			status: "saved",
			verifier_sealed: null,
			undo_sealed: null,
		});
		expect(await attempt(true)).toBeNull();
	});

	it("refuses a lost acknowledgement after the sweep completed cleanup", async () => {
		const save = await stalledSave();
		let lost = false;
		try {
			await world.guard.runScheduled();
			expect(await attempt()).toBeNull();
			observe = async (phase) => {
				if (phase === "after") {
					lost = true;
					throw Error();
				}
			};
		} finally {
			save.resume();
		}
		expect(await save.result).toContain(refused);
		expect(lost).toBe(true);
		expect(await world.trackRow()).toBeNull();
		expect(world.upstream.track.sources.size).toBe(0);
	});

	it("accepts a deadline with an explicit UTC offset", async () => {
		world.upstream.track.behaviour.undoUntil = new Date(Date.now() + 86400000)
			.toISOString()
			.replace("Z", "+00:00");
		expect(await finish(await start())).toContain("Operations");
		expect(world.upstream.track.undos).toHaveLength(0);
	});

	it("finishes undo after one oversized HTTP 200", async () => {
		const track = world.upstream.track;
		track.behaviour.exchangeFault = "missing deadline";
		track.behaviour.oversizedUndo = true;
		expect(await finish(await start())).toContain(refused);
		expect(await attempt()).toBeNull();
		await world.guard.runScheduled();
		expect(track.undos).toHaveLength(1);
		expect(track.sources.size).toBe(0);
	});

	it("checks the starter's role again when claiming the exchange", async () => {
		const admin = await world.addMember("admin", "admin");
		const a = await start(admin);
		let changed = false;
		demote = async () => {
			await world.guard.db
				.prepare("UPDATE member SET role='member' WHERE organization_id=? AND user_id=?")
				.bind(world.workspaceId, admin.userId)
				.run();
			changed = true;
		};
		expect(await finish(a, admin)).toContain(refused);
		expect(changed).toBe(true);
		expect(world.upstream.track.exchanges).toHaveLength(0);
		expect(await attempt()).toMatchObject({ status: "pending" });
	});

	async function startRotation() {
		await world.dispose();
		const old = randomBytes(32).toString("base64");
		const current = randomBytes(32).toString("base64");
		world = await startWorld({
			isolates: 3,
			settings: { SECRETS_KEY: current },
			isolateSettings: [{ SECRETS_KEY: old }, { SECRETS_KEY_PREVIOUS: old }, {}],
			sourceBatch: async (phase) => {
				await observe?.(phase);
			},
		});
		const token = "cf-test-token-abcdefghijklmn1234";
		world.upstream.addAccount(ACCOUNT_ID, token, []);
		id = (await world.connectCloudflare(ACCOUNT_ID, token, "Production")).connection.id;
		return { current, old };
	}
	it.each(["undo", "reporting key"] as const)(
		"reseals a late old-key %s before rotation settles",
		async (value) => {
			const { current, old } = await startRotation();
			const prefix = await rotationPrefix(current, old);
			const next = await sealerFor({ SECRETS_KEY: current }, world.workspaceId);
			if (!isSealer(next)) throw Error("Missing key");
			const track = world.upstream.track;
			let pending: Promise<string>;
			let resume: () => void;
			if (value === "undo") {
				const hold = Promise.withResolvers<void>();
				track.behaviour.holdExchange = hold.promise;
				track.behaviour.exchangeFault = "missing deadline";
				track.behaviour.undoStatus = 500;
				pending = finish(await start());
				resume = hold.resolve;
			} else {
				const save = await stalledSave(false);
				pending = save.result;
				resume = save.resume;
			}
			const lastLog = () =>
				world.guard.logs.filter((log) => log.message.startsWith("secrets:")).at(-1)?.message;
			const firstSeen = (minutesAgo: number) =>
				world.guard.db
					.prepare("UPDATE secrets_primary SET first_seen=?")
					.bind(Date.now() - minutesAgo * 60_000)
					.run();
			try {
				await expect.poll(() => track.exchanges.length).toBe(1);
				await world.guard.runScheduled(1);
				expect(lastLog()).toContain("left=0 settled=false");
				await firstSeen(59);
				await world.guard.runScheduled(1);
				expect(lastLog()).toBe(`${prefix} resealed=0 unopened=0 left=0 settled=false`);
			} finally {
				resume();
			}
			expect(await pending).toContain(value === "undo" ? refused : "Operations");
			await firstSeen(61);
			await world.guard.runScheduled(1);
			expect(lastLog()).toBe(`${prefix} resealed=1 unopened=0 left=0 settled=false`);
			await world.guard.runScheduled(1);
			expect(lastLog()).toBe(`${prefix} resealed=0 unopened=0 left=0 settled=true`);
			if (value === "undo") {
				const job = await attempt();
				if (!job?.undo_sealed) throw Error("Missing undo");
				expect(await next.open(`track-undo:${job.state_hash}`, job.undo_sealed)).toBe(
					track.undos[0],
				);
			} else {
				const sealed = await world.guard.db
					.prepare(
						"SELECT s.key_sealed FROM track_source s JOIN connection c ON c.id=s.connection_id WHERE c.organization_id=? AND c.id=?",
					)
					.bind(world.workspaceId, id)
					.first<string>("key_sealed");
				expect(await next.open(sourceKeyPlace(id), sealed ?? "")).toBe(track.sourceKeys[0]);
			}
		},
	);

	it("preserves rotated undo ciphertext when the old isolate claims rollback", async () => {
		const { current, old } = await startRotation();
		const prefix = await rotationPrefix(current, old);
		const save = await stalledSave(false);
		const track = world.upstream.track;
		let rotated: Awaited<ReturnType<typeof attempt>>;
		try {
			await world.guard.runScheduled(1);
			rotated = await attempt();
			expect(world.guard.logs.map((log) => log.message)).toContain(
				`${prefix} resealed=3 unopened=0 left=0 settled=false`,
			);
			await world.guard.db
				.prepare(
					"CREATE TRIGGER refuse_source BEFORE INSERT ON track_source BEGIN SELECT RAISE(ABORT,'refused'); END",
				)
				.run();
			track.behaviour.undoStatus = 500;
		} finally {
			save.resume();
		}
		expect(await save.result).toContain(refused);
		const claimed = await attempt();
		if (!rotated?.undo_sealed || !claimed?.undo_sealed) throw Error("Missing undo");
		expect(claimed).toMatchObject({
			undo_attempts: 1,
			undo_status: 500,
			undo_sealed: rotated.undo_sealed,
			verifier_sealed: rotated.verifier_sealed,
		});
		const sealer = await sealerFor({ SECRETS_KEY: current }, world.workspaceId);
		if (!isSealer(sealer)) throw Error("Missing current key");
		expect(await sealer.open(`track-undo:${claimed.state_hash}`, claimed.undo_sealed)).toBe(
			track.undos[0],
		);
		track.behaviour.undoStatus = 200;
		await world.guard.runScheduled(2);
		expect(await attempt()).toBeNull();
		expect(track.sources.size).toBe(0);
	});

	it("handles the 25 soonest deadlines and rotates secrets with cleanup still due", async () => {
		const old = randomBytes(32).toString("base64");
		await world.dispose();
		world = await startWorld({ settings: { SECRETS_KEY_PREVIOUS: old } });
		// Cleanup also outlives deleted connections. All jobs here share a removed connection id.
		id = "removed";
		const sealer = await sealerFor({ SECRETS_KEY: old }, world.workspaceId);
		if (!isSealer(sealer)) throw Error("Missing sealer");
		const end = Date.now() + 86400000;
		for (let n = 29; n >= 0; n--) {
			const hash = String(n);
			await world.guard.db
				.prepare(
					"INSERT INTO track_connect(organization_id,connection_id,user_id,address,name,state_hash,verifier_sealed,undo_sealed,undo_until,status,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'undoing',0)",
				)
				.bind(
					world.workspaceId,
					id,
					world.owner.userId,
					address,
					"test",
					hash,
					await sealer.seal(`track-verifier:${hash}`, "verifier"),
					await sealer.seal(`track-undo:${hash}`, hash),
					end + n,
				)
				.run();
		}
		await world.guard.runScheduled();
		expect(world.upstream.track.undos).toEqual(Array.from({ length: 25 }, (_, i) => String(i)));
		expect(world.guard.logs.map((log) => log.message)).toContain(
			`${await rotationPrefix(world.key, old)} resealed=60 unopened=0 left=0 settled=false`,
		);
		await world.guard.runScheduled();
		expect(world.upstream.track.undos).toHaveLength(30);
		expect(await attempt()).toBeNull();
	});

	it("saves before the sweep claims the attempt", async () => {
		const track = world.upstream.track;
		// The first undo holds the sweep after it has read both expired attempts.
		track.behaviour.exchangeFault = "name";
		track.behaviour.undoStatus = 500;
		expect(await finish(await start())).toContain(refused);
		track.behaviour.exchangeFault = "";
		track.behaviour.undoStatus = 200;
		const save = await stalledSave();
		await world.guard.db
			.prepare(
				"UPDATE track_connect SET expires_at=-1, last_tried_at=NULL, undo_until=undo_until-60000 WHERE organization_id=? AND connection_id=? AND status='undoing'",
			)
			.bind(world.workspaceId, id)
			.run();
		const hold = Promise.withResolvers<void>();
		track.behaviour.holdUndo = hold.promise;
		const sweep = world.guard.runScheduled();
		try {
			await expect.poll(() => track.undos.length).toBe(2);
			expect(track.undos[1]).toBe(track.undos[0]);
			save.resume();
			expect(await save.result).toContain("Operations");
		} finally {
			save.resume();
			hold.resolve();
			await sweep;
		}
		expect([...track.sources.keys()]).toEqual([await savedKey()]);
		expect(track.undos).toHaveLength(2);
		expect(await attempt()).toMatchObject({
			status: "saved",
			verifier_sealed: null,
			undo_sealed: null,
		});
		expect(await attempt(true)).toBeNull();
	});
	it("refuses a stalled save once the sweep claims its undo", async () => {
		const save = await stalledSave();
		const track = world.upstream.track;
		const hold = Promise.withResolvers<void>();
		track.behaviour.holdUndo = hold.promise;
		const sweep = world.guard.runScheduled();
		try {
			await expect.poll(() => track.undos.length).toBe(1);
			expect(await attempt()).toMatchObject({ status: "undoing" });
			save.resume();
			expect(await save.result).toContain(refused);
			expect(await world.trackRow()).toBeNull();
		} finally {
			save.resume();
			hold.resolve();
			await sweep;
		}
		expect(track.undos).toHaveLength(1);
		expect(track.sources.size).toBe(0);
		expect(await attempt()).toBeNull();
	});
	it.each([429, 500])(
		"retries an interrupted exchange across daily runs after HTTP %i",
		async (status) => {
			const save = await stalledSave();
			const track = world.upstream.track;
			track.behaviour.undoStatus = status;
			try {
				await world.guard.runScheduled();
				expect(await attempt()).toMatchObject({
					status: "undoing",
					undo_attempts: 1,
					undo_status: status,
				});
				track.behaviour.undoStatus = 200;
				await world.guard.runScheduled();
			} finally {
				save.resume();
			}
			expect(await save.result).toContain(refused);
			expect(track.undos).toHaveLength(2);
			expect(track.sources.size).toBe(0);
			expect(await attempt()).toBeNull();
		},
	);
	it("drops a past undo deadline without calling Track", async () => {
		const track = world.upstream.track;
		track.behaviour.undoUntil = new Date(Date.now() - 1000).toISOString();
		const save = await stalledSave();
		try {
			await world.guard.runScheduled();
		} finally {
			save.resume();
		}
		expect(await save.result).toContain(refused);
		expect(track.undos).toHaveLength(0);
		expect(track.sources.size).toBe(1);
		expect(await attempt()).toBeNull();
	});
	it("keeps a source that received an event before undo", async () => {
		const save = await stalledSave();
		const track = world.upstream.track;
		try {
			const event = await track.handler(
				new Request(`${address}/api/events`, {
					method: "POST",
					headers: { authorization: `Bearer ${track.sourceKeys[0]}` },
					body: JSON.stringify({ key: "signal", state: "open" }),
				}),
			);
			expect(event.status).toBe(200);
			await world.guard.runScheduled();
		} finally {
			save.resume();
		}
		expect(await save.result).toContain(refused);
		expect(track.sources.size).toBe(1);
		expect(await attempt()).toBeNull();
	});
	it("retains an oversized invalid_undo answer for another daily run", async () => {
		const track = world.upstream.track;
		track.behaviour.exchangeFault = "missing deadline";
		track.behaviour.undoStatus = 400;
		track.behaviour.oversizedUndo = true;
		expect(await finish(await start())).toContain(refused);
		expect(await attempt()).toMatchObject({
			status: "undoing",
			undo_until: null,
			undo_attempts: 1,
			undo_status: 400,
		});
		expect(track.sources.size).toBe(1);
		track.behaviour.undoStatus = 200;
		await world.guard.runScheduled();
		expect(track.sources.size).toBe(0);
		expect(await attempt()).toBeNull();
	});
	it("recovers a late token when the sweep already removed the empty exchange", async () => {
		const track = world.upstream.track;
		const hold = Promise.withResolvers<void>();
		track.behaviour.holdExchange = hold.promise;
		track.behaviour.undoStatus = 500;
		const result = finish(await start());
		try {
			await expect.poll(() => track.exchanges.length).toBe(1);
			await expire();
			await world.guard.runScheduled();
			expect(await attempt()).toBeNull();
		} finally {
			hold.resolve();
		}
		expect(await result).toContain(refused);
		expect(await attempt()).toMatchObject({ status: "undoing", undo_attempts: 1 });
		expect(await world.trackRow()).toBeNull();
		track.behaviour.undoStatus = 200;
		await world.guard.runScheduled();
		expect(track.sources.size).toBe(0);
		expect(await attempt()).toBeNull();
	});
	it("leaves the exchange for the sweep when both the save and its recovery read fail", async () => {
		const a = await start();
		let hidden = false;
		observe = async (phase) => {
			if (phase === "before") {
				await world.guard.db.exec("ALTER TABLE track_connect RENAME TO hidden_attempt");
				hidden = true;
			}
		};
		try {
			expect(await finish(a)).toContain(refused);
			expect(hidden).toBe(true);
			expect(world.upstream.track.undos).toHaveLength(0);
		} finally {
			observe = undefined;
			if (hidden) await world.guard.db.exec("ALTER TABLE hidden_attempt RENAME TO track_connect");
		}
		expect(await attempt()).toMatchObject({ status: "exchanging" });
		await expire();
		await world.guard.runScheduled();
		expect(world.upstream.track.sources.size).toBe(0);
		expect(await attempt()).toBeNull();
	});
	it("refuses a starter demoted during exchange", async () => {
		const admin = await world.addMember("admin", "admin");
		const hold = Promise.withResolvers<void>();
		const track = world.upstream.track;
		track.behaviour.holdExchange = hold.promise;
		const result = finish(await start(admin), admin);
		try {
			await expect.poll(() => track.exchanges.length).toBe(1);
			await world.guard.db
				.prepare("UPDATE member SET role='member' WHERE organization_id=? AND user_id=?")
				.bind(world.workspaceId, admin.userId)
				.run();
		} finally {
			hold.resolve();
		}
		expect(await result).toContain(refused);
		expect(await world.trackRow()).toBeNull();
		expect(track.sources.size).toBe(0);
	});
	it("keeps the newest setup when an older exchange answers last", async () => {
		const track = world.upstream.track;
		const hold = Promise.withResolvers<void>();
		track.behaviour.holdExchange = hold.promise;
		const first = finish(await start());
		try {
			await expect.poll(() => track.exchanges.length).toBe(1);
			track.behaviour.holdExchange = null;
			expect(await finish(await start())).toContain("Operations");
		} finally {
			hold.resolve();
		}
		expect(await first).toContain(refused);
		expect(await savedKey()).toBe(track.sourceKeys[0]);
		expect([...track.sources.keys()]).toEqual([track.sourceKeys[0]]);
	});
	it("keeps a pending approval after a paste that changed nothing", async () => {
		const paste = {
			action: "source",
			connectionId: id,
			address,
			key: `gws_${"P".repeat(43)}`,
		} as const;
		expect((await world.changeTrack(world.owner, paste)).status).toBe(200);
		const approval = await start();
		expect((await world.changeTrack(world.owner, paste)).status).toBe(409);
		expect(await finish(approval)).toContain("Operations");
	});

	it("recovers a saved same-digest completion when the acknowledgement is lost", async () => {
		const save = await stalledSave(false);
		try {
			const key = world.upstream.track.sourceKeys[0];
			if (!key) throw Error("Missing source");
			expect(
				(await world.changeTrack(world.owner, { action: "source", connectionId: id, address, key }))
					.status,
			).toBe(200);
			observe = async (phase) => {
				if (phase === "after") throw Error();
			};
		} finally {
			save.resume();
		}
		expect(await save.result).toContain("Operations");
		expect(world.upstream.track.undos).toHaveLength(0);
	});

	it("recovers the approval's own save after a later paste and prunes its receipt after a day", async () => {
		const key = `gws_${"P".repeat(43)}`;
		let pasted = 0;
		observe = async (phase) => {
			if (phase === "after") {
				pasted = (
					await world.changeTrack(world.owner, { action: "source", connectionId: id, address, key })
				).status;
				throw Error();
			}
		};
		const before = Date.now();
		expect(await finish(await start())).toContain("Operations");
		expect(pasted).toBe(200);
		expect(await savedKey()).toBe(key);
		expect(world.upstream.track.undos).toHaveLength(0);
		const receipt = () =>
			world.guard.db
				.prepare(
					"SELECT status, expires_at, verifier_sealed, undo_sealed FROM track_connect WHERE organization_id=? AND connection_id=?",
				)
				.bind(world.workspaceId, id)
				.first<{ expires_at: number }>();
		await world.guard.runScheduled();
		const saved = await receipt();
		expect(saved).toMatchObject({ status: "saved", verifier_sealed: null, undo_sealed: null });
		expect(saved?.expires_at).toBeGreaterThanOrEqual(before + 86_400_000);
		expect(saved?.expires_at).toBeLessThanOrEqual(Date.now() + 86_400_000);
		await expire();
		await world.guard.runScheduled();
		expect(await receipt()).toBeNull();
	});

	it("undoes the issuing source when the digest is installed at a different Track origin", async () => {
		const save = await stalledSave(false);
		try {
			const key = world.upstream.track.sourceKeys[0];
			if (!key) throw Error("Missing key");
			expect(
				(
					await world.changeTrack(world.owner, {
						action: "source",
						connectionId: id,
						address: "https://other.test",
						key,
					})
				).status,
			).toBe(200);
		} finally {
			save.resume();
		}
		expect(await save.result).toContain(refused);
		expect(world.upstream.track.undos).toHaveLength(1);
		expect(world.guard.outbound).toContain(`${address}/api/connect/undo`);
		expect(world.upstream.track.sources.size).toBe(0);
		expect(await savedKey()).toBe(world.upstream.track.sourceKeys[0]);
		expect(await attempt()).toBeNull();
	});

	it("drops cleanup when the issued key is installed in another workspace", async () => {
		const slug = "second-space";
		const other = new World(
			world.guard,
			world.upstream,
			world.key,
			world.owner,
			slug,
			await createWorkspace(world.guard, origin, world.owner.headers, slug),
		);
		const token = "cf-other-token-abcdefghijklmn1234";
		world.upstream.addAccount(OTHER_ACCOUNT_ID, token, []);
		const connectionId = (await other.connectCloudflare(OTHER_ACCOUNT_ID, token)).connection.id;
		const save = await stalledSave();
		try {
			const key = world.upstream.track.sourceKeys[0];
			if (!key) throw Error("Missing source");
			expect(
				(await other.changeTrack(other.owner, { action: "source", connectionId, address, key }))
					.status,
			).toBe(200);
			await world.guard.runScheduled();
		} finally {
			save.resume();
		}
		expect(await save.result).toContain(refused);
		expect(world.upstream.track.undos).toHaveLength(0);
		expect([...world.upstream.track.sources.keys()]).toEqual(world.upstream.track.sourceKeys);
		expect(await attempt()).toBeNull();
	});

	it("keeps an existing undo token when late exchange recovery finds a nonempty row", async () => {
		const approval = await start();
		const row = await attempt();
		const sealer = await sealerFor({ SECRETS_KEY: world.key }, world.workspaceId);
		if (!row || !isSealer(sealer)) throw Error("Missing attempt");
		const earlier = await sealer.seal(`track-undo:${row.state_hash}`, "already-kept");
		const track = world.upstream.track;
		const hold = Promise.withResolvers<void>();
		track.behaviour.holdExchange = hold.promise;
		const result = finish(approval);
		try {
			await expect.poll(() => track.exchanges.length).toBe(1);
			await world.guard.db
				.prepare("UPDATE track_connect SET undo_sealed=? WHERE organization_id=? AND state_hash=?")
				.bind(earlier, world.workspaceId, row.state_hash)
				.run();
		} finally {
			hold.resolve();
		}
		expect(await result).toContain(refused);
		expect(await attempt()).toMatchObject({ undo_sealed: earlier, status: "exchanging" });
		expect(track.undos).toHaveLength(0);
	});

	async function addJobs(count: number, deadline: number, lastTried: number | null) {
		const sealer = await sealerFor({ SECRETS_KEY: world.key }, world.workspaceId);
		if (!isSealer(sealer)) throw Error("Missing key");
		for (let n = 0; n < count; n++) {
			const hash = `job-${n}`;
			await world.guard.db
				.prepare(
					"INSERT INTO track_connect (organization_id,connection_id,user_id,address,name,state_hash,verifier_sealed,undo_sealed,undo_until,last_tried_at,status,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,'undoing',0)",
				)
				.bind(
					world.workspaceId,
					id,
					world.owner.userId,
					"https://unreachable.test",
					"Removed",
					hash,
					await sealer.seal(`track-verifier:${hash}`, "verifier"),
					await sealer.seal(`track-undo:${hash}`, hash),
					deadline,
					lastTried,
				)
				.run();
		}
	}

	it("expires 25 pending approvals and sends a failed undo in one run", async () => {
		const track = world.upstream.track;
		track.behaviour.exchangeFault = "missing deadline";
		track.behaviour.undoStatus = 500;
		expect(await finish(await start())).toContain(refused);
		expect(track.sources.size).toBe(1);
		await world.guard.db
			.prepare(`WITH RECURSIVE n(i) AS (VALUES (1) UNION ALL SELECT i+1 FROM n WHERE i<25)
			INSERT INTO track_connect(organization_id,connection_id,user_id,address,name,state_hash,status,expires_at)
			SELECT ?,?,?,?,'expired','pending-' || i,'pending',0 FROM n`)
			.bind(world.workspaceId, id, world.owner.userId, address)
			.run();
		track.behaviour.undoStatus = 200;
		await world.guard.runScheduled();
		expect(track.undos).toHaveLength(2);
		expect(track.sources.size).toBe(0);
		expect(await attempt()).toBeNull();
	});

	it("tries a known deadline before an unknown deadline at the same retry position", async () => {
		await addJobs(2, Date.now() + 60_000, 1);
		await world.guard.db
			.prepare(
				"UPDATE track_connect SET address=?, undo_until=CASE WHEN state_hash='job-0' THEN NULL ELSE undo_until END WHERE organization_id=?",
			)
			.bind(address, world.workspaceId)
			.run();
		await world.guard.runScheduled();
		expect(world.upstream.track.undos).toEqual(["job-1", "job-0"]);
	});

	it("drops every expired undo outside the daily cap without contacting Track", async () => {
		await addJobs(30, Date.now() - 1, null);
		await world.guard.runScheduled();
		expect(await attempt()).toBeNull();
		expect(world.guard.outbound).not.toContain("https://unreachable.test/api/connect/undo");
	});

	it.each([true, false])(
		"reaches a healthy source behind 25 unreachable jobs (never tried = %s)",
		async (neverTried) => {
			// A malformed exchange keeps a real source and undo at healthy Track, with no deadline.
			const track = world.upstream.track;
			track.behaviour.exchangeFault = "missing deadline";
			track.behaviour.undoStatus = 500;
			expect(await finish(await start())).toContain(refused);
			expect(track.sources.size).toBe(1);
			if (neverTried)
				await world.guard.db
					.prepare(
						"UPDATE track_connect SET last_tried_at=NULL, undo_attempts=0 WHERE organization_id=? AND connection_id=?",
					)
					.bind(world.workspaceId, id)
					.run();
			await addJobs(25, Date.now() + 60_000, 1);
			track.behaviour.undoStatus = 200;
			await world.guard.runScheduled();
			if (!neverTried) {
				expect(track.sources.size).toBe(1);
				await world.guard.runScheduled();
			}
			expect(track.sources.size).toBe(0);
		},
	);
});
