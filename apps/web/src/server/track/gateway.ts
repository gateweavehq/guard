import { env } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { isAdminRole } from "../../lib/roles";
import { TrackAction, type TrackIntegrationView, type TrackPage } from "../../lib/track-schemas";
import { currentMember } from "../access";
import { db } from "../auth";
import { tokenHint } from "../connections/tokens";
import { schema } from "../db";
import { appOrigin } from "../origin";
import { allowTrackCheck } from "../rate-limit";
import { isSealer, sealerFor } from "../secrets";
import { parseTrackAddress } from "./address";
import { checkTrack } from "./api";
import { trackKeyPlace } from "./key";
import { TrackSession } from "./mcp";
import { saveSource } from "./source-settings";

/** The same whether the workspace doesn't exist or the caller isn't in it. */
const notFound = () => answer({ ok: false, error: "Not found" }, 404);

/** No caching: this says where a workspace sends its findings, and it can change at any moment. */
function answer(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

const refused = (error: string, status = 400) => answer({ ok: false, error }, status);

type Row = typeof schema.trackIntegration.$inferSelect;

/** What a page sees of the integration. The key's hint is for owners and admins. */
function viewOf(row: Row, admin: boolean): TrackIntegrationView {
	return {
		address: row.address,
		workspace: row.workspaceSlug,
		team: row.teamKey,
		fixLabel: row.fixLabel,
		keyHint: admin ? row.keyHint : null,
		addedAt: row.addedAt.getTime(),
		lastCheckAt: row.lastCheckAt?.getTime() ?? null,
		lastCheckOutcome: row.lastCheckOutcome,
	};
}

/** The workspace's Track settings, for any member. Null when the caller is not a member. */
export async function listTrack(slug: string): Promise<TrackPage | null> {
	const member = await currentMember(slug);
	if (!member) return null;
	const { workspaceId, role } = member.membership;
	const row = await db
		.select()
		.from(schema.trackIntegration)
		.where(eq(schema.trackIntegration.organizationId, workspaceId))
		.get();
	const sealer = await sealerFor(env, workspaceId);
	return {
		sealingProblem: isSealer(sealer) ? null : sealer.unavailable,
		guardOrigin: appOrigin(),
		sourceAddress: row?.sourceMode ? row.address : null,
		sources: isAdminRole(role)
			? (
					await db
						.select({
							id: schema.connection.id,
							name: schema.connection.name,
							kind: schema.connection.kind,
							keyHint: schema.trackSource.keyHint,
							lastAnswer: schema.trackSource.lastAnswer,
							answeredAt: schema.trackSource.answeredAt,
							stopped: schema.trackSource.stopped,
						})
						.from(schema.connection)
						.leftJoin(schema.trackSource, eq(schema.connection.id, schema.trackSource.connectionId))
						.where(eq(schema.connection.organizationId, workspaceId))
						.orderBy(schema.connection.name)
				).map((row) => ({ ...row, stopped: Boolean(row.stopped) }))
			: [],
		integration: row && !row.sourceMode ? viewOf(row, isAdminRole(role)) : null,
	};
}

export async function readTrack(slug: string): Promise<Response> {
	const page = await listTrack(slug);
	return page ? answer({ ok: true, ...page }) : notFound();
}

export async function changeTrack(request: Request, slug: string): Promise<Response> {
	// A session cookie comes along wherever a request is from, so ask where that is.
	if (request.headers.get("origin") !== appOrigin()) {
		return refused("Not allowed from there", 403);
	}
	const member = await currentMember(slug);
	if (!member) return notFound();
	const { workspaceId, role } = member.membership;
	if (!isAdminRole(role)) {
		return refused("Only an owner or admin can change where findings are filed.", 403);
	}
	const parsed = TrackAction.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return refused(parsed.error.issues[0]?.message ?? "That isn't a change we know.");
	}
	const { trackIntegration } = schema;
	const action = parsed.data;

	if (action.action === "source") {
		return saveSource(workspaceId, member.user.id, action);
	}
	if (action.action === "remove") {
		// The links on findings stay: they are what was filed, whatever happens to the way of filing.
		// Removing a workspace that reports through sources removes their keys too, so it can connect
		// again either way, to any address.
		const { connection, trackSource } = schema;
		await db.batch([
			db
				.delete(trackSource)
				.where(
					inArray(
						trackSource.connectionId,
						db
							.select({ id: connection.id })
							.from(connection)
							.where(eq(connection.organizationId, workspaceId)),
					),
				),
			db.delete(trackIntegration).where(eq(trackIntegration.organizationId, workspaceId)),
		]);
		return answer({ ok: true });
	}

	const sealer = await sealerFor(env, workspaceId);
	if (!isSealer(sealer)) return refused(sealer.unavailable);
	const address = parseTrackAddress(action.address, appOrigin());
	if (!address.ok) return refused(address.error);

	const existing = await db
		.select()
		.from(trackIntegration)
		.where(eq(trackIntegration.organizationId, workspaceId))
		.get();
	if (existing?.sourceMode)
		return refused("This workspace reports findings with source keys.", 409);
	// The kept key is for the Track it was made in. Sent to another address it would hand that
	// server a key to this one, so a new address always needs a new key.
	let key = action.key ?? null;
	if (!key && existing && existing.address === address.origin) {
		try {
			key = await sealer.open(trackKeyPlace(workspaceId), existing.keySealed);
		} catch {
			return refused("Guard can't open the key it kept. Paste the agent key again.");
		}
	}
	if (!key) {
		return refused(
			existing && existing.address !== address.origin
				? "A different address needs its own agent key. Paste the key made in that Track."
				: "Paste an agent member's key from Track.",
		);
	}
	if (!(await allowTrackCheck(workspaceId))) {
		return refused("That's a lot of tries. Wait a few minutes.", 429);
	}

	const session = new TrackSession({ address: address.origin, key });
	const checked = await checkTrack(session, {
		workspace: action.workspace,
		team: action.team,
		fixLabel: action.fixLabel ?? null,
	});
	if (!checked.ok) return refused(checked.error);

	const now = new Date();
	const values = {
		address: address.origin,
		workspaceSlug: action.workspace,
		teamKey: action.team,
		fixLabel: checked.value.fixLabel,
		keySealed: await sealer.seal(trackKeyPlace(workspaceId), key),
		keyHint: tokenHint(key),
		addedBy: member.user.id,
		addedAt: now,
		lastCheckAt: now,
		lastCheckOutcome: "ok",
	};
	await db
		.insert(trackIntegration)
		.values({ organizationId: workspaceId, ...values })
		.onConflictDoUpdate({
			target: trackIntegration.organizationId,
			set: values,
			setWhere: eq(trackIntegration.sourceMode, 0),
		});
	const saved = await db
		.select()
		.from(trackIntegration)
		.where(eq(trackIntegration.organizationId, workspaceId))
		.get();
	if (saved?.sourceMode) return refused("This workspace reports findings with source keys.", 409);
	return answer({ ok: true, integration: saved ? viewOf(saved, true) : null });
}
