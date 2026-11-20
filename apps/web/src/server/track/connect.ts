import { env } from "cloudflare:workers";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { and, eq, exists, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { isAdminRole } from "../../lib/roles";
import { currentMember } from "../access";
import { db } from "../auth";
import { schema } from "../db";
import { appOrigin } from "../origin";
import { sealerForWrite } from "../primary-key";
import { isSealer, sealerFor, toBase64 } from "../secrets";
import { trackDigest } from "./key";
import { readCapped } from "./mcp";
import {
	adminRoles,
	owned,
	saveSource,
	sourceAddress,
	supersedeApprovals,
} from "./source-settings";

const attempts = schema.trackConnect;
const lifetime = 10 * 60_000;
const refused = { ok: false, error: "Track was not connected" } as const;

async function admin(slug: string) {
	if (getRequestHeaders().get("origin") !== appOrigin()) return null;
	const member = await currentMember(slug);
	return member && isAdminRole(member.membership.role) ? member : null;
}

export async function start(slug: string, id: string, input?: string) {
	const member = await admin(slug);
	if (!member) return refused;
	const workspace = member.membership.workspaceId;
	const connection = await owned(workspace, id);
	if (!connection) return refused;
	const track = await sourceAddress(workspace, input);
	if (!track.ok) return track;
	const origin = appOrigin();
	// Track accepts only HTTPS return addresses, including for a locally hosted Guard.
	if (!origin.startsWith("https://"))
		return { ok: false, error: "Connect Track needs an HTTPS address for Guard." } as const;
	const sealer = await sealerForWrite(db, env, workspace);
	if (!isSealer(sealer)) return refused;
	const state = toBase64(crypto.getRandomValues(new Uint8Array(32)));
	const verifier = toBase64(crypto.getRandomValues(new Uint8Array(32)));
	const stateHash = await trackDigest(state);
	// Compare the reply to the name sent, even if the connection is renamed during approval.
	const name = connection.name
		.trim()
		.slice(0, 64)
		.replace(/[\uD800-\uDBFF]$/u, "")
		.trimEnd();
	if (!name) return refused;
	const url = new URL("/connect/source", track.origin);
	url.search = new URLSearchParams({
		product: "guard",
		name,
		links: origin,
		return: `${origin}/${encodeURIComponent(slug)}/settings/track/connected`,
		state,
		challenge: await trackDigest(verifier),
	}).toString();
	await db.batch([
		...supersedeApprovals(workspace, id),
		db.insert(attempts).values({
			stateHash,
			connectionId: id,
			organizationId: workspace,
			userId: member.user.id,
			name,
			address: track.origin,
			status: "pending",
			expiresAt: Date.now() + lifetime,
			verifierSealed: await sealer.seal(`track-verifier:${stateHash}`, verifier),
		}),
	]);
	return { ok: true, url: url.href } as const;
}

function post(address: string, path: "exchange" | "undo", body: Record<string, string>) {
	return fetch(`${address}/api/connect/${path}`, {
		method: "POST",
		redirect: "manual",
		signal: AbortSignal.timeout(10_000),
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const undoToken = z.string().min(1).max(512);
const answerLimit = 16 * 1024;
const deadline = z.iso.datetime({ offset: true }).transform((value) => Date.parse(value));
const reply = z.object({
	sourceKey: z
		.string()
		.length(47)
		.regex(/^gws_[A-Za-z0-9_-]{43}$/),
	endpoint: z.string(),
	source: z.object({ id: z.string().min(1), name: z.string(), product: z.literal("guard") }),
	workspace: z.object({ id: z.string().min(1), name: z.string().min(1), slug: z.string().min(1) }),
	team: z.object({ id: z.string().min(1), name: z.string().min(1), key: z.string().min(1) }),
	undo: undoToken,
	undoUntil: deadline,
});

export async function finish(slug: string, state: string, code?: string, error?: string) {
	const member = await admin(slug);
	if (!member || !/^[A-Za-z0-9_-]{43}$/.test(state)) return refused;
	const workspace = member.membership.workspaceId;
	const stateHash = await trackDigest(state);
	const attempt = and(eq(attempts.stateHash, stateHash), eq(attempts.organizationId, workspace));
	const starter = and(attempt, eq(attempts.userId, member.user.id));
	const pending = () =>
		and(starter, eq(attempts.status, "pending"), gt(attempts.expiresAt, Date.now()));
	const row = await db.select().from(attempts).where(starter).get();
	if (!row?.verifierSealed || !(await owned(workspace, row.connectionId))) return refused;
	if (error === "denied" && code === undefined) {
		await db.delete(attempts).where(pending());
		return refused;
	}
	if (error !== undefined || !code || !/^[A-Za-z0-9_-]{43}$/.test(code)) return refused;
	const sealer = await sealerForWrite(db, env, workspace);
	if (!isSealer(sealer)) return refused;
	const membership = schema.member;
	const currentAdmin = db
		.select({ id: membership.id })
		.from(membership)
		.where(
			and(
				eq(membership.organizationId, workspace),
				eq(membership.userId, member.user.id),
				inArray(membership.role, adminRoles),
			),
		);
	const claimed = await db
		.update(attempts)
		.set({ status: "exchanging", expiresAt: Date.now() + lifetime })
		.where(and(pending(), exists(currentAdmin)))
		.returning({ hash: attempts.stateHash });
	if (!claimed.length) return refused;
	let keptToken = false;
	let recovery: Recovery | undefined;
	try {
		const verifier = await sealer.open(`track-verifier:${stateHash}`, row.verifierSealed);
		const response = await post(row.address, "exchange", { code, verifier });
		if (response.status !== 200) throw new Error();
		const body: unknown = JSON.parse(await readCapped(response, answerLimit));
		const token = z
			.object({
				undo: undoToken,
				undoUntil: z.unknown().optional(),
				sourceKey: z.unknown().optional(),
			})
			.parse(body);
		const until = deadline.safeParse(token.undoUntil);
		recovery = {
			issuedDigest: typeof token.sourceKey === "string" ? await trackDigest(token.sourceKey) : null,
			undoSealed: await sealer.seal(`track-undo:${stateHash}`, token.undo),
			undoUntil: until.success ? until.data : null,
		};
		const kept = await db
			.update(attempts)
			.set(recovery)
			.where(and(attempt, eq(attempts.status, "exchanging"), isNull(attempts.undoSealed)));
		keptToken = !!kept.meta.changes;
		if (!keptToken) throw new Error();
		const data = reply.parse(body);
		if (data.endpoint !== `${row.address}/api/events` || data.source.name !== row.name)
			throw new Error();
		const success = { ok: true, workspace: data.workspace.name, team: data.team.name } as const;
		try {
			const saved = await saveSource(
				workspace,
				member.user.id,
				{
					action: "source",
					connectionId: row.connectionId,
					address: row.address,
					key: data.sourceKey,
				},
				stateHash,
			);
			if (saved.ok) return success;
		} catch {
			// The commit may have succeeded even though D1 lost the acknowledgement.
			try {
				const remaining = await db
					.select({ status: attempts.status, superseded: attempts.superseded })
					.from(attempts)
					.where(attempt)
					.get();
				if (remaining?.status === "saved") return success;
				if (remaining?.status !== "exchanging" || remaining.superseded) return refused;
			} catch {
				return refused;
			}
		}
	} catch {
		// Even a reply that failed validation may have created a source.
	}
	if (recovery) {
		// A sweep may have removed an expired exchange before its answer arrived.
		// Restore only a cleanup job. A finish can never recreate its right to save.
		if (!keptToken) {
			const restored = await db
				.insert(attempts)
				.values({ ...row, ...recovery, status: "exchanging", superseded: 1, expiresAt: 0 })
				.onConflictDoUpdate({
					target: attempts.stateHash,
					set: recovery,
					setWhere: and(attempt, eq(attempts.status, "exchanging"), isNull(attempts.undoSealed)),
				});
			if (!restored.meta.changes) return refused;
		}
		await claimUndo(workspace, stateHash, recovery);
	} else {
		await db.delete(attempts).where(and(attempt, eq(attempts.status, "exchanging")));
	}
	return refused;
}

type Recovery = { issuedDigest: string | null; undoSealed: string; undoUntil: number | null };

async function claimUndo(workspace: string, hash: string, recovery?: Recovery) {
	const now = Date.now();
	const due = lte(attempts.expiresAt, now);
	const eligible = recovery
		? eq(attempts.status, "exchanging")
		: and(inArray(attempts.status, ["exchanging", "undoing"]), due);
	const [row] = await db
		.update(attempts)
		.set({ status: "undoing", lastTriedAt: now, expiresAt: now + lifetime })
		.where(
			and(
				eq(attempts.organizationId, workspace),
				eq(attempts.stateHash, hash),
				eligible,
				isNotNull(attempts.undoSealed),
			),
		)
		.returning();
	if (!row) return;
	const mine = and(
		eq(attempts.organizationId, row.organizationId),
		eq(attempts.stateHash, row.stateHash),
		eq(attempts.status, "undoing"),
		eq(attempts.expiresAt, row.expiresAt),
	);
	if (!row.undoSealed || (row.undoUntil !== null && row.undoUntil <= now)) {
		await db.delete(attempts).where(mine);
		return;
	}
	const { trackSource, connection, trackIntegration } = schema;
	if (
		row.issuedDigest &&
		(await db
			.select({ id: trackSource.connectionId })
			.from(trackSource)
			.innerJoin(connection, eq(connection.id, trackSource.connectionId))
			.innerJoin(trackIntegration, eq(trackIntegration.organizationId, connection.organizationId))
			.where(
				and(eq(trackSource.keyDigest, row.issuedDigest), eq(trackIntegration.address, row.address)),
			)
			.get())
	) {
		await db.delete(attempts).where(mine);
		return;
	}
	const sealer = await sealerFor(env, row.organizationId);
	if (!isSealer(sealer)) return;
	// Rotation may have resealed the stored token under a key this finishing isolate lacks.
	const undo = await sealer
		.open(`track-undo:${row.stateHash}`, recovery?.undoSealed ?? row.undoSealed)
		.catch(() => null);
	if (!undo) return;
	let status: number | null = null;
	let finished = false;
	try {
		// A racing paste would need the issued key, which Track gives only to Guard during exchange.
		const response = await post(row.address, "undo", { undo });
		status = response.status;
		finished =
			status === 200 ||
			(status === 400 &&
				z
					.object({ error: z.literal("invalid_undo") })
					.safeParse(JSON.parse(await readCapped(response, answerLimit))).success);
	} catch {
		// A timeout, oversized answer or network error leaves the job for another run.
	}
	if (finished) await db.delete(attempts).where(mine);
	else
		await db
			.update(attempts)
			.set({ undoAttempts: row.undoAttempts + 1, undoStatus: status, expiresAt: 0 })
			.where(mine);
}

export async function sweepConnect() {
	const now = Date.now();
	await db.delete(attempts).where(lte(attempts.undoUntil, now));
	const due = lte(attempts.expiresAt, now);
	await db.delete(attempts).where(and(eq(attempts.status, "saved"), due));
	await db
		.delete(attempts)
		.where(
			and(inArray(attempts.status, ["pending", "exchanging"]), due, isNull(attempts.undoSealed)),
		);
	const rows = await db
		.select({
			hash: attempts.stateHash,
			workspace: attempts.organizationId,
		})
		.from(attempts)
		.where(
			and(inArray(attempts.status, ["exchanging", "undoing"]), due, isNotNull(attempts.undoSealed)),
		)
		.orderBy(
			sql`${attempts.lastTriedAt} ASC NULLS FIRST`,
			sql`${attempts.undoUntil} IS NULL`,
			attempts.undoUntil,
			attempts.expiresAt,
			attempts.stateHash,
		)
		.limit(25);
	for (const row of rows) await claimUndo(row.workspace, row.hash);
}
