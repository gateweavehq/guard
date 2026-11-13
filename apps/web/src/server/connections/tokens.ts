import { isSealer, sealerFor } from "../secrets";
import type { SecretsKeySettings } from "../secrets-key";

/**
 * What a sealed token is bound to: its connection's id. A sealed value copied into another
 * connection's row, or another workspace's, does not open there. (A token's shape is checked at the
 * boundary, in `lib/connection-schemas.ts`.)
 */
export const tokenPlace = (connectionId: string) => `connection/${connectionId}/token`;

/** The last four characters of a token, which is all any page sees of it. */
export const tokenHint = (token: string) => token.slice(-4);

/** Why this server cannot keep tokens, or null when it can. */
export async function sealingProblem(
	settings: SecretsKeySettings,
	workspaceId: string,
): Promise<string | null> {
	const sealer = await sealerFor(settings, workspaceId);
	return isSealer(sealer) ? null : sealer.unavailable;
}
