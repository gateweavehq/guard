import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

export interface ConsentRequest {
	/** The app asking for access, as it named itself when it registered. */
	clientName: string;
	viewer: { email: string } | null;
}

/** What the consent page shows. Null when the client does not exist or was disabled. */
export const getConsentRequest = createServerFn({ method: "GET" })
	.validator(z.string().min(1).max(256))
	.handler(async ({ data: clientId }): Promise<ConsentRequest | null> => {
		const { getAuth } = await import("#/server/auth");
		const auth = getAuth();
		const headers = getRequestHeaders();
		const session = await auth.api.getSession({ headers });
		if (!session) return { clientName: "", viewer: null };
		try {
			const client = await auth.api.getOAuthClientPublic({
				query: { client_id: clientId },
				headers,
			});
			return {
				clientName: client.client_name?.trim() || "An unnamed app",
				viewer: { email: session.user.email },
			};
		} catch {
			return null;
		}
	});

/**
 * Where an app's grant goes, in terms a person can check: a loopback address is an app on their own
 * computer, anything else is its host. The consent page and the list of allowed assistants say it
 * the same way.
 */
export function redirectDestination(redirectUri: string | undefined): string {
	if (!redirectUri) return "the app";
	try {
		const url = new URL(redirectUri);
		if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
			return "an app on this computer";
		}
		return url.protocol === "https:" || url.protocol === "http:" ? url.host : url.protocol;
	} catch {
		return "the app";
	}
}
