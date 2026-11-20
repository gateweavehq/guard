import { env } from "cloudflare:workers";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { TrackLinkView } from "../../lib/track-schemas";
import { db } from "../auth";
import { schema } from "../db";
import { allowTrackFiling } from "../rate-limit";
import { isSealer, sealerFor } from "../secrets";
import { addLabel, createIssue, failureSentence, findLabel, getWorkspace } from "./api";
import { type IssueFacts, issueDescription, issueTitle, issueUrl, priorityFor } from "./issue";
import { trackKeyPlace } from "./key";
import { TrackError, TrackSession } from "./mcp";

/**
 * A claim on a finding that nobody has finished or let go of for this long is taken to be dead (an
 * isolate that was stopped mid-call), so the next click can file it.
 */
export const FILING_LEASE_MS = 2 * 60 * 1000;

/** The label Guard adds when the team has it. Guard never makes one. */
const SECURITY_LABEL = "security";

export type FilingResult =
	/** `waiting`: Track kept what was asked as a proposal for a person to accept. */
	| { ok: true; link: TrackLinkView; waiting?: boolean }
	| { ok: false; error: string; status: number };

const refuse = (error: string, status = 400): FilingResult => ({ ok: false, error, status });

export interface FilingRequest {
	workspaceId: string;
	/** The member who pressed the button. */
	userId: string;
	findingId: string;
	/** Also ask Agents for a fix, by labelling the issue. */
	askFix: boolean;
	/** The Findings page of the workspace, which the issue links back to. */
	findingsUrl: string;
	/** For tests: where requests to Track go. */
	fetcher?: typeof fetch;
}

/**
 * Files a finding in Track as one issue, and, when `askFix`, labels it so that Agents' trigger takes
 * it from there. Guard sends Track the finding's own facts (`issue.ts`) and the agent's key, which
 * it opens here and nowhere else.
 *
 * One issue per finding, however the clicks arrive: the finding is claimed in D1 with a
 * conditional update before Track is called, and let go if Track fails.
 */
export async function fileFinding(request: FilingRequest): Promise<FilingResult> {
	const { finding, connection, trackIntegration } = schema;
	const { workspaceId, findingId, askFix } = request;

	const integration = await db
		.select()
		.from(trackIntegration)
		.where(eq(trackIntegration.organizationId, workspaceId))
		.get();
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
			resolvedAt: finding.resolvedAt,
			dismissedAt: finding.dismissedAt,
			trackState: finding.trackState,
			trackIssueKey: finding.trackIssueKey,
			trackIssueUrl: finding.trackIssueUrl,
			trackFiledAt: finding.trackFiledAt,
			fixRequestedAt: finding.fixRequestedAt,
			connectionKind: connection.kind,
			connectionTarget: connection.target,
			connectionName: connection.name,
		})
		.from(finding)
		.innerJoin(connection, eq(finding.connectionId, connection.id))
		.where(and(eq(finding.id, findingId), eq(finding.organizationId, workspaceId)))
		.get();
	if (!row) return refuse("Not found", 404);
	if (!row.trackState && row.trackIssueUrl)
		return refuse("Open the issue already reported to Track.", 409);
	if (!integration || integration.sourceMode) {
		return refuse(
			"Gateweave Track isn't connected to this workspace. An owner or admin can do that in Settings.",
			409,
		);
	}
	if (askFix) {
		if (!integration.fixLabel) {
			return refuse(
				"No label is set for asking Agents. An owner or admin can set one in Settings.",
				409,
			);
		}
		if (row.source !== "dependency" || !row.fixedVersion) {
			return refuse("Only a dependency with a version that fixes it can be sent to Agents.", 409);
		}
	}

	const link = (overrides: Partial<TrackLinkView> = {}): TrackLinkView => ({
		state: row.trackState ?? "filed",
		key: row.trackIssueKey,
		url: row.trackIssueUrl,
		fixRequested: row.fixRequestedAt !== null,
		...overrides,
	});

	// Already in Track: say so rather than file it again.
	if (row.trackState === "proposed") {
		return askFix
			? refuse(
					"This finding was proposed in Track and waits for a person there. Ask for the fix after they accept it.",
					409,
				)
			: { ok: true, link: link() };
	}
	// A `filing` row is someone else's claim, or one nobody finished; the claim below tells which.
	if (row.trackState === "filed") {
		if (!askFix || row.fixRequestedAt) return { ok: true, link: link() };
	} else if (row.resolvedAt || row.dismissedAt) {
		return refuse("That finding isn't open any more.", 409);
	}

	if (!(await allowTrackFiling(workspaceId))) {
		return refuse("That's a lot of findings at once. Wait a minute.", 429);
	}

	const sealer = await sealerFor(env, workspaceId);
	if (!isSealer(sealer)) return refuse(sealer.unavailable);

	// Claim before calling Track. Of two requests at once, one gets the row.
	let claimedAt: Date | null = null;
	if (row.trackState !== "filed") {
		claimedAt = new Date();
		const claimed = await db
			.update(finding)
			.set({ trackState: "filing", trackFiledAt: claimedAt, trackFiledBy: request.userId })
			.where(
				and(
					eq(finding.id, findingId),
					eq(finding.organizationId, workspaceId),
					isNull(finding.trackIssueUrl),
					sql`EXISTS (SELECT 1 FROM ${trackIntegration} WHERE ${trackIntegration.organizationId} = ${workspaceId} AND ${trackIntegration.sourceMode} = 0)`,
					isNull(finding.resolvedAt),
					isNull(finding.dismissedAt),
					or(
						isNull(finding.trackState),
						and(
							eq(finding.trackState, "filing"),
							lt(finding.trackFiledAt, new Date(claimedAt.getTime() - FILING_LEASE_MS)),
						),
					),
				),
			)
			.returning({ id: finding.id })
			.all();
		if (claimed.length === 0) {
			// Someone else got there first: show what they made, if they have made it.
			const now = await db
				.select({
					state: finding.trackState,
					key: finding.trackIssueKey,
					url: finding.trackIssueUrl,
					fixRequestedAt: finding.fixRequestedAt,
				})
				.from(finding)
				.where(eq(finding.id, findingId))
				.get();
			if (now?.state === "filed" || now?.state === "proposed") {
				return {
					ok: true,
					link: {
						state: now.state,
						key: now.key,
						url: now.url,
						fixRequested: now.fixRequestedAt !== null,
					},
				};
			}
			return refuse("Someone is filing this finding right now. Give it a moment.", 409);
		}
	}
	const claim = claimedAt;
	/** Lets go of this request's claim, and no one else's: a later claim has another time. */
	const release = async () => {
		if (!claim) return;
		await db
			.update(finding)
			.set({ trackState: null, trackFiledAt: null, trackFiledBy: null })
			.where(
				and(
					eq(finding.id, findingId),
					eq(finding.trackState, "filing"),
					eq(finding.trackFiledAt, claim),
				),
			);
	};

	try {
		let key: string;
		try {
			key = await sealer.open(trackKeyPlace(workspaceId), integration.keySealed);
		} catch {
			await release();
			return refuse(
				"Guard can't open the Track key it kept. An owner or admin should paste the key again in Settings.",
				409,
			);
		}
		const session = new TrackSession(
			{ address: integration.address, key },
			{ fetcher: request.fetcher },
		);
		const noted = (outcome: string) =>
			db
				.update(trackIntegration)
				.set({ lastCheckAt: new Date(), lastCheckOutcome: outcome })
				.where(eq(trackIntegration.organizationId, workspaceId))
				.catch(() => undefined);

		let issue: Awaited<ReturnType<typeof createIssue>>;
		try {
			const workspace = await getWorkspace(session, integration.workspaceSlug);
			const fix =
				askFix && integration.fixLabel ? findLabel(workspace.labels, integration.fixLabel) : null;
			if (askFix && !fix) {
				await release();
				return refuse(
					`The label "${integration.fixLabel}" is not in Track any more. Make it there again, or change it in Settings.`,
					409,
				);
			}
			if (row.trackState === "filed" && row.trackIssueKey) {
				// Filed before: the label is the whole of it. Agents' trigger fires when it is added.
				if (!fix) return refuse("That label is not in Track any more.", 409);
				issue = await addLabel(session, {
					workspace: integration.workspaceSlug,
					key: row.trackIssueKey,
					label: fix,
				});
			} else {
				const labels = [findLabel(workspace.labels, SECURITY_LABEL), fix].filter(
					(label, index, all): label is string => label !== null && all.indexOf(label) === index,
				);
				const facts: IssueFacts = {
					source: row.source,
					severity: row.severity,
					kind: row.kind,
					subject: row.subject,
					title: row.title,
					url: row.url,
					fixedVersion: row.fixedVersion,
					connectionKind: row.connectionKind,
					connectionTarget: row.connectionTarget,
					connectionName: row.connectionName,
					guardUrl: `${request.findingsUrl}#finding-${row.id}`,
				};
				issue = await createIssue(session, {
					workspace: integration.workspaceSlug,
					team: integration.teamKey,
					title: issueTitle(facts),
					description: issueDescription(facts),
					priority: priorityFor(row.severity),
					labels,
				});
			}
		} catch (error) {
			if (!(error instanceof TrackError)) throw error;
			await release();
			await noted(error.failure);
			return refuse(failureSentence(error, "file"), 502);
		}
		await noted("ok");

		const url = issueUrl(issue.url, integration, issue.key);
		const now = new Date();
		const state = row.trackState === "filed" || !issue.proposed ? "filed" : "proposed";
		if (claim) {
			await db
				.update(finding)
				.set({
					trackState: state,
					trackIssueKey: issue.key,
					trackIssueUrl: url,
					trackFiledAt: now,
					fixRequestedAt: askFix ? now : null,
				})
				.where(
					and(
						eq(finding.id, findingId),
						eq(finding.trackState, "filing"),
						eq(finding.trackFiledAt, claim),
					),
				);
		} else {
			await db
				.update(finding)
				.set({ fixRequestedAt: now })
				.where(and(eq(finding.id, findingId), isNull(finding.fixRequestedAt)));
		}
		return {
			ok: true,
			link: { state, key: issue.key, url, fixRequested: askFix || row.fixRequestedAt !== null },
			waiting: issue.proposed,
		};
	} catch (error) {
		await release().catch(() => undefined);
		throw error;
	}
}
