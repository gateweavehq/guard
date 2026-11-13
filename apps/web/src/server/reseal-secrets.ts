import { and, eq, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { tokenPlace } from "./connections/tokens";
import type { Database } from "./db";
import { schema } from "./db";
import { isSealer, type Sealer, sealerFor } from "./secrets";
import { type SecretsKeySettings, secretsKeys } from "./secrets-key";

/**
 * Seals workspaces' secrets in D1 again under the current `SECRETS_KEY`, from the daily run: after
 * the key changed, with the old one kept as `SECRETS_KEY_PREVIOUS`, and for values sealed before
 * keys had ids. Each value is opened, sealed under the current key and written back only if it is
 * still the one that was read, so a token replaced meanwhile is left as it now is. Ported from
 * Gateweave Mail, where it seals more than one kind of secret; Guard has one, a connection's token.
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
}

/** What this run did, or null when the deployment has no current key to seal with. */
export async function resealSecrets(
	db: Database,
	settings: SecretsKeySettings,
): Promise<SecretsResealed | null> {
	const keys = await secretsKeys(settings);
	if (!keys.current) return null;
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
	const done: SecretsResealed = { resealed: 0, unopened: 0, left: 0 };
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

	const left = await db
		.select({ count: sql<number>`count(*)` })
		.from(connection)
		.where(notCurrent(connection.tokenSealed))
		.get();
	done.left = left?.count ?? 0;
	return done;
}
