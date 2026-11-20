import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { isSealer, sealerFor } from "../src/server/secrets";
import { startWorld } from "./connections-world";

it("counts both sealed attempt values until rotation and opens them with the new key", async () => {
	const previous = randomBytes(32).toString("base64");
	const current = randomBytes(32).toString("base64");
	const world = await startWorld({
		isolates: 2,
		settings: { SECRETS_KEY: current },
		isolateSettings: [{}, { SECRETS_KEY_PREVIOUS: previous }],
	});
	try {
		const old = await sealerFor({ SECRETS_KEY: previous }, world.workspaceId);
		const next = await sealerFor({ SECRETS_KEY: current }, world.workspaceId);
		if (!isSealer(old) || !isSealer(next)) throw Error("Missing test key");
		await world.guard.db
			.prepare(
				"INSERT INTO track_connect(organization_id,connection_id,user_id,address,name,state_hash,verifier_sealed,undo_sealed,status,expires_at) VALUES(?,?,?,'https://track.test','test','hash',?,?,'exchanging',?)",
			)
			.bind(
				world.workspaceId,
				"connection",
				world.owner.userId,
				await old.seal("track-verifier:hash", "verifier"),
				await old.seal("track-undo:hash", "undo"),
				Date.now() + 600000,
			)
			.run();
		await world.guard.runScheduled();
		expect(world.guard.logs.map((log) => log.message)).toContain(
			`secrets: primary=${next.keyId} previous=none resealed=0 unopened=2 left=2 settled=false`,
		);
		await world.guard.runScheduled(1);
		expect(world.guard.logs.map((log) => log.message)).toContain(
			`secrets: primary=${next.keyId} previous=${old.keyId} resealed=2 unopened=0 left=0 settled=false`,
		);
		const row = await world.guard.db
			.prepare(
				"SELECT verifier_sealed,undo_sealed FROM track_connect WHERE organization_id=? AND state_hash='hash'",
			)
			.bind(world.workspaceId)
			.first<{ verifier_sealed: string; undo_sealed: string }>();
		if (!row) throw Error("Missing attempt");
		expect(await next.open("track-verifier:hash", row.verifier_sealed)).toBe("verifier");
		expect(await next.open("track-undo:hash", row.undo_sealed)).toBe("undo");
	} finally {
		await world.dispose();
	}
});

it("preserves a newer verifier written after rotation read its page", async () => {
	const previous = randomBytes(32).toString("base64");
	const current = randomBytes(32).toString("base64");
	const world = await startWorld({
		settings: { SECRETS_KEY: current, SECRETS_KEY_PREVIOUS: previous },
	});
	try {
		const old = await sealerFor({ SECRETS_KEY: previous }, world.workspaceId);
		const next = await sealerFor({ SECRETS_KEY: current }, world.workspaceId);
		if (!isSealer(old) || !isSealer(next)) throw Error("Missing key");
		for (const hash of ["a", "b"]) {
			await world.guard.db
				.prepare(
					"INSERT INTO track_connect(organization_id,connection_id,user_id,address,name,state_hash,verifier_sealed,status,expires_at) VALUES(?,?,?,'https://track.test','test',?,?,'pending',?)",
				)
				.bind(
					world.workspaceId,
					"connection",
					world.owner.userId,
					hash,
					await old.seal(`track-verifier:${hash}`, "old"),
					Date.now() + 600000,
				)
				.run();
		}
		await world.guard.db.exec("CREATE TABLE replacement (workspace TEXT, sealed TEXT)");
		await world.guard.db
			.prepare("INSERT INTO replacement VALUES(?,?)")
			.bind(world.workspaceId, await next.seal("track-verifier:b", "newer"))
			.run();
		await world.guard.db
			.prepare(
				"CREATE TRIGGER replace_next AFTER UPDATE OF verifier_sealed ON track_connect WHEN NEW.state_hash='a' BEGIN UPDATE track_connect SET verifier_sealed=(SELECT sealed FROM replacement WHERE workspace=NEW.organization_id) WHERE organization_id=NEW.organization_id AND state_hash='b'; END",
			)
			.run();
		await world.guard.runScheduled();
		const sealed = await world.guard.db
			.prepare(
				"SELECT verifier_sealed FROM track_connect WHERE organization_id=? AND state_hash='b'",
			)
			.bind(world.workspaceId)
			.first<string>("verifier_sealed");
		expect(await next.open("track-verifier:b", sealed ?? "")).toBe("newer");
	} finally {
		await world.dispose();
	}
});

it("starts a fresh observation clock when rolling back to a previously used primary", async () => {
	const a = randomBytes(32).toString("base64");
	const b = randomBytes(32).toString("base64");
	const world = await startWorld({
		isolates: 3,
		settings: { SECRETS_KEY: a },
		isolateSettings: [{}, { SECRETS_KEY: b, SECRETS_KEY_PREVIOUS: a }, { SECRETS_KEY_PREVIOUS: b }],
	});
	try {
		const lastLog = () =>
			world.guard.logs.filter((log) => log.message.startsWith("secrets:")).at(-1)?.message;
		const age = () =>
			world.guard.db
				.prepare("UPDATE secrets_primary SET first_seen=?")
				.bind(Date.now() - 3_601_000)
				.run();
		await world.guard.runScheduled(0);
		await world.guard.runScheduled(1);
		await age();
		await world.guard.runScheduled(1);
		expect(lastLog()).toContain("left=0 settled=true");
		await world.guard.runScheduled(2);
		expect(lastLog()).toContain("left=0 settled=false");
		await age();
		await world.guard.runScheduled(2);
		expect(lastLog()).toContain("left=0 settled=true");
	} finally {
		await world.dispose();
	}
});

it("keeps an overlapping Worker without a previous key unsettled", async () => {
	const old = randomBytes(32).toString("base64");
	const world = await startWorld({
		isolates: 2,
		settings: { SECRETS_KEY: old },
		isolateSettings: [
			{},
			{ SECRETS_KEY: randomBytes(32).toString("base64"), SECRETS_KEY_PREVIOUS: old },
		],
	});
	try {
		await world.guard.runScheduled(0);
		await world.guard.db
			.prepare("UPDATE secrets_primary SET first_seen=?")
			.bind(Date.now() - 3_601_000)
			.run();
		await world.guard.runScheduled(1);
		await world.guard.runScheduled(0);
		expect(
			world.guard.logs.filter((log) => log.message.startsWith("secrets:")).at(-1)?.message,
		).toContain("previous=none resealed=0 unopened=0 left=0 settled=false");
	} finally {
		await world.dispose();
	}
});
