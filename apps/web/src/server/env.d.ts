// Optional configuration. Required secrets are declared under `secrets.required` in
// wrangler.jsonc, which is what `wrangler types` generates the rest of `Cloudflare.Env` from.
declare namespace Cloudflare {
	interface Env {
		/** Public URL of the app. Inferred from the request when unset. */
		BETTER_AUTH_URL?: string;
		GITHUB_CLIENT_ID?: string;
		GITHUB_CLIENT_SECRET?: string;
		/**
		 * An OpenID Connect provider to sign in through: its issuer URL and this deployment's client
		 * id and secret there. Needs all three. See docs/self-hosting.md.
		 */
		OIDC_ISSUER?: string;
		OIDC_CLIENT_ID?: string;
		OIDC_CLIENT_SECRET?: string;
		/** What the sign-in button calls it, as in "Continue with Gateweave". */
		OIDC_PROVIDER_NAME?: string;
		/**
		 * Who email comes from, such as `Gateweave Guard <guard@example.com>`. The domain must be
		 * onboarded to Cloudflare Email Sending. Email is off when unset.
		 */
		EMAIL_FROM?: string;
		/**
		 * Keeps the Durable Objects of this deployment in a jurisdiction (`eu`, `us`, `fedramp` or
		 * `fedramp-high`), as the rate limits' are. A name Cloudflare doesn't know fails the request:
		 * the operator asked for their data to stay somewhere. None when unset.
		 */
		DURABLE_OBJECT_JURISDICTION?: string;
		/**
		 * Where someone without a way in can ask for one once the owner has closed sign-up: an https
		 * address, shown as "Ask for access" on the sign-in pages. No link when unset.
		 */
		SIGN_UP_REQUEST_URL?: string;
		/**
		 * The addresses of this deployment's legal pages, linked from the sign-in pages and the
		 * workspace menu. Each is left out when unset, or when it is not an http(s) address.
		 */
		LEGAL_NOTICE_URL?: string;
		PRIVACY_POLICY_URL?: string;
		TERMS_URL?: string;
	}
}
