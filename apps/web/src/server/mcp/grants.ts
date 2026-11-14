import {
	type AssistantGrant,
	firstRedirect,
	newestUseFirst,
	scopesInclude,
} from "../../lib/assistant-grants";
import { redirectDestination } from "../../lib/oauth";

/**
 * What a person allowed assistants to do, kept in Better Auth's `oauth_*` tables. Grants belong to
 * the person, not to a workspace. These functions never return a token: only the columns named
 * below are read.
 */

/** Every assistant this person allowed. Only theirs: `userId` is the session's, never a request's. */
export async function listGrants(d1: D1Database, userId: string): Promise<AssistantGrant[]> {
	const { results } = await d1
		.prepare(
			// A refresh marks the old token rotated at that moment and issues a new one, so the newest
			// rotation is when the app last came back, and nothing when it never did.
			`SELECT client.client_id, client.name, client.redirect_uris,
				consent.created_at, consent.updated_at,
				(SELECT MAX(token.rotated_at) FROM oauth_refresh_token token
					WHERE token.user_id = ?1 AND token.client_id = client.client_id) AS last_used
			FROM oauth_consent consent
			JOIN oauth_client client ON client.client_id = consent.client_id
			WHERE consent.user_id = ?1`,
		)
		.bind(userId)
		.all<{
			client_id: string;
			name: string | null;
			redirect_uris: unknown;
			created_at: number;
			updated_at: number;
			last_used: number | null;
		}>();
	const byClient = new Map<string, AssistantGrant>();
	for (const row of results) {
		const allowedAt = Math.max(row.created_at, row.updated_at);
		const known = byClient.get(row.client_id);
		if (known && known.allowedAt >= allowedAt) continue;
		byClient.set(row.client_id, {
			clientId: row.client_id,
			name: row.name?.trim() || null,
			destination: redirectDestination(firstRedirect(row.redirect_uris)),
			allowedAt,
			lastUsedAt: row.last_used,
		});
	}
	return newestUseFirst([...byClient.values()]);
}

/**
 * Ends this person's grant to this app, at once and in one batch, so nothing is left half done:
 * its refresh tokens (which take their access tokens along), any access token left, and the
 * consent that `/mcp` checks on every call. Another person's grant to the same app stays. False,
 * with nothing deleted, when the person never allowed it, exactly as for an app that is not there.
 */
export async function takeBack(d1: D1Database, userId: string, clientId: string): Promise<boolean> {
	const allowed = await d1
		.prepare("SELECT 1 AS found FROM oauth_consent WHERE user_id = ?1 AND client_id = ?2 LIMIT 1")
		.bind(userId, clientId)
		.first();
	if (!allowed) return false;
	await d1.batch([
		d1
			.prepare("DELETE FROM oauth_refresh_token WHERE user_id = ?1 AND client_id = ?2")
			.bind(userId, clientId),
		d1
			.prepare("DELETE FROM oauth_access_token WHERE user_id = ?1 AND client_id = ?2")
			.bind(userId, clientId),
		d1
			.prepare("DELETE FROM oauth_consent WHERE user_id = ?1 AND client_id = ?2")
			.bind(userId, clientId),
	]);
	return true;
}

/**
 * Whether this person still lets this app use `scope`. `/mcp` asks on every call, because an access
 * token is a signed JWT that stays valid for an hour whatever happens in D1. One read, on
 * `oauthConsent_userId_idx`: a person has a handful of consents.
 */
export async function grantExists(
	d1: D1Database,
	userId: string,
	clientId: string,
	scope: string,
): Promise<boolean> {
	const { results } = await d1
		.prepare("SELECT scopes FROM oauth_consent WHERE user_id = ?1 AND client_id = ?2")
		.bind(userId, clientId)
		.all<{ scopes: unknown }>();
	return results.some((row) => scopesInclude(row.scopes, scope));
}
