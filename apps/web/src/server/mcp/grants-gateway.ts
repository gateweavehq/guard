import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import type { AssistantGrant } from "../../lib/assistant-grants";
import { db, getAuth } from "../auth";
import { appOrigin } from "../origin";
import { listGrants, takeBack } from "./grants";

const TakeBack = z.object({ clientId: z.string().min(1).max(256) });

function answer(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

/** The same whether the app does not exist or this person never allowed it. */
const notFound = () => answer({ ok: false, error: "Not found" }, 404);

/** The signed-in person's id, or null. Grants are theirs, so no workspace comes into it. */
async function signedIn(headers: Headers): Promise<string | null> {
	const session = await getAuth().api.getSession({ headers });
	return session?.user.id ?? null;
}

/** The assistants the signed-in person allowed. Empty for nobody, so a page learns nothing. */
export async function grantsOfSession(): Promise<AssistantGrant[]> {
	const userId = await signedIn(getRequestHeaders());
	return userId ? listGrants(db.$client, userId) : [];
}

export async function readGrants(): Promise<Response> {
	const userId = await signedIn(getRequestHeaders());
	if (!userId) return answer({ ok: false, error: "Not signed in" }, 401);
	return answer({ ok: true, grants: await listGrants(db.$client, userId) });
}

/**
 * Takes back one of the caller's own grants. The person is the session's, never a field of the
 * request, and the Origin must be the app's own, as for the other settings that write.
 */
export async function takeBackFromRequest(request: Request): Promise<Response> {
	if (request.headers.get("origin") !== appOrigin()) {
		return answer({ ok: false, error: "Not allowed from there" }, 403);
	}
	const userId = await signedIn(request.headers);
	if (!userId) return answer({ ok: false, error: "Not signed in" }, 401);
	const parsed = TakeBack.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return answer({ ok: false, error: "Not a request." }, 400);
	return (await takeBack(db.$client, userId, parsed.data.clientId))
		? answer({ ok: true })
		: notFound();
}
