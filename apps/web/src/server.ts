import { env } from "cloudflare:workers";
import handler from "@tanstack/react-start/server-entry";
import { db, handleAuthRequest } from "./server/auth";
import { scanDue } from "./server/connections/scan";
import { pruneExpired } from "./server/db/prune";
import { mailer } from "./server/email";
import { handleMcpRequest, isMcpRequest } from "./server/mcp";
import { sendAlerts, sendDigests } from "./server/notifications/send";
import { resealSecrets } from "./server/reseal-secrets";
import { newNonce, withSecurityHeaders } from "./server/security-headers";
import { sweepConnect } from "./server/track/connect";

export { RateLimiter } from "./server/rate-limit";

/** The hourly Cron Trigger, as `wrangler.jsonc` writes it. The other one is the daily run. */
const SCAN_CRON = "0 * * * *";

/** OAuth discovery documents for MCP clients. Better Auth serves them at the root. */
const OAUTH_DISCOVERY =
	/^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)(\/|$)/;

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
	const url = new URL(request.url);
	// Assistants call this with an access token and no cookie; it never reaches a page's handlers.
	if (isMcpRequest(url)) return handleMcpRequest(request);
	if (OAUTH_DISCOVERY.test(url.pathname)) return handleAuthRequest(request);
	return handler.fetch(request, { context: { nonce } });
}

/**
 * Tells members what the scans found: an email for new critical and high findings, and on Monday at
 * 08:00 UTC the weekly summary. It runs after the scans, and a failure here never fails them.
 */
async function notify(scheduledTime: number) {
	const deps = {
		db,
		mailer,
		origin: env.BETTER_AUTH_URL ? new URL(env.BETTER_AUTH_URL).origin : undefined,
	};
	try {
		// Alerts go by the clock, not the schedule: a finding is told once it exists, and the
		// scans above have only just written some.
		const alerts = await sendAlerts(deps);
		const digests = await sendDigests(deps, scheduledTime);
		// Counts only: who was told, and about what, is the workspace's own business.
		if (alerts.sent > 0 || digests.sent > 0) {
			console.log(`notifications: ${JSON.stringify({ alerts, digests })}`);
		}
	} catch (error) {
		console.error(`notifications: ${error instanceof Error ? error.name : "failure"}`);
	}
}

export default {
	async fetch(request) {
		const nonce = newNonce();
		const response = await route(request, nonce);
		// Vite's dev server adds inline scripts of its own for hot reload, which have no nonce.
		if (import.meta.env.DEV) return response;
		return withSecurityHeaders(request, response, { nonce, oidcIssuer: env.OIDC_ISSUER });
	},
	// Two Cron Triggers (wrangler.jsonc). Every hour, scans the connections whose time has come and
	// then sends the alerts and, on Monday at 08:00 UTC, the weekly summary.
	// Once a day, clears what is past its time and, after SECRETS_KEY changed, seals workspaces'
	// secrets again under it.
	async scheduled(controller) {
		const startedAt = Date.now();
		if (controller.cron === SCAN_CRON) {
			const scans = await scanDue({ db, settings: env });
			// Counts only: a connection's name or target is the workspace's own business.
			if (scans.scanned > 0) console.log(`scans: ${JSON.stringify(scans)}`);
			await notify(controller.scheduledTime);
			return;
		}
		try {
			await pruneExpired(db);
		} catch {
			console.error("prune: failed");
		}
		try {
			const secrets = await resealSecrets(db, env, startedAt);
			if (secrets) {
				(secrets.unopened > 0 ? console.error : console.log)(
					`secrets: primary=${secrets.primary} previous=${secrets.previous ?? "none"} resealed=${secrets.resealed} unopened=${secrets.unopened} left=${secrets.left} settled=${secrets.settled}`,
				);
			}
		} catch {
			console.error("secrets: failed");
		}
		try {
			await sweepConnect();
		} catch {
			console.error("Track cleanup failed");
		}
	},
} satisfies ExportedHandler<Cloudflare.Env>;
