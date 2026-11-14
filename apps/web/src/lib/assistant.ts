import { createServerFn } from "@tanstack/react-start";

/**
 * The address an AI assistant connects to, or null when this server cannot offer one: it needs
 * `BETTER_AUTH_URL`, so that the sign-in an assistant does ends where it started.
 */
export const getMcpAddress = createServerFn({ method: "GET" }).handler(async () => {
	const { mcpResource } = await import("#/server/auth");
	return mcpResource ?? null;
});

/** The one line that connects Claude Code to Guard. */
export function claudeCodeCommand(address: string): string {
	return `claude mcp add --transport http guard ${address}`;
}

/** The assistants the signed-in person allowed, newest use first. */
export const getGrants = createServerFn({ method: "GET" }).handler(async () => {
	const { grantsOfSession } = await import("#/server/mcp/grants-gateway");
	return grantsOfSession();
});

export async function takeBackGrant(
	clientId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const response = await fetch("/api/assistants", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientId }),
		});
		return (await response.json()) as { ok: true } | { ok: false; error: string };
	} catch {
		return { ok: false, error: "That didn't reach the server. Try again." };
	}
}
