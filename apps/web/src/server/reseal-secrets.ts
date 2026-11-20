import { and, eq, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { tokenPlace } from "./connections/tokens";
import type { Database } from "./db";
import { schema } from "./db";
import { observePrimary } from "./primary-key";
import { isSealer, type Sealer, sealerFor } from "./secrets";
import { type SecretsKeySettings, secretsKeys } from "./secrets-key";
import { sourceKeyPlace, trackKeyPlace } from "./track/key";

/**
 * Seals workspaces' secrets in D1 again under the current `SECRETS_KEY`, from the daily run: after
 * the key changed, with the old one kept as `SECRETS_KEY_PREVIOUS`, and for values sealed before
 * keys had ids. Each value is opened, sealed under the current key and written back only if it is
 * still the one that was read, so a token replaced meanwhile is left as it now is. Guard rotates connection tokens, Track keys, and the verifier and undo token of an approval attempt.
 */

/** How many values one run seals again, at most. The next run takes the rest. */
export const RESEAL_SECRETS_BATCH = 500;
/** How many rows are read at a time. */
const PAGE = 100;

export interface SecretsResealed {
	/** Sealed again under the current key. */
	resealed: number;
	/** Open with neither key, so left as they are. */
	unopened: number;
	/** Still under another key after this run, those that don't open among them. */
	left: number;
	primary: string;
	previous: string | null;
	settled: boolean;
}

/** What this run did, or null when the deployment has no current key to seal with. */
export async function resealSecrets(
	db: Database,
	settings: SecretsKeySettings,
	startedAt = Date.now(),
): Promise<SecretsResealed | null> {
	const keys = await secretsKeys(settings);
	if (!keys.current) return null;
	const previous = keys.previous?.id ?? null;
	const pair = await observePrimary(db, keys.current.id, previous);
	const primary = await db
		.select()
		.from(schema.secretsPrimary)
		.where(eq(schema.secretsPrimary.keyId, pair))
		.get();
	const prefix = `v2.${keys.current.id}.`;
	// Not LIKE: a key id may hold `_`, which LIKE takes for any character.
	const notCurrent = (column: SQLWrapper): SQL =>
		sql`substr(${column}, 1, ${prefix.length}) <> ${prefix}`;
	const sealers = new Map<string, Promise<Sealer | null>>();
	const sealerOf = (workspaceId: string) => {
		let made = sealers.get(workspaceId);
		if (!made) {
			made = sealerFor(settings, workspaceId).then((one) => (isSealer(one) ? one : null));
			sealers.set(workspaceId, made);
		}
		return made;
	};
	const done: SecretsResealed = {
		primary: keys.current.id,
		previous,
		resealed: 0,
		unopened: 0,
		left: 0,
		settled: false,
	};
	/** Opens and seals one value again, or says it doesn't open. */
	const again = async (workspaceId: string, where: string, sealed: string) => {
		const sealer = await sealerOf(workspaceId);
		if (!sealer) return null;
		try {
			return await sealer.seal(where, await sealer.open(where, sealed));
		} catch {
			done.unopened++;
			return null;
		}
	};

	const { connection } = schema;
	// Read in pages after the last row seen, so values that don't open never hold up the rest.
	// `as`, so that the loop's own assignments are what TypeScript goes by.
	let after = null as string | null;
	while (done.resealed < RESEAL_SECRETS_BATCH) {
		const cursor = after;
		const rows = await db
			.select({
				id: connection.id,
				workspaceId: connection.organizationId,
				sealed: connection.tokenSealed,
			})
			.from(connection)
			.where(
				and(
					notCurrent(connection.tokenSealed),
					cursor ? sql`${connection.id} > ${cursor}` : undefined,
				),
			)
			.orderBy(connection.id)
			.limit(PAGE)
			.all();
		for (const row of rows) {
			if (done.resealed >= RESEAL_SECRETS_BATCH) break;
			after = row.id;
			const sealed = await again(row.workspaceId, tokenPlace(row.id), row.sealed);
			if (sealed === null) continue;
			const written = await db
				.update(connection)
				.set({ tokenSealed: sealed })
				.where(and(eq(connection.id, row.id), eq(connection.tokenSealed, row.sealed)))
				.returning({ id: connection.id })
				.all();
			done.resealed += written.length;
		}
		if (rows.length < PAGE) break;
	}

	// One Track key per workspace, so a page is the rest of them.
	const { trackIntegration } = schema;
	const trackRows = await db
		.select({
			workspaceId: trackIntegration.organizationId,
			sealed: trackIntegration.keySealed,
		})
		.from(trackIntegration)
		.where(and(eq(trackIntegration.sourceMode, 0), notCurrent(trackIntegration.keySealed)))
		.orderBy(trackIntegration.organizationId)
		.limit(Math.max(0, RESEAL_SECRETS_BATCH - done.resealed))
		.all();
	for (const row of trackRows) {
		const sealed = await again(row.workspaceId, trackKeyPlace(row.workspaceId), row.sealed);
		if (sealed === null) continue;
		const written = await db
			.update(trackIntegration)
			.set({ keySealed: sealed })
			.where(
				and(
					eq(trackIntegration.organizationId, row.workspaceId),
					eq(trackIntegration.keySealed, row.sealed),
				),
			)
			.returning({ id: trackIntegration.organizationId })
			.all();
		done.resealed += written.length;
	}

	const { trackSource } = schema;
	const sources = await db
		.select({
			id: trackSource.connectionId,
			workspaceId: connection.organizationId,
			sealed: trackSource.keySealed,
		})
		.from(trackSource)
		.innerJoin(connection, eq(trackSource.connectionId, connection.id))
		.where(notCurrent(trackSource.keySealed))
		.limit(Math.max(0, RESEAL_SECRETS_BATCH - done.resealed))
		.all();
	for (const row of sources) {
		const sealed = await again(row.workspaceId, sourceKeyPlace(row.id), row.sealed);
		if (sealed === null) continue;
		const written = await db
			.update(trackSource)
			.set({ keySealed: sealed })
			.where(and(eq(trackSource.connectionId, row.id), eq(trackSource.keySealed, row.sealed)));
		done.resealed += written.meta.changes;
	}

	const { trackConnect } = schema;
	for (const field of ["verifierSealed", "undoSealed"] as const) {
		const column = trackConnect[field];
		let after = null as string | null;
		while (done.resealed < RESEAL_SECRETS_BATCH) {
			const cursor: string | null = after;
			const rows = await db
				.select({
					hash: trackConnect.stateHash,
					workspace: trackConnect.organizationId,
					sealed: column,
				})
				.from(trackConnect)
				.where(
					and(notCurrent(column), cursor ? sql`${trackConnect.stateHash} > ${cursor}` : undefined),
				)
				.orderBy(trackConnect.stateHash)
				.limit(PAGE);
			for (const row of rows) {
				if (done.resealed >= RESEAL_SECRETS_BATCH) break;
				after = row.hash;
				if (row.sealed === null) continue;
				const place = field === "verifierSealed" ? "track-verifier" : "track-undo";
				const sealed = await again(row.workspace, `${place}:${row.hash}`, row.sealed);
				if (!sealed) continue;
				const written = await db
					.update(trackConnect)
					.set({ [field]: sealed })
					.where(
						and(
							eq(trackConnect.organizationId, row.workspace),
							eq(trackConnect.stateHash, row.hash),
							eq(column, row.sealed),
						),
					);
				done.resealed += written.meta.changes;
			}
			if (rows.length < PAGE) break;
		}
		const left = await db
			.select({ count: sql<number>`count(*)` })
			.from(trackConnect)
			.where(notCurrent(column))
			.get();
		done.left += left?.count ?? 0;
	}
	const [leftSources, leftConnections, leftTrack] = await Promise.all([
		db
			.select({ count: sql<number>`count(*)` })
			.from(trackSource)
			.where(notCurrent(trackSource.keySealed))
			.get(),
		db
			.select({ count: sql<number>`count(*)` })
			.from(connection)
			.where(notCurrent(connection.tokenSealed))
			.get(),
		db
			.select({ count: sql<number>`count(*)` })
			.from(trackIntegration)
			.where(and(eq(trackIntegration.sourceMode, 0), notCurrent(trackIntegration.keySealed)))
			.get(),
	]);
	done.left += (leftSources?.count ?? 0) + (leftConnections?.count ?? 0) + (leftTrack?.count ?? 0);
	done.settled =
		previous !== null &&
		done.resealed === 0 &&
		done.left === 0 &&
		!!primary &&
		primary.firstSeen <= startedAt - 3_600_000;
	return done;
}
