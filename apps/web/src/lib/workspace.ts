import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** The signed-in user's membership in the workspace with this slug, or null. */
export const getWorkspace = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }) => {
		const { currentMember } = await import("#/server/access");
		const { db } = await import("#/server/auth");
		const { ownsServer } = await import("#/server/auth/deployment");
		const { legalLinks } = await import("#/server/legal");
		const member = await currentMember(slug);
		if (!member) return null;
		const { user, membership } = member;
		return {
			id: membership.workspaceId,
			slug,
			name: membership.workspaceName,
			role: membership.role,
			userId: user.id,
			/** Whether this person runs the server, which is what shows them its page. */
			ownsServer: await ownsServer(db, user.id),
			user: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
			legal: legalLinks(),
		};
	});

export type Workspace = NonNullable<Awaited<ReturnType<typeof getWorkspace>>>;
