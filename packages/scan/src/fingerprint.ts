import type { Insight } from "./cloudflare";
import type { InstalledPackage } from "./lockfiles";

// A finding's fingerprint names the problem, not the scan that saw it, so the next scan updates
// the same finding instead of adding another, and a problem that comes back reopens it.

async function fingerprint(parts: readonly string[]): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(parts)),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** By kind and subject rather than Cloudflare's id, which may change when an insight returns. */
export function insightFingerprint(
	accountId: string,
	insight: Pick<Insight, "issueClass" | "subject">,
) {
	return fingerprint(["cloudflare-insight", accountId, insight.issueClass, insight.subject]);
}

/**
 * Without the installed version: moving to another version that is still affected is the same
 * finding. Each lockfile has its own, since a monorepo fixes them one at a time.
 */
export function dependencyFingerprint(
	repositoryId: number,
	lockfilePath: string,
	item: Pick<InstalledPackage, "ecosystem" | "name">,
	advisoryId: string,
) {
	return fingerprint([
		"dependency",
		String(repositoryId),
		lockfilePath,
		item.ecosystem,
		item.name,
		advisoryId,
	]);
}
