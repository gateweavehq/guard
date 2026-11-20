import { env } from "cloudflare:workers";
import { and, eq, exists, type SQL } from "drizzle-orm";
import { isAdminRole, MEMBER_ROLES } from "../../lib/roles";
import type { TrackActionInput } from "../../lib/track-schemas";
import { db } from "../auth";
import { tokenHint } from "../connections/tokens";
import { schema } from "../db";
import { refusedByUnique } from "../db/query-failure";
import { appOrigin } from "../origin";
import { sealerForWrite } from "../primary-key";
import { isSealer } from "../secrets";
import { parseTrackAddress } from "./address";
import { sourceKeyPlace, trackDigest } from "./key";
import { reportAfterChange } from "./report";

export const adminRoles = MEMBER_ROLES.filter(isAdminRole);
const roleParameters = adminRoles.map(() => "?").join(",");

function refuse(error: string, status = 400) {
	return Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });
}

export function owned(workspaceId: string, id: string) {
	const { connection } = schema;
	return db
		.select({ name: connection.name })
		.from(connection)
		.where(and(eq(connection.organizationId, workspaceId), eq(connection.id, id)))
		.get();
}

function installedGeneration(workspace: string, id: string, generation: string) {
	const { trackSource, connection } = schema;
	return db
		.select({ id: connection.id })
		.from(trackSource)
		.innerJoin(connection, eq(connection.id, trackSource.connectionId))
		.where(
			and(
				eq(connection.organizationId, workspace),
				eq(connection.id, id),
				eq(trackSource.generation, generation),
			),
		);
}

/** Pending approvals can disappear. An exchange keeps its row to undo its own source. */
export function supersedeApprovals(workspace: string, connection?: string, applied?: SQL) {
	const attempts = schema.trackConnect;
	const scope = and(
		eq(attempts.organizationId, workspace),
		connection === undefined ? undefined : eq(attempts.connectionId, connection),
		applied,
	);
	return [
		db.delete(attempts).where(and(scope, eq(attempts.status, "pending"))),
		db
			.update(attempts)
			.set({ superseded: 1 })
			.where(and(scope, eq(attempts.status, "exchanging"))),
	] as const;
}

export async function sourceAddress(workspaceId: string, input?: string) {
	const { trackIntegration } = schema;
	const existing = await db
		.select({ address: trackIntegration.address })
		.from(trackIntegration)
		.where(eq(trackIntegration.organizationId, workspaceId))
		.get();
	const origin = appOrigin();
	const parsed = parseTrackAddress(input ?? existing?.address ?? "", origin);
	if (!parsed.ok) return parsed;
	const address = parsed.origin;
	if (!address.startsWith("https://"))
		return { ok: false, error: "Use an HTTPS origin for Track." } as const;
	if (existing && existing.address !== address)
		return { ok: false, error: "Use this workspace's Track address." } as const;
	return parsed;
}

export async function saveSource(
	workspaceId: string,
	userId: string,
	action: Extract<TrackActionInput, { action: "source" }>,
	stateHash?: string,
) {
	const id = action.connectionId;
	if (!(await owned(workspaceId, id))) return refuse("Not found", 404);
	const parsed = await sourceAddress(workspaceId, action.address);
	if (!parsed.ok) return refuse(parsed.error);
	const address = parsed.origin;
	const origin = appOrigin();
	const sealer = await sealerForWrite(db, env, workspaceId);
	if (!isSealer(sealer)) return refuse(sealer.unavailable);
	const sealed = await sealer.seal(sourceKeyPlace(id), action.key);
	const digest = await trackDigest(action.key);
	const generation = crypto.randomUUID();
	const client = db.$client;
	// Both writes see the same attempt and membership in D1's atomic batch.
	const allowed = stateHash
		? ` AND EXISTS (SELECT 1 FROM track_connect a
		JOIN member m ON m.organization_id=a.organization_id AND m.user_id=a.user_id
		WHERE a.state_hash=? AND a.organization_id=? AND a.connection_id=? AND a.user_id=?
		AND a.status='exchanging' AND a.superseded=0 AND m.role IN (${roleParameters}))`
		: "";
	const params = stateHash ? [stateHash, workspaceId, id, userId, ...adminRoles] : [];
	try {
		const [, saved, , completed] = await client.batch([
			client
				.prepare(`INSERT INTO track_integration (organization_id,address,workspace_slug,team_key,key_sealed,key_hint,added_by,added_at,source_mode)
				SELECT ?,?,'','','','',?,?,1 WHERE EXISTS (SELECT 1 FROM connection WHERE id=? AND organization_id=?)${allowed} ON CONFLICT(organization_id) DO UPDATE SET
				source_mode=1,key_sealed='',key_hint='',fix_label=NULL WHERE address=excluded.address`)
				.bind(workspaceId, address, userId, Date.now(), id, workspaceId, ...params),
			client
				.prepare(`INSERT INTO track_source (connection_id,key_sealed,key_hint,key_digest,generation,guard_origin)
				SELECT id,?,?,?,?,? FROM connection WHERE id=? AND organization_id=? AND EXISTS (SELECT 1 FROM track_integration WHERE organization_id=? AND source_mode=1 AND address=?)${allowed}
				ON CONFLICT(connection_id) DO UPDATE SET key_sealed=excluded.key_sealed,key_hint=excluded.key_hint,
				key_digest=excluded.key_digest,generation=excluded.generation,guard_origin=excluded.guard_origin,
				last_answer=NULL,answered_at=NULL,first_missing_at=NULL,stopped=0,retry_at=NULL,lease=NULL,lease_until=NULL
                 WHERE key_digest <> excluded.key_digest`)
				.bind(
					sealed,
					tokenHint(action.key),
					digest,
					generation,
					origin,
					id,
					workspaceId,
					workspaceId,
					address,
					...params,
				),
			client
				.prepare(`UPDATE finding SET source_rejected=NULL,
				source_unconfirmed=CASE WHEN source_state IS NOT NULL THEN 1 ELSE source_unconfirmed END
				WHERE organization_id=? AND connection_id=? AND track_state IS NULL AND EXISTS
				(SELECT 1 FROM track_source WHERE connection_id=? AND generation=?)`)
				.bind(workspaceId, id, id, generation),
			...(stateHash
				? [
						client
							.prepare(`UPDATE track_connect SET status='saved',expires_at=?,undo_until=NULL,undo_sealed=NULL,verifier_sealed=NULL WHERE organization_id=? AND state_hash=? AND connection_id=? AND status='exchanging' AND EXISTS
				(SELECT 1 FROM track_source s JOIN connection c ON c.id=s.connection_id
				JOIN track_integration t ON t.organization_id=c.organization_id
				WHERE c.organization_id=? AND s.connection_id=? AND s.key_digest=? AND t.address=? AND t.source_mode=1)`)
							.bind(
								Date.now() + 86_400_000,
								workspaceId,
								stateHash,
								id,
								workspaceId,
								id,
								digest,
								address,
							),
					]
				: supersedeApprovals(
						workspaceId,
						id,
						exists(installedGeneration(workspaceId, id, generation)),
					).map((query) => {
						const { sql, params } = query.toSQL();
						return client.prepare(sql).bind(...params);
					})),
		]);
		if (!saved?.meta.changes) {
			if (stateHash && completed?.meta.changes)
				return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
			return refuse("Paste a new source key and check the workspace's Track address.", 409);
		}
	} catch (error) {
		if (refusedByUnique(error, "track_source.key_digest"))
			return refuse("Use a separate Track source for each connection.", 409);
		throw error;
	}
	await reportAfterChange(db, env, id, 0);
	return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
