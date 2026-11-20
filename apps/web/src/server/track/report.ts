import { and, eq, isNull, or, sql } from "drizzle-orm";
import { type Database, schema } from "../db";
import { isSealer, sealerFor } from "../secrets";
import type { SecretsKeySettings } from "../secrets-key";
import { sourceKeyPlace } from "./key";
import { eventBody, postEvent, type SignalState } from "./source-event";

const { trackSource: source, trackIntegration, organization, connection, finding } = schema;
const state = sql<SignalState>`CASE WHEN ${finding.dismissedAt} IS NOT NULL THEN 'dismissed'
	WHEN ${finding.resolvedAt} IS NOT NULL THEN 'cleared' ELSE 'open' END`;

function nextFinding(db: Database, id: string) {
	return db
		.select()
		.from(finding)
		.where(
			and(
				eq(finding.connectionId, id),
				isNull(finding.trackState),
				sql`(${finding.sourceUnconfirmed} = 1 OR (
			(${finding.sourceState} IS NOT NULL OR ${state} = 'open')
			AND (${finding.sourceState} IS NOT ${state} OR ${finding.sourceSeverity} IS NOT ${finding.severity})
			AND ${finding.sourceRejected} IS NOT (${state} || '/' || ${finding.severity})
		))`,
			),
		)
		.orderBy(
			sql`CASE ${finding.severity} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
			finding.id,
		)
		.limit(1)
		.get();
}

/** Each scan or dismissal drains current observations. A lease serializes overlapping callers. */
export async function reportFindings(
	db: Database,
	settings: SecretsKeySettings,
	id: string,
	observedAt: number,
) {
	const owner = crypto.randomUUID();
	const now = Date.now();
	const mine = and(eq(source.connectionId, id), eq(source.lease, owner));
	const claim = await db
		.update(source)
		.set({ lease: owner, leaseUntil: now + 60_000 })
		.where(
			and(
				eq(source.connectionId, id),
				eq(source.stopped, 0),
				or(isNull(source.retryAt), sql`${source.retryAt} <= ${now}`),
				or(isNull(source.leaseUntil), sql`${source.leaseUntil} <= ${now}`),
			),
		)
		.returning()
		.get();
	if (!claim) return;
	try {
		const target = await db
			.select({ id: organization.id, slug: organization.slug, address: trackIntegration.address })
			.from(connection)
			.innerJoin(organization, eq(organization.id, connection.organizationId))
			.innerJoin(trackIntegration, eq(trackIntegration.organizationId, organization.id))
			.where(eq(connection.id, id))
			.get();
		if (!target) return;
		const sealer = await sealerFor(settings, target.id);
		let key: string;
		try {
			if (!isSealer(sealer)) throw new Error();
			key = await sealer.open(sourceKeyPlace(id), claim.keySealed);
		} catch {
			await db.update(source).set({ lastAnswer: "unreadable", answeredAt: Date.now() }).where(mine);
			return;
		}
		let calls = claim.calls;
		for (let attempts = 0; attempts < 60; attempts++) {
			const row = await nextFinding(db, id);
			if (!row) return;
			const time = Date.now();
			calls = calls.filter((at) => at > time - 60_000);
			if (calls.length >= 60) return;
			const current = row.dismissedAt ? "dismissed" : row.resolvedAt ? "cleared" : "open";
			const sentAt = Math.max(
				observedAt,
				row.sourceChangedAt ?? 0,
				row.lastSeenAt.getTime(),
				row.resolvedAt?.getTime() ?? 0,
				(row.sourceAttemptAt ?? 0) + 1,
			);
			const body = eventBody(
				row,
				current,
				sentAt,
				`${claim.guardOrigin}/${encodeURIComponent(target.slug)}/findings#finding-${row.id}`,
			);
			const owns = sql`EXISTS (SELECT 1 FROM ${source} WHERE ${mine})`;
			const sameFinding = and(eq(finding.id, row.id), owns);
			if (body !== null) calls.push(time);
			// Persist uncertainty before the fetch. A lost isolate can leave no other acknowledgement.
			const [reservation] = await db.batch([
				db
					.update(source)
					.set({ calls, leaseUntil: time + 60_000 })
					.where(mine),
				db
					.update(finding)
					.set({ sourceUnconfirmed: 1, sourceAttemptAt: sentAt })
					.where(sameFinding),
			]);
			if (!reservation.meta.changes) return;
			const reply =
				body === null ? { status: "400" as const } : await postEvent(target.address, key, body);
			const answeredAt = Date.now();
			const note: Partial<typeof source.$inferInsert> = { lastAnswer: reply.status, answeredAt };
			let receipt: Partial<typeof finding.$inferInsert>;
			if ("issue" in reply && reply.status === "200") {
				note.firstMissingAt = null;
				claim.firstMissingAt = null;
				receipt = {
					sourceState: current,
					sourceSeverity: row.severity,
					sourceRejected: null,
					sourceUnconfirmed: 0,
					trackIssueKey: reply.issue?.key ?? null,
					trackIssueUrl: reply.issue?.url ?? null,
				};
			} else if (reply.status === "400") {
				console.warn("Track refused finding", row.id);
				receipt = {
					sourceRejected: `${current}/${row.severity}`,
					sourceUnconfirmed: 0,
				};
			} else {
				if ("delay" in reply && reply.delay) note.retryAt = answeredAt + reply.delay;
				if (reply.status === "404") {
					note.firstMissingAt = claim.firstMissingAt ?? answeredAt;
					note.stopped = Number(answeredAt - note.firstMissingAt >= 7 * 86_400_000);
				}
				await db.update(source).set(note).where(mine);
				return;
			}
			await db.batch([
				db.update(finding).set(receipt).where(sameFinding),
				db.update(source).set(note).where(mine),
			]);
		}
	} finally {
		await db.update(source).set({ lease: null, leaseUntil: null }).where(mine);
	}
}

/** A delivery failure cannot undo a recorded scan or a person's dismissal. */
export async function reportAfterChange(...args: Parameters<typeof reportFindings>) {
	try {
		await reportFindings(...args);
	} catch {
		console.error("Track delivery could not be recorded");
	}
}
