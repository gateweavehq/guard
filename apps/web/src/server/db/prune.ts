import { type Column, inArray, lt } from "drizzle-orm";
import type { Database } from "./index";
import { schema } from "./index";

/** D1 runs one query at a time, so one long delete would hold up everyone signing in. */
const BATCH = 1000;

async function pruneOlder(
	db: Database,
	table:
		| typeof schema.session
		| typeof schema.verification
		| typeof schema.oauthRefreshToken
		| typeof schema.oauthAccessToken
		| typeof schema.oauthClientAssertion
		| typeof schema.invitation,
	column: Column,
	before: Date,
) {
	for (;;) {
		const expired = db.select({ id: table.id }).from(table).where(lt(column, before)).limit(BATCH);
		const { meta } = await db.delete(table).where(inArray(table.id, expired)).run();
		if (meta.changes < BATCH) return;
	}
}

/**
 * Anyone can register an OAuth client, so apps that registered themselves (no user) and were never
 * allowed would pile up. After a day with no consent and no live refresh token, one is nobody's:
 * its `oauth_client_resource` rows go with it. A client someone still allows, or whose refresh
 * token still works, is never touched. Run after the expired tokens are gone.
 */
async function pruneUnusedClients(db: Database, now: Date) {
	await db.$client
		.prepare(
			`DELETE FROM oauth_client
			WHERE user_id IS NULL AND created_at < ?1
				AND NOT EXISTS (SELECT 1 FROM oauth_consent WHERE oauth_consent.client_id = oauth_client.client_id)
				AND NOT EXISTS (
					SELECT 1 FROM oauth_refresh_token token
					WHERE token.client_id = oauth_client.client_id AND token.expires_at > ?2
				)`,
		)
		.bind(now.getTime() - 24 * 60 * 60 * 1000, now.getTime())
		.run();
}

/**
 * Deletes what is past its time. Better Auth removes a session or a verification only when something
 * looks it up, so those nobody comes back for would otherwise stay forever: a session holds the
 * address and browser it came from, a verification an abandoned sign-up's code, an assistant's token the
 * person who approved it, and an invitation an address that may never have had anything to do with
 * this deployment. The privacy policy states
 * these, so a change here is a change to it.
 */
export async function pruneExpired(db: Database): Promise<void> {
	const now = new Date();
	await pruneOlder(db, schema.session, schema.session.expiresAt, now);
	await pruneOlder(db, schema.verification, schema.verification.expiresAt, now);
	// Refresh tokens first, because deleting one takes the access tokens made from it along.
	await pruneOlder(db, schema.oauthRefreshToken, schema.oauthRefreshToken.expiresAt, now);
	await pruneOlder(db, schema.oauthAccessToken, schema.oauthAccessToken.expiresAt, now);
	await pruneUnusedClients(db, now);
	await pruneOlder(db, schema.oauthClientAssertion, schema.oauthClientAssertion.expiresAt, now);
	await pruneOlder(db, schema.invitation, schema.invitation.expiresAt, now);
	// Only the alerts' hourly limit and the digest's week look at these, and both look back days.
	await db.$client
		.prepare("DELETE FROM notification_log WHERE sent_at < ?1")
		.bind(now.getTime() - 90 * 24 * 60 * 60 * 1000)
		.run();
}
