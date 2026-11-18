import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	type ConnectionActionInput,
	type FindingActionInput,
	FindingFilters,
	type ScanState,
	type ScanSummary,
} from "./connection-schemas";
import type { TrackLinkView } from "./track-schemas";

export * from "./connection-schemas";

/** The connections of the workspace with this slug, or null when the caller is not in it. */
export const getConnections = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { listConnections } = await import("#/server/connections/gateway");
		return listConnections(slug);
	});

/** The findings of the workspace with this slug, or null when the caller is not in it. */
export const getFindings = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), filters: FindingFilters }))
	.handler(async ({ data }) => {
		const { listFindings } = await import("#/server/connections/findings-gateway");
		return listFindings(data.slug, data.filters);
	});

/** The WAF and bot traffic of the workspace with this slug, or null when the caller is not in it. */
export const getTraffic = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { listTraffic } = await import("#/server/connections/traffic-gateway");
		return listTraffic(slug);
	});

/** What protects the workspace's Cloudflare zones, or null when the caller is not in it. */
export const getProtection = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { listProtection } = await import("#/server/connections/protection-gateway");
		return listProtection(slug);
	});

export type Answer<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function post<T>(url: string, body: unknown): Promise<Answer<T>> {
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return (await response.json()) as Answer<T>;
	} catch {
		return { ok: false, error: "That didn't reach the server. Try again." };
	}
}

export function changeConnections(slug: string, action: ConnectionActionInput) {
	return post<{ scan?: ScanSummary | null; scanState?: ScanState }>(
		`/api/connections/${encodeURIComponent(slug)}`,
		action,
	);
}

export function changeFindings(slug: string, action: FindingActionInput) {
	return post<{ track?: TrackLinkView; waiting?: boolean }>(
		`/api/findings/${encodeURIComponent(slug)}`,
		action,
	);
}
