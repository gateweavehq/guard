import { env } from "cloudflare:workers";
import { parseRepositoryName } from "@gateweave/guard-scan";
import { and, count, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import {
	ConnectionAction,
	type ConnectionsPage,
	type ConnectionView,
	MAX_CONNECTIONS,
	type ScanSummary,
} from "../../lib/connection-schemas";
import { isAdminRole } from "../../lib/roles";
import { currentMember } from "../access";
import { db } from "../auth";
import { schema } from "../db";
import { appOrigin } from "../origin";
import { allowConnect, allowScanNow } from "../rate-limit";
import { isSealer, sealerFor } from "../secrets";
import { checkCloudflare, checkGithub } from "./check";
import { runScan, type ScanResult, upstreamOptions } from "./scan";
import { tokenHint, tokenPlace } from "./tokens";

type Action = z.output<typeof ConnectionAction>;

/** The same whether the workspace doesn't exist or the caller isn't in it. */
const notFound = () => answer({ ok: false, error: "Not found" }, 404);

/** No caching: this says what a workspace has connected, and it can change at any moment. */
function answer(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

const refused = (error: string, status = 400) => answer({ ok: false, error }, status);

const summary = ({ outcome, found, added, resolved }: ScanResult): ScanSummary => ({
	outcome,
	found,
	added,
	resolved,
});

async function viewsOf(workspaceId: string, only?: string): Promise<ConnectionView[]> {
	const { connection } = schema;
	const rows = await db
		.select({
			id: connection.id,
			kind: connection.kind,
			target: connection.target,
			name: connection.name,
			tokenHint: connection.tokenHint,
			addedAt: connection.addedAt,
			lastScanAt: connection.lastScanAt,
			lastScanOutcome: connection.lastScanOutcome,
			nextScanAt: connection.nextScanAt,
			// Written out by hand: Drizzle leaves the table off a column in a query of one table, and
			// `connection_id = id` inside this subquery would then compare the finding with itself.
			openFindings: sql<number>`(
				SELECT count(*) FROM finding
				WHERE finding.connection_id = connection.id
					AND finding.resolved_at IS NULL AND finding.dismissed_at IS NULL
			)`,
		})
		.from(connection)
		.where(
			and(eq(connection.organizationId, workspaceId), only ? eq(connection.id, only) : undefined),
		)
		.orderBy(connection.addedAt, connection.id)
		.all();
	return rows.map((row) => ({
		...row,
		addedAt: row.addedAt.getTime(),
		lastScanAt: row.lastScanAt?.getTime() ?? null,
		nextScanAt: row.nextScanAt.getTime(),
	}));
}

/**
 * What a member sees of the workspace's connections: never a token, only its last four
 * characters. Null when the caller is not a member.
 */
export async function listConnections(slug: string): Promise<ConnectionsPage | null> {
	const member = await currentMember(slug);
	if (!member) return null;
	const { workspaceId } = member.membership;
	const sealer = await sealerFor(env, workspaceId);
	return {
		sealingProblem: isSealer(sealer) ? null : sealer.unavailable,
		connections: await viewsOf(workspaceId),
	};
}

export async function readConnections(slug: string): Promise<Response> {
	const page = await listConnections(slug);
	return page ? answer(page) : notFound();
}

const deps = () => ({ db, settings: env });

/** A connection of this workspace, by id. */
async function ownConnection(workspaceId: string, id: string) {
	const { connection } = schema;
	return db
		.select({ id: connection.id, kind: connection.kind, target: connection.target })
		.from(connection)
		.where(and(eq(connection.id, id), eq(connection.organizationId, workspaceId)))
		.get();
}

export async function changeConnections(request: Request, slug: string): Promise<Response> {
	// A session cookie comes along wherever a request is from, so ask where that is.
	if (request.headers.get("origin") !== appOrigin()) {
		return refused("Not allowed from there", 403);
	}
	const member = await currentMember(slug);
	if (!member) return notFound();
	const { workspaceId, role } = member.membership;
	if (!isAdminRole(role)) return refused("Only an owner or admin can change connections.", 403);
	const parsed = ConnectionAction.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return refused(parsed.error.issues[0]?.message ?? "That isn't a change we know.");
	}
	const action = parsed.data;

	switch (action.action) {
		case "connect-cloudflare":
		case "connect-github":
			return connect(action, workspaceId, member.user.id);
		case "replace-token":
			return replaceToken(action, workspaceId);
		case "scan": {
			const one = await ownConnection(workspaceId, action.id);
			if (!one) return notFound();
			if (!(await allowScanNow(one.id))) {
				return refused("This was scanned a moment ago. Wait a few minutes to scan it again.", 429);
			}
			const result = await runScan(deps(), one.id);
			if (!result) return refused("A scan of this connection is already running.", 409);
			return answer({ ok: true, scan: summary(result) });
		}
		case "remove": {
			const { connection } = schema;
			// Its token, findings and scans go with it, by cascade.
			const removed = await db
				.delete(connection)
				.where(and(eq(connection.id, action.id), eq(connection.organizationId, workspaceId)))
				.returning({ id: connection.id })
				.all();
			return removed.length > 0 ? answer({ ok: true }) : notFound();
		}
	}
}

async function connect(
	action: Extract<Action, { action: "connect-cloudflare" | "connect-github" }>,
	workspaceId: string,
	userId: string,
): Promise<Response> {
	const sealer = await sealerFor(env, workspaceId);
	if (!isSealer(sealer)) return refused(sealer.unavailable);
	const { connection } = schema;

	let repository: ReturnType<typeof parseRepositoryName> = null;
	if (action.action === "connect-github") {
		repository = parseRepositoryName(action.repository);
		if (!repository) {
			return refused(
				"That isn't a GitHub repository: write owner/name, or paste its github.com link.",
			);
		}
	}
	const used = await db
		.select({ n: count() })
		.from(connection)
		.where(eq(connection.organizationId, workspaceId))
		.get();
	if ((used?.n ?? 0) >= MAX_CONNECTIONS) {
		return refused(`A workspace can have up to ${MAX_CONNECTIONS} connections.`);
	}
	if (!(await allowConnect(workspaceId))) {
		return refused("That's a lot of tokens to try. Wait a few minutes.", 429);
	}

	const options = upstreamOptions(env);
	let kind: "cloudflare" | "github";
	let target: string;
	let repositoryId: number | null = null;
	if (action.action === "connect-cloudflare") {
		const checked = await checkCloudflare(action.accountId, action.token, options);
		if (!checked.ok) return refused(checked.error);
		kind = "cloudflare";
		target = action.accountId;
	} else {
		if (!repository) return refused("That isn't a GitHub repository.");
		const checked = await checkGithub(repository, action.token, options);
		if (!checked.ok) return refused(checked.error);
		kind = "github";
		({ target, repositoryId } = checked.value);
	}

	const connectionId = crypto.randomUUID();
	const now = Date.now();
	try {
		await db.insert(connection).values({
			id: connectionId,
			organizationId: workspaceId,
			kind,
			target,
			githubRepositoryId: repositoryId,
			name: action.name ?? target,
			tokenSealed: await sealer.seal(tokenPlace(connectionId), action.token),
			tokenHint: tokenHint(action.token),
			addedBy: userId,
			addedAt: new Date(now),
			nextScanAt: new Date(now),
		});
	} catch {
		// The one error a person can cause: this target is already connected here, or another
		// admin took the last place. Nothing else is worth saying, and nothing here holds the token.
		return refused(
			`${kind === "github" ? "That repository" : "That account"} is already connected, or this workspace is full.`,
			409,
		);
	}
	// The first scan runs now, so the page has something to show. If it fails, the connection
	// stays and says what failed.
	const result = await runScan(deps(), connectionId);
	const [view] = await viewsOf(workspaceId, connectionId);
	return answer({ ok: true, connection: view, scan: result ? summary(result) : null });
}

async function replaceToken(
	action: Extract<Action, { action: "replace-token" }>,
	workspaceId: string,
): Promise<Response> {
	const sealer = await sealerFor(env, workspaceId);
	if (!isSealer(sealer)) return refused(sealer.unavailable);
	const { connection } = schema;
	const one = await db
		.select({
			id: connection.id,
			kind: connection.kind,
			target: connection.target,
			githubRepositoryId: connection.githubRepositoryId,
		})
		.from(connection)
		.where(and(eq(connection.id, action.id), eq(connection.organizationId, workspaceId)))
		.get();
	if (!one) return notFound();
	if (!(await allowConnect(workspaceId))) {
		return refused("That's a lot of tokens to try. Wait a few minutes.", 429);
	}

	const options = upstreamOptions(env);
	if (one.kind === "cloudflare") {
		const checked = await checkCloudflare(one.target, action.token, options);
		if (!checked.ok) return refused(checked.error);
	} else {
		const name = parseRepositoryName(one.target);
		if (!name) return notFound();
		const checked = await checkGithub(name, action.token, options);
		if (!checked.ok) return refused(checked.error);
		// A token for a repository of the same name that is not this one is not this connection's.
		if (checked.value.repositoryId !== one.githubRepositoryId) {
			return refused("That token is for a different repository than this connection's.");
		}
	}
	await db
		.update(connection)
		.set({
			tokenSealed: await sealer.seal(tokenPlace(one.id), action.token),
			tokenHint: tokenHint(action.token),
		})
		.where(eq(connection.id, one.id));
	const result = await runScan(deps(), one.id);
	return answer({ ok: true, scan: result ? summary(result) : null });
}
