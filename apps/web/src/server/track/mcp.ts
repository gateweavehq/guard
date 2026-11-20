import type { z } from "zod";

/**
 * A small client for Gateweave Track's MCP server, over Streamable HTTP: `initialize`, the
 * `initialized` notification and `tools/call`, with the agent member's key as a bearer token.
 *
 * It is written here rather than taken from `@modelcontextprotocol/client` because Guard needs
 * three tool calls and that package is 7 MB of unpacked code for stdio, OAuth and browsers that a
 * Worker never runs. What it keeps from a real client: a timeout on every request, a cap on what
 * it reads, results checked with zod before anything uses them, and no redirect followed, so the
 * key never goes anywhere the admin did not name.
 */

/** Why a call to Track failed, in the terms the UI has one sentence for. */
export type TrackFailure =
	/** Track answered 401 or 403: the key was revoked, or its agent deleted. */
	| "unauthorized"
	/** Nothing at that address answers as Track's MCP server does. */
	| "not_mcp"
	/** The call reached a tool, which refused with a message of its own. */
	| "tool_error"
	/** No answer: DNS, the connection, a timeout or a server error. */
	| "unreachable"
	/** An answer that is not what Track sends. */
	| "invalid_response";

export class TrackError extends Error {
	constructor(
		readonly failure: TrackFailure,
		message: string = failure,
	) {
		super(message);
		this.name = "TrackError";
	}
}

export interface TrackEndpoint {
	/** Track's origin, as `parseTrackAddress` made it. */
	address: string;
	key: string;
}

export interface TrackClientOptions {
	/** Defaults to the global `fetch`. */
	fetcher?: typeof fetch;
	timeoutMs?: number;
}

export const TRACK_TIMEOUT_MS = 10_000;
/** The most of an answer Guard reads. A real one is a few kilobytes. */
const MAX_ANSWER_BYTES = 1_000_000;
const PROTOCOL_VERSION = "2025-06-18";
/** What Track says in a refusal is shown to people, so it is kept short. */
const MAX_MESSAGE = 300;

interface RpcMessage {
	id?: unknown;
	result?: unknown;
	error?: { message?: unknown };
}

/** The first line of a tool's own words, cut to a length a sentence can carry. */
const brief = (text: string) => {
	const line = text.trim().split("\n", 1)[0] ?? "";
	return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line;
};

export async function readCapped(response: Response, limit = MAX_ANSWER_BYTES): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > limit) {
			await reader.cancel();
			throw new TrackError("invalid_response", "Track's answer was too large");
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

/** The JSON-RPC message with this id in a body that is JSON or a Server-Sent Events stream. */
export function messageIn(body: string, contentType: string, id: number): RpcMessage | null {
	const candidates: unknown[] = [];
	if (contentType.includes("text/event-stream")) {
		for (const event of body.split(/\r?\n\r?\n/)) {
			const data = event
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /, ""))
				.join("\n");
			if (!data) continue;
			try {
				candidates.push(JSON.parse(data));
			} catch {
				// A comment or a keep-alive: not the answer.
			}
		}
	} else {
		try {
			const parsed: unknown = JSON.parse(body);
			candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
		} catch {
			return null;
		}
	}
	for (const candidate of candidates) {
		if (typeof candidate === "object" && candidate !== null && "id" in candidate) {
			if ((candidate as RpcMessage).id === id) return candidate as RpcMessage;
		}
	}
	return null;
}

/** One conversation with Track's MCP server. It starts on the first call. */
export class TrackSession {
	readonly #endpoint: TrackEndpoint;
	readonly #fetcher: typeof fetch;
	readonly #timeoutMs: number;
	#nextId = 1;
	#started: Promise<void> | null = null;
	#initialized = false;
	#sessionId: string | null = null;
	#protocolVersion = PROTOCOL_VERSION;

	constructor(endpoint: TrackEndpoint, options: TrackClientOptions = {}) {
		this.#endpoint = endpoint;
		this.#fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
		this.#timeoutMs = options.timeoutMs ?? TRACK_TIMEOUT_MS;
	}

	async #post(body: unknown): Promise<Response> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${this.#endpoint.key}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		if (this.#initialized) headers["mcp-protocol-version"] = this.#protocolVersion;
		if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
		let response: Response;
		try {
			response = await this.#fetcher(`${this.#endpoint.address}/mcp`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				redirect: "manual",
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch {
			throw new TrackError("unreachable");
		}
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel();
			throw new TrackError("unauthorized");
		}
		if (response.status >= 500 || response.status === 429) {
			await response.body?.cancel();
			throw new TrackError("unreachable");
		}
		// A redirect, a 404 or a 405: something is there, and it is not Track's MCP endpoint.
		if (!response.ok) {
			await response.body?.cancel();
			throw new TrackError("not_mcp");
		}
		return response;
	}

	async #rpc(method: string, params: unknown): Promise<unknown> {
		const id = this.#nextId++;
		const response = await this.#post({ jsonrpc: "2.0", id, method, params });
		const session = response.headers.get("mcp-session-id");
		if (session) this.#sessionId = session;
		let text: string;
		try {
			text = await readCapped(response);
		} catch (error) {
			if (error instanceof TrackError) throw error;
			throw new TrackError("unreachable");
		}
		const message = messageIn(text, response.headers.get("content-type") ?? "", id);
		if (!message) throw new TrackError("invalid_response", "No answer to the request");
		if (message.error) {
			const said = typeof message.error.message === "string" ? message.error.message : "";
			throw new TrackError("invalid_response", brief(said) || "Track refused the request");
		}
		return message.result;
	}

	/** A start that failed is not retried by the next call: a session is for one task. */
	#start(): Promise<void> {
		this.#started ??= (async () => {
			const result = await this.#rpc("initialize", {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "gateweave-guard", version: "1.0.0" },
			});
			const version =
				typeof result === "object" && result !== null && "protocolVersion" in result
					? (result as { protocolVersion: unknown }).protocolVersion
					: null;
			if (typeof version !== "string") {
				throw new TrackError("invalid_response", "Track did not say which protocol it speaks");
			}
			this.#protocolVersion = version;
			this.#initialized = true;
			const response = await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" });
			await response.body?.cancel();
		})();
		return this.#started;
	}

	/**
	 * Calls a tool and returns its structured result, checked against `schema`. A tool that refuses
	 * throws a `tool_error` with its message.
	 */
	async call<S extends z.ZodType>(
		tool: string,
		args: Record<string, unknown>,
		schema: S,
	): Promise<z.output<S>> {
		await this.#start();
		const result = await this.#rpc("tools/call", { name: tool, arguments: args });
		if (typeof result !== "object" || result === null) {
			throw new TrackError("invalid_response", "A tool answered with nothing");
		}
		const { isError, structuredContent, content } = result as {
			isError?: unknown;
			structuredContent?: unknown;
			content?: unknown;
		};
		const text = Array.isArray(content)
			? content
					.map((part) =>
						typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
					)
					.join("\n")
			: "";
		if (isError === true) throw new TrackError("tool_error", brief(text) || "Track refused it");
		let value = structuredContent;
		if (value === undefined) {
			try {
				value = JSON.parse(text);
			} catch {
				throw new TrackError("invalid_response", "A tool's answer was not JSON");
			}
		}
		const parsed = schema.safeParse(value);
		if (!parsed.success) {
			throw new TrackError("invalid_response", "A tool's answer had an odd shape");
		}
		return parsed.data;
	}
}
