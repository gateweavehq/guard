export type UpstreamService = "cloudflare" | "github" | "osv";

/**
 * Why a call to a connected account or to OSV failed. The first three mean the connection needs
 * someone's attention (a revoked token, a missing permission, a deleted repository) and retrying
 * will not help; the next two pass with time; the last means the answer was not what the API
 * documents, which is a bug here or a change there.
 */
export type UpstreamFailure =
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "rate_limited"
	| "unavailable"
	| "invalid_response";

export class UpstreamError extends Error {
	override readonly name = "UpstreamError";
	readonly service: UpstreamService;
	readonly failure: UpstreamFailure;
	/** The HTTP status, or null when the request never got one. */
	readonly status: number | null;
	/** How long the service asked us to wait, when it said. */
	readonly retryAfterSeconds: number | null;

	constructor(
		service: UpstreamService,
		failure: UpstreamFailure,
		message: string,
		options: { status?: number | null; retryAfterSeconds?: number | null; cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.service = service;
		this.failure = failure;
		this.status = options.status ?? null;
		this.retryAfterSeconds = options.retryAfterSeconds ?? null;
	}

	/** Whether the same request may succeed later without anyone changing anything. */
	get retryable(): boolean {
		return this.failure === "rate_limited" || this.failure === "unavailable";
	}
}

/** Thrown for a lockfile Guard cannot read, such as npm's version 1 or pnpm's version 5. */
export class UnsupportedLockfileError extends Error {
	override readonly name = "UnsupportedLockfileError";
}
