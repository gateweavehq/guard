import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { TrackActionInput } from "../../lib/track-schemas";
import { db } from "../auth";
import { tokenHint } from "../connections/tokens";
import { schema } from "../db";
import { refusedByUnique } from "../db/query-failure";
import { appOrigin } from "../origin";
import { isSealer, sealerFor, toBase64 } from "../secrets";
import { parseTrackAddress } from "./address";
import { sourceKeyPlace } from "./key";
import { reportAfterChange } from "./report";

function refuse(error: string, status = 400) {
	return Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });
}

export async function saveSource(
	workspaceId: string,
	userId: string,
	action: Extract<TrackActionInput, { action: "source" }>,
) {
	const { connection, trackIntegration } = schema;
	const id = action.connectionId;
	const owned = await db
		.select({ id: connection.id })
		.from(connection)
		.where(and(eq(connection.organizationId, workspaceId), eq(connection.id, id)))
		.get();
	if (!owned) return refuse("Not found", 404);
	const existing = await db
		.select({ address: trackIntegration.address })
		.from(trackIntegration)
		.where(eq(trackIntegration.organizationId, workspaceId))
		.get();
	const origin = appOrigin();
	const parsed = parseTrackAddress(action.address ?? existing?.address ?? "", origin);
	if (!parsed.ok) return refuse(parsed.error);
	const address = parsed.origin;
	if (!address.startsWith("https://")) return refuse("Use an HTTPS origin for Track.");
	if (existing && existing.address !== address)
		return refuse("Use this workspace's Track address.");
	const sealer = await sealerFor(env, workspaceId);
	if (!isSealer(sealer)) return refuse(sealer.unavailable);
	const sealed = await sealer.seal(sourceKeyPlace(id), action.key);
	const digest = toBase64(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(action.key))),
	);
	const generation = crypto.randomUUID();
	const client = db.$client;
	try {
		const [, saved] = await client.batch([
			client
				.prepare(`INSERT INTO track_integration (organization_id,address,workspace_slug,team_key,key_sealed,key_hint,added_by,added_at,source_mode)
				VALUES (?,?,'','','','',?,?,1) ON CONFLICT(organization_id) DO UPDATE SET
				source_mode=1,key_sealed='',key_hint='',fix_label=NULL WHERE address=excluded.address`)
				.bind(workspaceId, address, userId, Date.now()),
			client
				.prepare(`INSERT INTO track_source (connection_id,key_sealed,key_hint,key_digest,generation,guard_origin)
				SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM track_integration WHERE organization_id=? AND source_mode=1 AND address=?)
				ON CONFLICT(connection_id) DO UPDATE SET key_sealed=excluded.key_sealed,key_hint=excluded.key_hint,
				key_digest=excluded.key_digest,generation=excluded.generation,guard_origin=excluded.guard_origin,
				last_answer=NULL,answered_at=NULL,first_missing_at=NULL,stopped=0,lease=NULL,lease_until=NULL
                 WHERE key_digest <> excluded.key_digest`)
				.bind(id, sealed, tokenHint(action.key), digest, generation, origin, workspaceId, address),
			client
				.prepare(`UPDATE finding SET source_rejected=NULL,
				source_unconfirmed=CASE WHEN source_state IS NOT NULL THEN 1 ELSE source_unconfirmed END
				WHERE connection_id=? AND track_state IS NULL AND EXISTS
				(SELECT 1 FROM track_source WHERE connection_id=? AND generation=?)`)
				.bind(id, id, generation),
		]);
		if (!saved?.meta.changes)
			return refuse("Paste a new source key and check the workspace's Track address.", 409);
	} catch (error) {
		if (refusedByUnique(error, "track_source.key_digest"))
			return refuse("Use a separate Track source for each connection.", 409);
		throw error;
	}
	await reportAfterChange(db, env, id, 0);
	return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
