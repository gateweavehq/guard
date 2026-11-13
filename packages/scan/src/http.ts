import type { z } from "zod";
import { UpstreamError, type UpstreamFailure, type UpstreamService } from "./errors";

export interface FetchOptions {
	/** Stands in for the global fetch, in tests. */
	fetch?: typeof fetch;
	signal?: AbortSignal;
	/**
	 * Where each service is reached, when it is not at its own host: for tests and mirrors. A
	 * service left out is reached at the real one. Each is the API's base, as the default constants
	 * in `cloudflare.ts`, `github.ts` and `osv.ts` are.
	 */
	apiUrls?: Partial<Record<UpstreamService, string>>;
}

/** The base address of a service's API, without a trailing slash. */
export function apiBase(options: FetchOptions, service: UpstreamService, fallback: string): string {
	return (options.apiUrls?.[service] || fallback).replace(/\/+$/, "");
}

function failureFor(status: number): UpstreamFailure {
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	if (status === 404) return "not_found";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "unavailable";
	return "invalid_response";
}

/** Seconds from a Retry-After header, which is either a number of seconds or an HTTP date. */
export function retryAfterSeconds(response: Response): number | null {
	const value = response.headers.get("retry-after");
	if (value === null || value.trim() === "") return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
	const date = Date.parse(value);
	return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/**
 * Sends a request and returns the response when it succeeded. A failure becomes an
 * {@link UpstreamError} that keeps the status and nothing of the body, so a token echoed back by
 * a misbehaving proxy cannot reach a log. `classify` lets a service read its own signals first,
 * such as GitHub's rate-limit headers on a 403.
 */
export async function send(
	service: UpstreamService,
	url: string,
	init: RequestInit,
	options: FetchOptions,
	classify?: (response: Response) => UpstreamError | null,
): Promise<Response> {
	const fetcher = options.fetch ?? fetch;
	let response: Response;
	try {
		response = await fetcher(url, { ...init, signal: options.signal });
	} catch (error) {
		if (options.signal?.aborted) throw error;
		throw new UpstreamError(service, "unavailable", `${service} could not be reached`, {
			cause: error,
		});
	}
	if (response.ok) return response;
	await response.body?.cancel();
	const special = classify?.(response);
	if (special) throw special;
	throw new UpstreamError(
		service,
		failureFor(response.status),
		`${service} answered ${response.status}`,
		{
			status: response.status,
			retryAfterSeconds: retryAfterSeconds(response),
		},
	);
}

/** Reads a successful response as JSON and checks it against `schema`. */
export async function readJson<T>(
	service: UpstreamService,
	response: Response,
	schema: z.ZodType<T>,
): Promise<T> {
	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		throw new UpstreamError(
			service,
			"invalid_response",
			`${service} sent a body that is not JSON`,
			{
				status: response.status,
				cause: error,
			},
		);
	}
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		throw new UpstreamError(service, "invalid_response", `${service} sent an unexpected answer`, {
			status: response.status,
			cause: parsed.error,
		});
	}
	return parsed.data;
}
