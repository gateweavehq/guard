import { toBase64 } from "../base64";

/**
 * What a sealed Track key is bound to: its workspace. A sealed value copied into another
 * workspace's row, or into a connection's, does not open there.
 */
export const trackKeyPlace = (workspaceId: string) => `integration/${workspaceId}/track-key`;

export const sourceKeyPlace = (id: string) => `connection/${id}/track-source-key`;

export async function trackDigest(value: string) {
	return toBase64(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
	);
}
