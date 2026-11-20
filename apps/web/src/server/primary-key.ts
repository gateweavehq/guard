import { type Database, schema } from "./db";
import { isSealer, sealerFor } from "./secrets";
import type { SecretsKeySettings } from "./secrets-key";

export async function observePrimary(db: Database, primary: string, previous: string | null) {
	// Key ids are base64url, so a dot separates the pair unambiguously.
	const keyId = `${primary}.${previous ?? "none"}`;
	const firstSeen = Date.now();
	await db.insert(schema.secretsPrimary).values({ keyId, firstSeen }).onConflictDoNothing();
	return keyId;
}

export async function sealerForWrite(
	db: Database,
	settings: SecretsKeySettings,
	workspace: string,
) {
	const sealer = await sealerFor(settings, workspace);
	if (isSealer(sealer)) await observePrimary(db, sealer.keyId, sealer.previousId);
	return sealer;
}
