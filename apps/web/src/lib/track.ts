import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { TrackActionInput, TrackIntegrationView } from "./track-schemas";

export * from "./track-schemas";

export const startTrackConnect = createServerFn({ method: "POST" })
	.validator(
		z.object({
			slug: z.string(),
			connectionId: z.string(),
			address: z.string().max(300).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { start } = await import("#/server/track/connect");
		return start(data.slug, data.connectionId, data.address);
	});

export const finishTrackConnect = createServerFn({ method: "POST" })
	.validator(
		z.object({
			slug: z.string(),
			state: z.string(),
			code: z.string().optional(),
			error: z.string().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { finish } = await import("#/server/track/connect");
		return finish(data.slug, data.state, data.code, data.error);
	});

/** The workspace's Track settings, or null when the caller is not in it. */
export const getTrack = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { listTrack } = await import("#/server/track/gateway");
		return listTrack(slug);
	});

export async function changeTrack(
	slug: string,
	action: TrackActionInput,
): Promise<{ ok: true; integration?: TrackIntegrationView | null } | { ok: false; error: string }> {
	try {
		const response = await fetch(`/api/track/${encodeURIComponent(slug)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(action),
		});
		return (await response.json()) as
			| { ok: true; integration?: TrackIntegrationView | null }
			| { ok: false; error: string };
	} catch {
		return { ok: false, error: "That didn't reach the server. Try again." };
	}
}

/**
 * A link to an issue in Track, when it is safe to put in a page: https, or http on this machine
 * for a Track run beside Guard. What was stored is not trusted to be one.
 */
export function safeTrackHref(url: string | null): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "https:") return parsed.href;
		const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
		return parsed.protocol === "http:" && local ? parsed.href : null;
	} catch {
		return null;
	}
}
