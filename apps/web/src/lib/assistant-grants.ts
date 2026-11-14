/** One assistant a person allowed, as the Settings page shows it. Never holds a token. */
export interface AssistantGrant {
	clientId: string;
	/** What the app called itself when it registered. Any app can call itself anything. */
	name: string | null;
	/** "an app on this computer", or the host it goes back to. */
	destination: string;
	allowedAt: number;
	/** About an hour accurate: each refresh makes a token, and the newest one is the last use. */
	lastUsedAt: number | null;
}

/** Newest use first, then newest allowed, so what is in use is at the top. */
export function newestUseFirst(grants: AssistantGrant[]): AssistantGrant[] {
	return grants.toSorted(
		(a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.allowedAt - a.allowedAt,
	);
}

/**
 * Better Auth writes its JSON columns through a JSON column type that itself stores JSON, so a list
 * comes back from D1 as a string holding a string holding the list. Reads through every layer.
 */
function jsonOf(stored: unknown): unknown {
	let value = stored;
	for (let layer = 0; layer < 3 && typeof value === "string"; layer++) {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return value;
}

/** Whether a stored scope list has this scope. Anything that is not a list allows nothing. */
export function scopesInclude(stored: unknown, scope: string): boolean {
	const scopes = jsonOf(stored);
	return Array.isArray(scopes) && scopes.includes(scope);
}

/** The first of an app's redirect addresses, which is where its grant goes. */
export function firstRedirect(stored: unknown): string | undefined {
	const uris = jsonOf(stored);
	const first = Array.isArray(uris) ? uris[0] : undefined;
	return typeof first === "string" ? first : undefined;
}
