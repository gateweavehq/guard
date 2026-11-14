import { createMcpHandler } from "@modelcontextprotocol/server";
import { createDpopReplayStore } from "better-auth/oauth2";
import type { JWTPayload } from "jose";
import { db, getAuth, mcpResource } from "../auth";
import { MCP_SCOPE } from "../auth/config";
import { changeFindingsAs, findingOf, findingsOf } from "../connections/findings-gateway";
import { connectionRefs, scanNow } from "../connections/gateway";
import { trafficActionsOf, trafficOf } from "../connections/traffic-gateway";
import { allowMcpCall } from "../rate-limit";
import { findMembership, listWorkspaces } from "../workspaces";
import { grantExists } from "./grants";
import { protectResource } from "./protect";
import { createGuardServer, type GuardAccess, type WorkspaceAccess } from "./tools";

const MCP_PATH = "/mcp";

export function isMcpRequest(url: URL): boolean {
	return url.pathname === MCP_PATH;
}

/**
 * Gateway for AI assistants. Like the pages' endpoints, it checks D1 membership on every call.
 *
 * An assistant authenticates with an OAuth access token issued by Guard's own authorization server
 * (Better Auth's MCP plugin), bound to this endpoint and scoped to `guard`, and acts as the person
 * who approved it, in every workspace they belong to. Session cookies are never accepted here, so a
 * web page cannot make a signed-in browser call it.
 */
export function handleMcpRequest(request: Request): Promise<Response> | Response {
	if (!protectedHandler) return Response.json({ error: "Not found" }, { status: 404 });
	return protectedHandler(request);
}

const protectedHandler = mcpResource ? protect(mcpResource) : null;

function protect(resource: string) {
	const mcpHandler = createMcpHandler(({ authInfo }) => {
		const userId = authInfo?.extra?.userId;
		// protectResource only lets verified tokens through, and they always carry both.
		if (typeof userId !== "string" || !authInfo?.clientId) {
			throw new Error("MCP request without verified credentials");
		}
		return createGuardServer(accessFor(userId));
	});

	const serve = async (request: Request, claims: JWTPayload, reject: () => Response) => {
		const clientId = typeof claims.azp === "string" ? claims.azp : claims.client_id;
		const userId = claims.sub;
		if (typeof userId !== "string" || typeof clientId !== "string") {
			return Response.json({ error: "Not found" }, { status: 404 });
		}
		// A token is a signed JWT that stays good for an hour whatever happens in D1, so what the
		// person can take back is checked here, in the same round trip as the rate limit.
		const [{ allowed, retryAfter }, granted] = await Promise.all([
			allowMcpCall(userId, clientId),
			grantExists(db.$client, userId, clientId, MCP_SCOPE),
		]);
		// As for an invalid token, so the assistant goes back to asking the person.
		if (!granted) return reject();
		if (!allowed) {
			return Response.json(
				{
					jsonrpc: "2.0",
					error: { code: -32000, message: "Too many requests. Slow down." },
					id: null,
				},
				{ status: 429, headers: { "Retry-After": String(retryAfter ?? 60) } },
			);
		}
		return mcpHandler.fetch(request, {
			authInfo: {
				token: request.headers.get("Authorization")?.replace(/^\S+\s+/, "") ?? "",
				clientId,
				scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
				expiresAt: claims.exp,
				resource: new URL(resource),
				extra: { userId },
			},
		});
	};

	// Built on the first request, once Better Auth's context has resolved. The handler itself is
	// kept rather than a promise of it, so no request waits on work another request started.
	let handler: ((request: Request) => Promise<Response>) | undefined;
	return async (request: Request) => {
		if (!handler) {
			const { baseURL, internalAdapter } = await getAuth().$context;
			handler = protectResource(
				{
					issuer: baseURL,
					resource,
					requiredScopes: [MCP_SCOPE],
					// offline_access lets clients refresh tokens instead of asking the person again.
					challengeScopes: [MCP_SCOPE, "offline_access"],
					jwks: () => getAuth().api.getJwks(),
					dpopReplayStore: createDpopReplayStore(internalAdapter),
				},
				serve,
			);
		}
		return handler(request);
	};
}

/**
 * What a token reaches: every workspace its person is in, each checked against D1 on every call.
 * What they do there goes through the functions the pages' endpoints use, once it is known who
 * is asking, so the roles and limits are the pages'.
 */
function accessFor(userId: string): GuardAccess {
	return {
		workspaces: () => listWorkspaces(db, userId),
		async workspace(slug) {
			const membership = await findMembership(db, slug, userId);
			if (!membership) return null;
			const member = { user: { id: userId }, membership };
			const access: WorkspaceAccess = {
				slug,
				role: membership.role,
				findings: async (filters, window) => findingsOf(member, filters, window),
				finding: (id) => findingOf(member, id),
				connections: () => connectionRefs(member),
				dismiss: (id, reason) => changeFindingsAs(member, slug, { action: "dismiss", id, reason }),
				scan: (connectionId) => scanNow(member, connectionId),
				traffic: async () => {
					const [page, actions] = await Promise.all([trafficOf(member), trafficActionsOf(member)]);
					return { page, actions };
				},
			};
			return access;
		},
	};
}
