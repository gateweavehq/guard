import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import { db } from "./server/auth";
import { scanDue } from "./server/connections/scan";
import { pruneExpired } from "./server/db/prune";
import { resealSecrets } from "./server/reseal-secrets";
import { newNonce, withSecurityHeaders } from "./server/security-headers";

export { RateLimiter } from "./server/rate-limit";

/** The hourly Cron Trigger, as `wrangler.jsonc` writes it. The other one is the daily run. */
const SCAN_CRON = "0 * * * *";

/**
 * A branch's Preview gets none of the Worker's bindings or secrets, and accounts can't be run safely
 * without the database and the secret. So such a deployment serves nothing else.
 */
function notSetUp() {
	return new Response(
		"This deployment has no database or no BETTER_AUTH_SECRET, so it serves nothing. A Preview of a branch gets neither by itself: see Preview builds in docs/self-hosting.md.\n",
		{ status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
	);
}

function route(request: Request, nonce: string): Response | Promise<Response> {
	if (!env.DB || !env.BETTER_AUTH_SECRET) return notSetUp();
	return handler.fetch(request, { context: { nonce } });
}

export default {
	async fetch(request) {
		const nonce = newNonce();
		const response = await route(request, nonce);
		// Vite's dev server adds inline scripts of its own for hot reload, which have no nonce.
		if (import.meta.env.DEV) return response;
		return withSecurityHeaders(request, response, { nonce, oidcIssuer: env.OIDC_ISSUER });
	},
	// Two Cron Triggers (wrangler.jsonc). Every hour, scans the connections whose time has come.
	// Once a day, clears what is past its time and, after SECRETS_KEY changed, seals workspaces'
	// secrets again under it.
	async scheduled(controller) {
		if (controller.cron === SCAN_CRON) {
			const scans = await scanDue({ db, settings: env });
			// Counts only: a connection's name or target is the workspace's own business.
			if (scans.scanned > 0) console.log(`scans: ${JSON.stringify(scans)}`);
			return;
		}
		await pruneExpired(db);
		const secrets = await resealSecrets(db, env);
		// Counts only. While `left` isn't 0, SECRETS_KEY_PREVIOUS is still needed.
		if (secrets && (secrets.resealed > 0 || secrets.left > 0)) {
			(secrets.unopened > 0 ? console.error : console.log)(`secrets: ${JSON.stringify(secrets)}`);
		}
	},
} satisfies ExportedHandler<Cloudflare.Env>;
