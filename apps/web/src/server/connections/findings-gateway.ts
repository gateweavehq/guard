import { and, count, eq, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import {
	FindingAction,
	type FindingFilters,
	type FindingStatus,
	type FindingsPage,
	type FindingView,
} from "../../lib/connection-schemas";
import { isAdminRole } from "../../lib/roles";
import { currentMember } from "../access";
import { db } from "../auth";
import { schema } from "../db";
import { appOrigin } from "../origin";

/** The most findings a page lists. A scan of a repository with more is a problem to fix at its root. */
export const MAX_LISTED_FINDINGS = 500;

/** The same whether the workspace doesn't exist or the caller isn't in it. */
const notFound = () => answer({ ok: false, error: "Not found" }, 404);

function answer(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

const refused = (error: string, status = 400) => answer({ ok: false, error }, status);

const statusOf = (row: { resolvedAt: Date | null; dismissedAt: Date | null }): FindingStatus =>
	row.dismissedAt ? "dismissed" : row.resolvedAt ? "resolved" : "open";

/**
 * The workspace's findings, most severe first and then newest, for any member. Null when the
 * caller is not a member. A finding an admin dismissed is dismissed whatever a scan has seen since.
 */
export async function listFindings(
	slug: string,
	filters: z.output<typeof FindingFilters>,
): Promise<FindingsPage | null> {
	const member = await currentMember(slug);
	if (!member) return null;
	const { workspaceId } = member.membership;
	const { finding, connection } = schema;

	const status: SQL =
		filters.status === "dismissed"
			? isNotNull(finding.dismissedAt)
			: filters.status === "resolved"
				? (and(isNull(finding.dismissedAt), isNotNull(finding.resolvedAt)) as SQL)
				: (and(isNull(finding.dismissedAt), isNull(finding.resolvedAt)) as SQL);
	const where = and(
		eq(finding.organizationId, workspaceId),
		status,
		filters.severity ? eq(finding.severity, filters.severity) : undefined,
		filters.source ? eq(finding.source, filters.source) : undefined,
	);

	const [rows, total, connections] = await Promise.all([
		db
			.select({
				id: finding.id,
				source: finding.source,
				severity: finding.severity,
				kind: finding.kind,
				subject: finding.subject,
				title: finding.title,
				url: finding.url,
				fixedVersion: finding.fixedVersion,
				firstSeenAt: finding.firstSeenAt,
				lastSeenAt: finding.lastSeenAt,
				resolvedAt: finding.resolvedAt,
				dismissedAt: finding.dismissedAt,
				dismissReason: finding.dismissReason,
				connectionId: connection.id,
				connectionName: connection.name,
				connectionKind: connection.kind,
			})
			.from(finding)
			.innerJoin(connection, eq(finding.connectionId, connection.id))
			.where(where)
			.orderBy(
				sql`CASE ${finding.severity} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
				sql`${finding.firstSeenAt} DESC`,
				finding.id,
			)
			.limit(MAX_LISTED_FINDINGS)
			.all(),
		db.select({ n: count() }).from(finding).where(where).get(),
		db
			.select({ n: count() })
			.from(connection)
			.where(eq(connection.organizationId, workspaceId))
			.get(),
	]);

	return {
		hasConnections: (connections?.n ?? 0) > 0,
		total: total?.n ?? 0,
		findings: rows.map(
			({ resolvedAt, dismissedAt, ...row }): FindingView => ({
				...row,
				firstSeenAt: row.firstSeenAt.getTime(),
				lastSeenAt: row.lastSeenAt.getTime(),
				status: statusOf({ resolvedAt, dismissedAt }),
			}),
		),
	};
}

export async function readFindings(
	slug: string,
	filters: z.output<typeof FindingFilters>,
): Promise<Response> {
	const page = await listFindings(slug, filters);
	return page ? answer(page) : notFound();
}

export async function changeFindings(request: Request, slug: string): Promise<Response> {
	if (request.headers.get("origin") !== appOrigin()) {
		return refused("Not allowed from there", 403);
	}
	const member = await currentMember(slug);
	if (!member) return notFound();
	const { workspaceId, role } = member.membership;
	if (!isAdminRole(role)) return refused("Only an owner or admin can dismiss findings.", 403);
	const parsed = FindingAction.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return refused(parsed.error.issues[0]?.message ?? "That isn't a change we know.");
	}
	const action = parsed.data;
	const { finding } = schema;
	const mine = and(eq(finding.id, action.id), eq(finding.organizationId, workspaceId));

	if (action.action === "dismiss") {
		const changed = await db
			.update(finding)
			.set({
				dismissedAt: new Date(),
				dismissedBy: member.user.id,
				dismissReason: action.reason,
			})
			.where(and(mine, isNull(finding.dismissedAt)))
			.returning({ id: finding.id })
			.all();
		if (changed.length > 0) return answer({ ok: true });
	} else {
		const changed = await db
			.update(finding)
			.set({ dismissedAt: null, dismissedBy: null, dismissReason: null })
			.where(and(mine, isNotNull(finding.dismissedAt)))
			.returning({ id: finding.id })
			.all();
		if (changed.length > 0) return answer({ ok: true });
	}
	// Either it isn't this workspace's, or it already is as asked.
	const exists = await db.select({ id: finding.id }).from(finding).where(mine).get();
	return exists ? answer({ ok: true }) : notFound();
}
