import { and, eq, gt } from "drizzle-orm";
import type { MemberRole } from "#/lib/roles";
import type { Database } from "./db";
import { schema } from "./db";

export interface Membership {
	/** The membership's own id. */
	memberId: string;
	workspaceId: string;
	workspaceName: string;
	role: MemberRole;
}

/** Resolves a workspace slug to the caller's membership, or null if they are not a member. */
export async function findMembership(
	db: Database,
	slug: string,
	userId: string,
): Promise<Membership | null> {
	const row = await db
		.select({
			memberId: schema.member.id,
			workspaceId: schema.member.organizationId,
			workspaceName: schema.organization.name,
			role: schema.member.role,
		})
		.from(schema.member)
		.innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
		.where(and(eq(schema.organization.slug, slug), eq(schema.member.userId, userId)))
		.get();
	return row ? { ...row, role: toRole(row.role) } : null;
}

export interface InvitationPreview {
	workspaceName: string;
	workspaceSlug: string;
	inviterName: string;
	email: string;
	role: MemberRole;
	expiresAt: number;
}

/**
 * A pending, unexpired invitation, with what its recipient needs to decide before signing in.
 * The id is the secret here, just as it is in the invitation link.
 */
export async function findPendingInvitation(
	db: Database,
	invitationId: string,
): Promise<InvitationPreview | null> {
	const row = await db
		.select({
			workspaceName: schema.organization.name,
			workspaceSlug: schema.organization.slug,
			inviterName: schema.user.name,
			email: schema.invitation.email,
			role: schema.invitation.role,
			expiresAt: schema.invitation.expiresAt,
		})
		.from(schema.invitation)
		.innerJoin(schema.organization, eq(schema.invitation.organizationId, schema.organization.id))
		.innerJoin(schema.user, eq(schema.invitation.inviterId, schema.user.id))
		.where(
			and(
				eq(schema.invitation.id, invitationId),
				eq(schema.invitation.status, "pending"),
				gt(schema.invitation.expiresAt, new Date()),
			),
		)
		.get();
	return row
		? { ...row, role: toRole(row.role ?? "member"), expiresAt: row.expiresAt.getTime() }
		: null;
}

/**
 * Better Auth stores roles as a comma-separated list; the highest one wins. A role this version
 * doesn't know gets the least there is, a member's, rather than an admin's.
 */
export function toRole(role: string): MemberRole {
	const roles = role.split(",").map((r) => r.trim());
	if (roles.includes("owner")) return "owner";
	if (roles.includes("admin")) return "admin";
	return "member";
}
