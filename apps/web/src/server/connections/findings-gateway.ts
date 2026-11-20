import { env } from "cloudflare:workers";
import { and, count, eq, gt, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import {
	FindingAction,
	type FindingFilters,
	type FindingStatus,
	type FindingsPage,
	type FindingView,
} from "../../lib/connection-schemas";
import { isAdminRole } from "../../lib/roles";
import type { TrackLinkView } from "../../lib/track-schemas";
import { type Acting, currentMember } from "../access";
import { db } from "../auth";
import { schema } from "../db";
import { countNewFindings, findingsSeenAt, markFindingsSeen } from "../notifications/seen";
import { appOrigin } from "../origin";
import { fileFinding } from "../track/filing";
import { reportAfterChange } from "../track/report";

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

/** What the page's three filters leave out, which an assistant's list has as well. */
export interface FindingsWindow {
	/** One connection's findings. */
	connectionId?: string;
	/** One kind: an insight's class, or an advisory's id. */
	kind?: string;
	/** Only what was raised after the caller last opened Findings. */
	newOnly?: boolean;
	/** How many to list, from `offset` in the page's order. The page lists up to `MAX_LISTED_FINDINGS`. */
	limit?: number;
	offset?: number;
}

/**
 * The workspace's findings, most severe first and then newest, for any member. Null when the
 * caller is not a member. A finding an admin dismissed is dismissed whatever a scan has seen since.
 */
export async function listFindings(
	slug: string,
	filters: z.output<typeof FindingFilters>,
): Promise<FindingsPage | null> {
	const member = await currentMember(slug);
	return member && findingsOf(member, filters);
}

/** The same list for someone already known to belong, which is where an assistant's access begins. */
export async function findingsOf(
	member: Acting,
	filters: z.output<typeof FindingFilters>,
	window: FindingsWindow = {},
): Promise<FindingsPage> {
	const { workspaceId } = member.membership;
	const { finding, connection, trackIntegration } = schema;
	const loadedAt = Date.now();
	const seenAt = await findingsSeenAt(db, workspaceId, member.user.id, member.membership.memberId);

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
		window.connectionId ? eq(finding.connectionId, window.connectionId) : undefined,
		window.kind ? eq(finding.kind, window.kind) : undefined,
		window.newOnly ? gt(finding.raisedAt, seenAt) : undefined,
	);

	const [rows, total, connections, integration] = await Promise.all([
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
				raisedAt: finding.raisedAt,
				resolvedAt: finding.resolvedAt,
				dismissedAt: finding.dismissedAt,
				dismissReason: finding.dismissReason,
				trackState: finding.trackState,
				trackIssueKey: finding.trackIssueKey,
				trackIssueUrl: finding.trackIssueUrl,
				fixRequestedAt: finding.fixRequestedAt,
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
			.limit(window.limit ?? MAX_LISTED_FINDINGS)
			.offset(window.offset ?? 0)
			.all(),
		db.select({ n: count() }).from(finding).where(where).get(),
		db
			.select({ n: count() })
			.from(connection)
			.where(eq(connection.organizationId, workspaceId))
			.get(),
		db
			.select({ sourceMode: trackIntegration.sourceMode, fixLabel: trackIntegration.fixLabel })
			.from(trackIntegration)
			.where(eq(trackIntegration.organizationId, workspaceId))
			.get(),
	]);

	return {
		hasConnections: (connections?.n ?? 0) > 0,
		total: total?.n ?? 0,
		seenAt,
		loadedAt,
		track: {
			...(integration?.sourceMode && { sourceMode: true }),
			configured: !!integration && !integration.sourceMode,
			canAskFix: Boolean(integration?.fixLabel),
		},
		findings: rows.map(
			({
				resolvedAt,
				dismissedAt,
				trackState,
				trackIssueKey,
				trackIssueUrl,
				fixRequestedAt,
				...row
			}): FindingView => ({
				...row,
				track:
					trackState || trackIssueUrl
						? {
								state: trackState ?? "filed",
								key: trackIssueKey,
								url: trackIssueUrl,
								fixRequested: fixRequestedAt !== null,
							}
						: null,
				firstSeenAt: row.firstSeenAt.getTime(),
				lastSeenAt: row.lastSeenAt.getTime(),
				raisedAt: row.raisedAt,
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

/**
 * How many open findings are new to the caller, for the sidebar's badge: raised since they last
 * opened Findings. Null when the caller is not a member.
 */
export async function readNewFindingCount(slug: string): Promise<Response> {
	const member = await currentMember(slug);
	if (!member) return notFound();
	const { workspaceId, memberId } = member.membership;
	const seenAt = await findingsSeenAt(db, workspaceId, member.user.id, memberId);
	return answer({ ok: true, count: await countNewFindings(db, workspaceId, seenAt) });
}

/** What an action on a finding comes to: done, or why not, in the words and status a page gets. */
export type FindingOutcome =
	| { ok: true; track?: TrackLinkView; waiting?: true }
	| { ok: false; status: number; error: string };

const missing: FindingOutcome = { ok: false, status: 404, error: "Not found" };
const rejected = (error: string, status = 400): FindingOutcome => ({ ok: false, status, error });

export async function changeFindings(request: Request, slug: string): Promise<Response> {
	if (request.headers.get("origin") !== appOrigin()) {
		return refused("Not allowed from there", 403);
	}
	const member = await currentMember(slug);
	if (!member) return notFound();
	const outcome = await changeFindingsAs(member, slug, await request.json().catch(() => null));
	if (!outcome.ok)
		return outcome.status === 404 ? notFound() : refused(outcome.error, outcome.status);
	const { ok: _ok, ...rest } = outcome;
	return answer({ ok: true, ...rest });
}

/**
 * Applies a change to a finding as a member the caller has already found to belong: the part of
 * `changeFindings` after who is this, which an assistant's access reaches too, so that what a
 * member may do is decided here once. `input` is untrusted.
 */
export async function changeFindingsAs(
	member: Acting,
	slug: string,
	input: unknown,
): Promise<FindingOutcome> {
	const { workspaceId, role } = member.membership;
	const parsed = FindingAction.safeParse(input);
	// Looking is every member's own business, and so is filing a finding in the team's Track, which
	// only makes an issue there. Only changing findings is for admins.
	const memberMay = parsed.success && ["seen", "file", "ask-fix"].includes(parsed.data.action);
	if (!memberMay && !isAdminRole(role)) {
		return rejected("Only an owner or admin can dismiss findings.", 403);
	}
	if (!parsed.success) {
		return rejected(parsed.error.issues[0]?.message ?? "That isn't a change we know.");
	}
	const action = parsed.data;
	if (action.action === "seen") {
		await markFindingsSeen(db, workspaceId, member.user.id, action.at);
		return { ok: true };
	}
	if (action.action === "file" || action.action === "ask-fix") {
		const result = await fileFinding({
			workspaceId,
			userId: member.user.id,
			findingId: action.id,
			askFix: action.action === "ask-fix",
			findingsUrl: `${appOrigin()}/${encodeURIComponent(slug)}/findings`,
		});
		if (!result.ok) return result.status === 404 ? missing : rejected(result.error, result.status);
		return { ok: true, track: result.link, ...(result.waiting && { waiting: true as const }) };
	}
	const { finding } = schema;
	const mine = and(eq(finding.id, action.id), eq(finding.organizationId, workspaceId));

	const at = Date.now();
	const dismiss = action.action === "dismiss";
	const changed = await db
		.update(finding)
		.set({
			sourceChangedAt: at,
			dismissedAt: dismiss ? new Date(at) : null,
			dismissedBy: dismiss ? member.user.id : null,
			dismissReason: dismiss ? action.reason : null,
		})
		.where(and(mine, dismiss ? isNull(finding.dismissedAt) : isNotNull(finding.dismissedAt)))
		.returning({ connectionId: finding.connectionId })
		.get();
	if (changed) {
		await reportAfterChange(db, env, changed.connectionId, at);
		return { ok: true };
	}
	// Either it isn't this workspace's, or it already is as asked.
	const exists = await db.select({ id: finding.id }).from(finding).where(mine).get();
	return exists ? { ok: true } : missing;
}

/** Everything the page knows of one finding, and who dismissed it. */
export interface FindingDetail extends FindingView {
	connectionTarget: string;
	lastSeenAt: number;
	dismissedAt: number | null;
	/** The name of the member who dismissed it; null when that account is gone. */
	dismissedBy: string | null;
}

/** One finding of the workspace, for someone known to belong. Null for any other id. */
export async function findingOf(member: Acting, id: string): Promise<FindingDetail | null> {
	const { finding, connection, user } = schema;
	const row = await db
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
			raisedAt: finding.raisedAt,
			resolvedAt: finding.resolvedAt,
			dismissedAt: finding.dismissedAt,
			dismissReason: finding.dismissReason,
			dismisserName: user.name,
			trackState: finding.trackState,
			trackIssueKey: finding.trackIssueKey,
			trackIssueUrl: finding.trackIssueUrl,
			fixRequestedAt: finding.fixRequestedAt,
			connectionId: connection.id,
			connectionName: connection.name,
			connectionKind: connection.kind,
			connectionTarget: connection.target,
		})
		.from(finding)
		.innerJoin(connection, eq(finding.connectionId, connection.id))
		.leftJoin(user, eq(finding.dismissedBy, user.id))
		.where(and(eq(finding.id, id), eq(finding.organizationId, member.membership.workspaceId)))
		.get();
	if (!row) return null;
	const {
		resolvedAt,
		dismissedAt,
		dismisserName,
		trackState,
		trackIssueKey,
		trackIssueUrl,
		fixRequestedAt,
		...rest
	} = row;
	return {
		...rest,
		track:
			trackState || trackIssueUrl
				? {
						state: trackState ?? "filed",
						key: trackIssueKey,
						url: trackIssueUrl,
						fixRequested: fixRequestedAt !== null,
					}
				: null,
		firstSeenAt: row.firstSeenAt.getTime(),
		lastSeenAt: row.lastSeenAt.getTime(),
		dismissedAt: dismissedAt?.getTime() ?? null,
		dismissedBy: dismisserName,
		status: statusOf({ resolvedAt, dismissedAt }),
	};
}
