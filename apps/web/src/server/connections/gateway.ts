import { env } from "cloudflare:workers";
import { parseRepositoryName } from "@gateweave/guard-scan";
import { and, count, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import {
	ConnectionAction,
	type ConnectionsPage,
	type ConnectionView,
	MAX_CONNECTIONS,
	type ScanState,
	type ScanSummary,
} from "../../lib/connection-schemas";
import { isAdminRole } from "../../lib/roles";
import { type Acting, currentMember } from "../access";
import { db } from "../auth";
import { schema } from "../db";
import { refusedBy, refusedByUnique } from "../db/query-failure";
import { appOrigin } from "../origin";
import { allowConnect, allowScanNow } from "../rate-limit";
import { isSealer, sealerFor } from "../secrets";
import { checkCloudflare, checkGithub } from "./check";
import { runScan, type ScanResult, type ScanRun, upstreamOptions } from "./scan";
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

/**
 * The scan that follows connecting or a new token, for the answer: its summary, or none and why.
 * The connection or the token is saved either way, which is why this is no refusal.
 */
const firstScan = (run: ScanRun): { scan: ScanSummary | null; scanState: ScanState } => ({
	scan: run.state === "recorded" ? summary(run.result) : null,
	scanState: run.state,
});

/** A scan read the connection and its result could not be written: not the same as no scan. */
const UNRECORDED_SCAN =
	"The scan ran, but what it found could not be saved. Try again in a few minutes.";

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
			trafficOutcome: connection.trafficOutcome,
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

/**
 * A workspace's connections by name and target, which is all an assistant needs to point at one:
 * no token, not even its hint. For someone the caller has found to belong.
 */
export async function connectionRefs(member: Acting) {
	const { connection } = schema;
	return db
		.select({
			id: connection.id,
			name: connection.name,
			kind: connection.kind,
			target: connection.target,
		})
		.from(connection)
		.where(eq(connection.organizationId, member.membership.workspaceId))
		.orderBy(connection.addedAt, connection.id)
		.all();
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

/** What starting a scan comes to: its summary, or why not, in the words and status a page gets. */
export type ScanNowOutcome =
	| { ok: true; scan: ScanSummary }
	| { ok: false; status: number; error: string };

/**
 * "Scan now" for a member the caller has already found to belong: owners and admins only, once in a
 * few minutes per connection, and waiting for the scan to finish. The page's button and an
 * assistant's `start_scan` both come here, so they cannot disagree.
 */
export async function scanNow(member: Acting, connectionId: string): Promise<ScanNowOutcome> {
	const { workspaceId, role } = member.membership;
	if (!isAdminRole(role)) {
		return { ok: false, status: 403, error: "Only an owner or admin can change connections." };
	}
	const one = await ownConnection(workspaceId, connectionId);
	if (!one) return { ok: false, status: 404, error: "Not found" };
	if (!(await allowScanNow(one.id))) {
		return {
			ok: false,
			status: 429,
			error: "This was scanned a moment ago. Wait a few minutes to scan it again.",
		};
	}
	const run = await runScan(deps(), one.id);
	if (run.state === "held") {
		return { ok: false, status: 409, error: "A scan of this connection is already running." };
	}
	// The allowance stays spent: the account or repository was read, which is what it counts.
	if (run.state === "unrecorded") return { ok: false, status: 500, error: UNRECORDED_SCAN };
	return { ok: true, scan: summary(run.result) };
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
			const scanned = await scanNow(member, action.id);
			if (!scanned.ok) {
				return scanned.status === 404 ? notFound() : refused(scanned.error, scanned.status);
			}
			return answer({ ok: true, scan: scanned.scan });
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
	} catch (error) {
		// The two errors a person can cause, each said only when the database itself refused for
		// that reason: this target is already connected here, or another admin took the last place.
		// Anything else is the database failing, and is thrown as it came, which holds no token.
		if (
			refusedByUnique(
				error,
				"connection.organization_id",
				"connection.kind",
				"connection.target",
			) ||
			refusedByUnique(error, "connection.organization_id", "connection.github_repository_id")
		) {
			return refused(
				`${kind === "github" ? "That repository" : "That account"} is already connected.`,
				409,
			);
		}
		if (refusedBy(error, "a workspace may have at most 50 connections")) {
			return refused(`A workspace can have up to ${MAX_CONNECTIONS} connections.`, 409);
		}
		throw error;
	}
	// The first scan runs now, so the page has something to show. If it fails, the connection
	// stays and says what failed.
	const run = await runScan(deps(), connectionId);
	const [view] = await viewsOf(workspaceId, connectionId);
	return answer({ ok: true, connection: view, ...firstScan(run) });
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
	const run = await runScan(deps(), one.id);
	return answer({ ok: true, ...firstScan(run) });
}
