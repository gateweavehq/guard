import type { JWTPayload } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startGuard } from "./guard-worker";
import { LOGOUT_EVENT, OIDC, OIDC_VARS, standInProvider } from "./oidc-provider";
import { fromWorkerOn, whileJunkGoesOn } from "./workers";

// Sign-in through an OpenID Connect provider (AGT-80). Guard never trusts the provider beyond what
// it signed: an existing account links only when both sides have verified the address, and every
// refused sign-in must leave no session behind. A provider that is down must not touch anything
// but its own button, and its logout tokens must end the sessions they name and no others.

const origin = "https://guard.test";
const PASSWORD = "a-long-test-password";

type Provider = Awaited<ReturnType<typeof standInProvider>>;
type Guard = Awaited<ReturnType<typeof startGuard>>;

/** Where the Worker's requests to the provider go. */
function providerHost(provider: Provider) {
	return {
		[new URL(OIDC.issuer).host]: async (request: Request) =>
			(await provider.outbound(request, new URL(request.url))) ??
			new Response("Not the provider", { status: 502 }),
	};
}

function cookieOf(response: Response) {
	return response.headers
		.getSetCookie()
		.map((each) => each.split(";")[0])
		.join("; ");
}

/** Each test comes from its own address, because sign-ins are limited per address. */
let clients = 0;
function newClient() {
	clients += 1;
	return `198.51.100.${clients}`;
}

function authApi(
	guard: Guard,
	path: string,
	init: { client: string; cookie?: string; body: object },
) {
	return guard.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": init.client,
			"content-type": "application/json",
			...(init.cookie && { cookie: init.cookie }),
		},
		body: JSON.stringify(init.body),
	});
}

/** Presses the button: where Guard sends the browser, and the cookie that binds the way back. */
async function pressButton(guard: Guard, client: string) {
	const response = await authApi(guard, "/sign-in/social", {
		client,
		body: { provider: "oidc", callbackURL: "/", errorCallbackURL: "/login" },
	});
	expect(response.status).toBe(200);
	const { url } = (await response.json()) as { url: string };
	return { authorize: new URL(url), cookie: cookieOf(response) };
}

/** Comes back from the provider with a code. */
async function comeBack(
	guard: Guard,
	client: string,
	authorize: URL,
	cookie: string,
	code: string,
) {
	const query = new URLSearchParams({
		code,
		state: authorize.searchParams.get("state") ?? "",
		iss: OIDC.issuer,
	});
	const response = await guard.fetch(`${origin}/api/auth/callback/oidc?${query}`, {
		headers: { cookie, "cf-connecting-ip": client },
	});
	expect(response.status).toBe(302);
	return {
		location: new URL(response.headers.get("location") ?? "", origin),
		cookie: cookieOf(response),
	};
}

async function sessionOf(guard: Guard, cookie: string) {
	const response = await guard.fetch(`${origin}/api/auth/get-session`, { headers: { cookie } });
	return (await response.json()) as null | {
		session: Record<string, unknown>;
		user: { id: string; email: string; name: string; emailVerified: boolean };
	};
}

/** Whether a cookie from `comeBack` is a working session. */
async function isSignedIn(guard: Guard, cookie: string) {
	return (await sessionOf(guard, cookie)) !== null;
}

interface Person {
	sub: string;
	email: string;
	name?: string;
	sid?: string;
	email_verified?: unknown;
}

/** Someone the provider knows signs in to Guard from start to finish. */
async function signIn(guard: Guard, provider: Provider, person: Person, client = newClient()) {
	const { authorize, cookie } = await pressButton(guard, client);
	const code = provider.grant(authorize, {
		name: "Pat Provider",
		email_verified: true,
		...person,
	});
	return comeBack(guard, client, authorize, cookie, code);
}

async function signUpWithPassword(guard: Guard, email: string, client = newClient()) {
	const response = await authApi(guard, "/sign-up/email", {
		client,
		body: { name: "Sam Password", email, password: PASSWORD },
	});
	expect(response.status).toBe(200);
	return cookieOf(response);
}

async function verifyAddress(guard: Guard, email: string) {
	await guard.db.prepare("UPDATE user SET email_verified = 1 WHERE email = ?").bind(email).run();
}

function userRow(guard: Guard, email: string) {
	return guard.db
		.prepare("SELECT id, name, email_verified FROM user WHERE email = ?")
		.bind(email)
		.first<{ id: string; name: string; email_verified: number }>();
}

function providerAccount(guard: Guard, sub: string) {
	return guard.db
		.prepare("SELECT * FROM account WHERE provider_id = 'oidc' AND account_id = ?")
		.bind(sub)
		.first<Record<string, unknown> & { user_id: string }>();
}

async function sessionIdsOf(guard: Guard, userId: string) {
	const { results } = await guard.db
		.prepare("SELECT oidc_sid FROM session WHERE user_id = ?")
		.bind(userId)
		.all();
	return results.map((row: { oidc_sid: string | null }) => row.oidc_sid);
}

describe("signing in through a provider", () => {
	let guard: Guard;
	let provider: Provider;

	beforeAll(async () => {
		provider = await standInProvider();
		guard = await startGuard(origin, {
			settings: OIDC_VARS,
			hosts: providerHost(provider),
		});
	});

	afterAll(async () => {
		await guard?.dispose();
	});

	it("makes an account for someone new, with a verified address", async () => {
		const email = "new@oidc.test";
		const { location, cookie } = await signIn(guard, provider, {
			sub: "sub-new",
			email,
			sid: "sid-new",
		});

		expect(location.pathname).toBe("/");
		const session = await sessionOf(guard, cookie);
		expect(session?.user).toMatchObject({ email, name: "Pat Provider", emailVerified: true });
		expect((await providerAccount(guard, "sub-new"))?.user_id).toBe(session?.user.id);
	});

	it("keeps none of the provider's tokens, the first time or the next", async () => {
		const person = { sub: "sub-tokens", email: "tokens@oidc.test" };
		const noTokens = {
			access_token: null,
			refresh_token: null,
			id_token: null,
			access_token_expires_at: null,
			refresh_token_expires_at: null,
		};

		await signIn(guard, provider, person);
		expect(await providerAccount(guard, person.sub)).toMatchObject(noTokens);

		await signIn(guard, provider, person);
		expect(await providerAccount(guard, person.sub)).toMatchObject(noTokens);
	});

	it("signs them in to the same account again, with the provider's new session", async () => {
		const person = { sub: "sub-again", email: "again@oidc.test" };
		const first = await signIn(guard, provider, { ...person, sid: "sid-first" });
		const second = await signIn(guard, provider, { ...person, sid: "sid-second" });

		const firstUser = await sessionOf(guard, first.cookie);
		const secondUser = await sessionOf(guard, second.cookie);
		expect(secondUser?.user.id).toBe(firstUser?.user.id);
		expect(await sessionIdsOf(guard, secondUser?.user.id ?? "")).toEqual(
			expect.arrayContaining(["sid-first", "sid-second"]),
		);
	});

	it("does not tell the browser which of the provider's sessions it came from", async () => {
		const { cookie } = await signIn(guard, provider, {
			sub: "sub-private",
			email: "private@oidc.test",
			sid: "sid-private",
		});
		const session = await sessionOf(guard, cookie);
		expect(session?.session).toBeDefined();
		expect(JSON.stringify(session)).not.toContain("sid-private");
	});

	it("does not let a browser say which of the provider's sessions it came from", async () => {
		const client = newClient();
		const { cookie } = await signIn(
			guard,
			provider,
			{ sub: "sub-claims", email: "claims@oidc.test", sid: "sid-claims" },
			client,
		);

		await authApi(guard, "/update-session", { client, cookie, body: { oidcSid: "sid-other" } });

		const user = await userRow(guard, "claims@oidc.test");
		expect(await sessionIdsOf(guard, user?.id ?? "")).toEqual(["sid-claims"]);
	});

	it("keeps sign-ins running at once apart", async () => {
		const people = Array.from({ length: 8 }, (_, i) => ({
			sub: `sub-at-once-${i}`,
			email: `at-once-${i}@oidc.test`,
			sid: `sid-at-once-${i}`,
		}));
		await Promise.all(people.map((person) => signIn(guard, provider, person)));
		for (const person of people) {
			const user = await userRow(guard, person.email);
			expect(await sessionIdsOf(guard, user?.id ?? "")).toEqual([person.sid]);
		}
	});

	it("takes the name once, and leaves one they changed here alone", async () => {
		const email = "renamed@oidc.test";
		const person = { sub: "sub-renamed", email, name: "Name At The Provider" };
		const { cookie } = await signIn(guard, provider, person);
		expect((await userRow(guard, email))?.name).toBe("Name At The Provider");

		const renamed = await authApi(guard, "/update-user", {
			client: newClient(),
			cookie,
			body: { name: "Name In Guard" },
		});
		expect(renamed.status).toBe(200);

		await signIn(guard, provider, { ...person, name: "Another Name At The Provider" });
		expect((await userRow(guard, email))?.name).toBe("Name In Guard");
	});

	it("falls back on the email for a name the provider does not give", async () => {
		const email = "nameless@oidc.test";
		await signIn(guard, provider, { sub: "sub-nameless", email, name: "" });
		expect((await userRow(guard, email))?.name).toBe(email);
	});

	it("asks the provider for what the ID token leaves out", async () => {
		const client = newClient();
		const email = "userinfo@oidc.test";
		const { authorize, cookie } = await pressButton(guard, client);
		const code = provider.grant(
			authorize,
			{ sub: "sub-userinfo", sid: "sid-userinfo" },
			{ userInfo: { sub: "sub-userinfo", email, email_verified: true, name: "Una Info" } },
		);
		const back = await comeBack(guard, client, authorize, cookie, code);

		const session = await sessionOf(guard, back.cookie);
		expect(session?.user).toMatchObject({ email, name: "Una Info", emailVerified: true });
		expect(await sessionIdsOf(guard, session?.user.id ?? "")).toEqual(["sid-userinfo"]);
	});

	it("leaves the provider alone when someone signs out of Guard", async () => {
		const client = newClient();
		const { cookie } = await signIn(guard, provider, {
			sub: "sub-signs-out",
			email: "signs-out@oidc.test",
		});
		const response = await authApi(guard, "/sign-out", { client, cookie, body: {} });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
		expect(await isSignedIn(guard, cookie)).toBe(false);
	});

	describe("an account that already has the address", () => {
		it("links when both sides have verified it", async () => {
			const email = "links@oidc.test";
			const password = await signUpWithPassword(guard, email);
			await verifyAddress(guard, email);

			const { cookie, location } = await signIn(guard, provider, { sub: "sub-links", email });

			expect(location.searchParams.get("error")).toBeNull();
			const user = await sessionOf(guard, password);
			expect((await sessionOf(guard, cookie))?.user.id).toBe(user?.user.id);
			expect((await providerAccount(guard, "sub-links"))?.user_id).toBe(user?.user.id);
		});

		it("is left alone when the provider has not verified it", async () => {
			const email = "provider-unverified@oidc.test";
			await signUpWithPassword(guard, email);
			await verifyAddress(guard, email);

			const { cookie, location } = await signIn(guard, provider, {
				sub: "sub-provider-unverified",
				email,
				email_verified: false,
			});

			expect(location.pathname).toBe("/login");
			expect(location.searchParams.get("error")).toBe("account_not_linked");
			expect(await isSignedIn(guard, cookie)).toBe(false);
			expect(await providerAccount(guard, "sub-provider-unverified")).toBeNull();
		});

		it("is left alone when the provider says so only in words", async () => {
			const email = "provider-words@oidc.test";
			await signUpWithPassword(guard, email);
			await verifyAddress(guard, email);

			const { cookie, location } = await signIn(guard, provider, {
				sub: "sub-provider-words",
				email,
				email_verified: "false",
			});

			expect(location.searchParams.get("error")).toBe("account_not_linked");
			expect(await isSignedIn(guard, cookie)).toBe(false);
		});

		it("is left alone when Guard has not verified it", async () => {
			const email = "guard-unverified@oidc.test";
			await signUpWithPassword(guard, email);

			const { cookie, location } = await signIn(guard, provider, {
				sub: "sub-guard-unverified",
				email,
			});

			expect(location.searchParams.get("error")).toBe("account_not_linked");
			expect(await isSignedIn(guard, cookie)).toBe(false);
			expect(await providerAccount(guard, "sub-guard-unverified")).toBeNull();
		});
	});

	describe("an ID token that does not hold up", () => {
		const cases: [string, JWTPayload, "stranger"?][] = [
			["signed with another key", {}, "stranger"],
			["from another issuer", { iss: "https://elsewhere.test" }],
			["for another app", { aud: "another-client" }],
			["for another sign-in", { nonce: "another-nonce" }],
			["with no nonce", { nonce: undefined }],
			["expired", { exp: Math.floor(Date.now() / 1000) - 600 }],
		];

		it.each(cases)("refuses one %s", async (name, claims, signer) => {
			const client = newClient();
			const sub = `sub-${name.replaceAll(" ", "-")}`;
			const email = `${sub}@oidc.test`;
			const { authorize, cookie } = await pressButton(guard, client);
			const code = provider.grant(
				authorize,
				{ sub, email, email_verified: true, ...claims },
				signer ? { key: await provider.strangerKey() } : {},
			);

			const back = await comeBack(guard, client, authorize, cookie, code);

			expect(back.location.pathname).toBe("/login");
			expect(back.location.searchParams.get("error")).toBeTruthy();
			expect(await isSignedIn(guard, back.cookie)).toBe(false);
			expect(await userRow(guard, email)).toBeNull();
		});
	});

	it("refuses a code that came back on someone else's cookie", async () => {
		const client = newClient();
		const email = "stolen-state@oidc.test";
		const { authorize } = await pressButton(guard, client);
		const code = provider.grant(authorize, { sub: "sub-stolen", email, email_verified: true });
		const other = await pressButton(guard, client);

		const back = await comeBack(guard, client, authorize, other.cookie, code);

		expect(back.location.searchParams.get("error")).toBeTruthy();
		expect(await isSignedIn(guard, back.cookie)).toBe(false);
		expect(await userRow(guard, email)).toBeNull();
	});
});

describe("a provider that is not answering", () => {
	it("costs nothing but its own button, which works once it is back", async () => {
		const provider = await standInProvider();
		provider.go("down");
		const guard = await startGuard(origin, {
			settings: OIDC_VARS,
			hosts: providerHost(provider),
		});
		try {
			const client = newClient();
			const email = "password-while-down@oidc.test";
			const cookie = await signUpWithPassword(guard, email, client);
			expect((await sessionOf(guard, cookie))?.user.email).toBe(email);
			const again = await authApi(guard, "/sign-in/email", {
				client,
				body: { email, password: PASSWORD },
			});
			expect(again.status).toBe(200);
			const page = await guard.fetch(`${origin}/login`);
			expect(page.status).toBe(200);
			// None of that asked it anything.
			expect(provider.requests).toEqual([]);

			const pressed = await authApi(guard, "/sign-in/social", {
				client: newClient(),
				body: { provider: "oidc", callbackURL: "/" },
			});
			expect(pressed.status).toBe(404);
			expect(await pressed.json()).toMatchObject({ code: "PROVIDER_NOT_FOUND" });
			expect(provider.requests).toEqual(["/.well-known/openid-configuration"]);

			provider.go("up");
			const back = await signIn(guard, provider, {
				sub: "sub-back-up",
				email: "back-up@oidc.test",
			});
			expect(await isSignedIn(guard, back.cookie)).toBe(true);
		} finally {
			await guard.dispose();
		}
	});

	it("offers nothing when the provider has no keys to check its tokens with", async () => {
		const provider = await standInProvider();
		provider.go("no-keys");
		const guard = await startGuard(origin, {
			settings: OIDC_VARS,
			hosts: providerHost(provider),
		});
		try {
			const pressed = await authApi(guard, "/sign-in/social", {
				client: newClient(),
				body: { provider: "oidc", callbackURL: "/" },
			});
			expect(pressed.status).toBe(404);
		} finally {
			await guard.dispose();
		}
	});

	it("keeps someone waiting at most 10 seconds, and nobody else at all", async () => {
		const provider = await standInProvider();
		provider.go("hanging");
		const guard = await startGuard(origin, {
			settings: OIDC_VARS,
			hosts: providerHost(provider),
		});
		try {
			const started = Date.now();
			const waiting = authApi(guard, "/sign-in/social", {
				client: newClient(),
				body: { provider: "oidc", callbackURL: "/" },
			});
			// A busy machine can take more than the default second to send it.
			await vi.waitFor(() => expect(provider.requests).not.toEqual([]), { timeout: 5_000 });

			const email = "password-while-hanging@oidc.test";
			const cookie = await signUpWithPassword(guard, email);
			expect((await sessionOf(guard, cookie))?.user.email).toBe(email);
			expect(Date.now() - started).toBeLessThan(9_000);

			const pressed = await waiting;
			expect(pressed.status).toBe(404);
			expect(Date.now() - started).toBeLessThan(15_000);
		} finally {
			await guard.dispose();
		}
	});
});

describe("a provider that stops waiting for the answer to a logout", () => {
	it("still ends the session", async () => {
		const provider = await standInProvider();
		let slowKeys = false;
		const host = new URL(OIDC.issuer).host;
		const guard = await startGuard(origin, {
			isolates: 2,
			settings: OIDC_VARS,
			hosts: {
				[host]: async (request: Request) => {
					const url = new URL(request.url);
					if (slowKeys && url.pathname === "/jwks") {
						await new Promise((resolve) => setTimeout(resolve, 1500));
					}
					return (
						(await provider.outbound(request, url)) ??
						new Response("Not the provider", { status: 502 })
					);
				},
			},
		});
		try {
			const person = { sub: "sub-impatient", email: "impatient@oidc.test", sid: "sid-impatient" };
			const { cookie } = await signIn(guard, provider, person);
			const token = await provider.logoutToken({ sub: person.sub, sid: person.sid });

			// The other isolate has never seen a sign-in, so it has the provider's keys to fetch.
			slowKeys = true;
			const answer = await guard.fetchAndStopWaiting(`${origin}/api/auth/backchannel-logout/oidc`, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"cf-connecting-ip": newClient(),
				},
				body: new URLSearchParams({ logout_token: token }).toString(),
			});
			expect(answer.status).toBe(504);

			await expect
				.poll(() => isSignedIn(guard, cookie), { timeout: 10_000, interval: 250 })
				.toBe(false);
		} finally {
			await guard.dispose();
		}
	});
});

describe("a logout that cannot be checked for now", () => {
	// To the isolate that has never seen a sign-in, so it has the provider's keys to fetch.
	const deliver = (guard: Guard, token: string) =>
		guard.fetchIn(1, `${origin}/api/auth/backchannel-logout/oidc`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"cf-connecting-ip": newClient(),
			},
			body: new URLSearchParams({ logout_token: token }).toString(),
		});

	const failing = () => new Response("Down", { status: 500 });
	const cases: [string, string, () => Response | Promise<Response>][] = [
		["the keys answer with an error", "/jwks", failing],
		["the keys make no sense", "/jwks", () => Response.json({})],
		["the keys do not answer", "/jwks", () => new Promise<Response>(() => {})],
		["discovery has not worked", "/.well-known/openid-configuration", failing],
	];

	it("asks for another try when fetching the keys fails, and ends nothing", async () => {
		const provider = await standInProvider();
		let nowhere = false;
		const host = new URL(OIDC.issuer).host;
		const guard = await startGuard(origin, {
			isolates: 2,
			settings: OIDC_VARS,
			hosts: {
				[host]: async (request: Request) => {
					const url = new URL(request.url);
					const answer =
						(await provider.outbound(request, url)) ??
						new Response("Not the provider", { status: 502 });
					if (!nowhere || !url.pathname.startsWith("/.well-known/")) return answer;
					// A fetch that rejects, as one does when the network fails. A stand-in cannot do that by
					// throwing, which Miniflare turns into a 500, but no Worker can fetch this address.
					const document = (await answer.json()) as object;
					return Response.json({ ...document, jwks_uri: "ftp://provider.test/jwks" });
				},
			},
		});
		try {
			const person = { sub: "sub-nowhere", email: "nowhere@oidc.test", sid: "sid-nowhere" };
			const { cookie } = await signIn(guard, provider, person);
			const token = await provider.logoutToken({ sub: person.sub, sid: person.sid });

			nowhere = true;
			expect((await deliver(guard, token)).status).toBe(503);
			expect(await isSignedIn(guard, cookie)).toBe(true);
		} finally {
			await guard.dispose();
		}
	});

	it.each(cases)("asks for another try when %s, and ends nothing", async (_name, path, down) => {
		const provider = await standInProvider();
		let isDown = false;
		const host = new URL(OIDC.issuer).host;
		const guard = await startGuard(origin, {
			isolates: 2,
			settings: OIDC_VARS,
			hosts: {
				[host]: async (request: Request) => {
					const url = new URL(request.url);
					if (isDown && url.pathname === path) return down();
					return (
						(await provider.outbound(request, url)) ??
						new Response("Not the provider", { status: 502 })
					);
				},
			},
		});
		try {
			const person = { sub: "sub-unchecked", email: "unchecked@oidc.test", sid: "sid-unchecked" };
			const { cookie } = await signIn(guard, provider, person);
			const token = await provider.logoutToken({ sub: person.sub, sid: person.sid });

			isDown = true;
			const answer = await deliver(guard, token);
			expect(answer.status).toBe(503);
			expect(await answer.json()).toEqual({ error: "temporarily_unavailable" });
			expect(await isSignedIn(guard, cookie)).toBe(true);

			isDown = false;
			expect((await deliver(guard, token)).status).toBe(200);
			expect(await isSignedIn(guard, cookie)).toBe(false);
		} finally {
			await guard.dispose();
		}
	});
});

describe("signing out at the provider", () => {
	let guard: Guard;
	let provider: Provider;

	beforeAll(async () => {
		provider = await standInProvider();
		guard = await startGuard(origin, {
			isolates: 2,
			settings: OIDC_VARS,
			hosts: providerHost(provider),
		});
	});

	afterAll(async () => {
		await guard?.dispose();
	});

	/** The provider delivers a logout token. No cookie and no Origin: it is not a browser. */
	function deliver(token: string | undefined, { isolate = 0, id = "oidc" } = {}) {
		return guard.fetchIn(isolate, `${origin}/api/auth/backchannel-logout/${id}`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"cf-connecting-ip": newClient(),
			},
			body: new URLSearchParams(token === undefined ? {} : { logout_token: token }).toString(),
		});
	}

	it("ends the session a token names, and no other of theirs", async () => {
		const person = { sub: "sub-by-sid", email: "by-sid@oidc.test" };
		const ended = await signIn(guard, provider, { ...person, sid: "sid-ended" });
		const kept = await signIn(guard, provider, { ...person, sid: "sid-kept" });

		const response = await deliver(
			await provider.logoutToken({ sub: person.sub, sid: "sid-ended" }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await isSignedIn(guard, ended.cookie)).toBe(false);
		expect(await isSignedIn(guard, kept.cookie)).toBe(true);
	});

	// Changing a password replaces the session it was asked from, and the new one came from the same
	// sign-in at the provider. Signing out there still has to reach it.
	it("ends the session that took over from a named one when a password changed", async () => {
		const email = "changed@oidc.test";
		await signUpWithPassword(guard, email);
		await verifyAddress(guard, email);
		const person = { sub: "sub-changed", email, sid: "sid-changed" };
		const { cookie } = await signIn(guard, provider, person);

		const changed = await authApi(guard, "/change-password", {
			client: newClient(),
			cookie,
			body: { currentPassword: PASSWORD, newPassword: "another-long-test-password" },
		});
		expect(changed.status).toBe(200);
		const after = cookieOf(changed);
		expect(await isSignedIn(guard, cookie)).toBe(false);
		expect(await isSignedIn(guard, after)).toBe(true);

		const response = await deliver(
			await provider.logoutToken({ sub: person.sub, sid: person.sid }),
		);
		expect(response.status).toBe(200);
		expect(await isSignedIn(guard, after)).toBe(false);
	});

	it("ends a session while a Worker on another zone sends junk to the same place", async () => {
		const fromWorker = (zone: string, body: string) =>
			guard.fetchIn(0, `${origin}/api/auth/backchannel-logout/oidc`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded", ...fromWorkerOn(zone) },
				body,
			});
		const person = { sub: "sub-junk", email: "junk@oidc.test" };
		const session = await signIn(guard, provider, { ...person, sid: "sid-junk" });
		const token = await provider.logoutToken({ sub: person.sub, sid: "sid-junk" });

		const { answer, statuses } = await whileJunkGoesOn(
			() => fromWorker("junk.example", "logout_token=junk"),
			110,
			() => fromWorker("provider.example", new URLSearchParams({ logout_token: token }).toString()),
		);

		expect(statuses).toContain(429);
		expect(answer.status).toBe(200);
		expect(await isSignedIn(guard, session.cookie)).toBe(false);
	});

	it("finds a session by its id alone, when that is all a token says", async () => {
		const { cookie } = await signIn(guard, provider, {
			sub: "sub-sid-only",
			email: "sid-only@oidc.test",
			sid: "sid-only",
		});

		expect((await deliver(await provider.logoutToken({ sid: "sid-only" }))).status).toBe(200);

		expect(await isSignedIn(guard, cookie)).toBe(false);
	});

	it("does not end someone's session for a token about somebody else", async () => {
		const { cookie } = await signIn(guard, provider, {
			sub: "sub-bystander",
			email: "bystander@oidc.test",
			sid: "sid-bystander",
		});
		await signIn(guard, provider, {
			sub: "sub-other",
			email: "other@oidc.test",
			sid: "sid-other",
		});

		const response = await deliver(
			await provider.logoutToken({ sub: "sub-other", sid: "sid-bystander" }),
		);

		expect(response.status).toBe(200);
		expect(await isSignedIn(guard, cookie)).toBe(true);
	});

	it("ends all of someone's sessions when a token names only them", async () => {
		const email = "by-sub@oidc.test";
		const password = await signUpWithPassword(guard, email);
		await verifyAddress(guard, email);
		const person = { sub: "sub-by-sub", email };
		const first = await signIn(guard, provider, { ...person, sid: "sid-sub-1" });
		const second = await signIn(guard, provider, { ...person, sid: "sid-sub-2" });
		const bystander = await signIn(guard, provider, {
			sub: "sub-next-door",
			email: "next-door@oidc.test",
			sid: "sid-next-door",
		});

		expect((await deliver(await provider.logoutToken({ sub: person.sub }))).status).toBe(200);

		expect(await isSignedIn(guard, first.cookie)).toBe(false);
		expect(await isSignedIn(guard, second.cookie)).toBe(false);
		expect(await isSignedIn(guard, password)).toBe(false);
		expect(await isSignedIn(guard, bystander.cookie)).toBe(true);
	});

	it("answers 200 about someone it does not know, and ends nothing", async () => {
		const { cookie } = await signIn(guard, provider, {
			sub: "sub-known",
			email: "known@oidc.test",
			sid: "sid-known",
		});

		const response = await deliver(
			await provider.logoutToken({ sub: "sub-nobody", sid: "sid-known" }),
		);

		expect(response.status).toBe(200);
		expect(await isSignedIn(guard, cookie)).toBe(true);
	});

	it("works in an isolate that has never seen a sign-in", async () => {
		const { cookie } = await signIn(guard, provider, {
			sub: "sub-cold",
			email: "cold@oidc.test",
			sid: "sid-cold",
		});

		const response = await deliver(
			await provider.logoutToken({ sub: "sub-cold", sid: "sid-cold" }),
			{ isolate: 1 },
		);

		expect(response.status).toBe(200);
		expect(await isSignedIn(guard, cookie)).toBe(false);
	});

	it("takes a token that leaves out its type", async () => {
		const { cookie } = await signIn(guard, provider, {
			sub: "sub-no-typ",
			email: "no-typ@oidc.test",
			sid: "sid-no-typ",
		});
		const token = await provider.logoutToken({ sid: "sid-no-typ" }, { typ: "" });

		expect((await deliver(token)).status).toBe(200);
		expect(await isSignedIn(guard, cookie)).toBe(false);
	});

	describe("a token that does not hold up", () => {
		const now = () => Math.floor(Date.now() / 1000);
		const victim = { sub: "sub-victim", email: "victim@oidc.test", sid: "sid-victim" };
		const named = { sub: victim.sub, sid: victim.sid };
		let victimCookie: string;

		beforeAll(async () => {
			victimCookie = (await signIn(guard, provider, victim)).cookie;
		});

		const cases: [string, () => Promise<string>][] = [
			[
				"signed with another key",
				async () => provider.logoutToken(named, { key: await provider.strangerKey() }),
			],
			["from another issuer", () => provider.logoutToken({ ...named, iss: "https://x.test" })],
			["for another app", () => provider.logoutToken({ ...named, aud: "another-client" })],
			["of another type", () => provider.logoutToken(named, { typ: "JWT" })],
			["with no event", () => provider.logoutToken({ ...named, events: undefined })],
			[
				"with another event",
				() => provider.logoutToken({ ...named, events: { "https://x.test/event": {} } }),
			],
			["with a nonce", () => provider.logoutToken({ ...named, nonce: "a-nonce" })],
			["naming nobody", () => provider.logoutToken({})],
			["expired", () => provider.logoutToken({ ...named, exp: now() - 600, iat: now() - 900 })],
			["made long ago", () => provider.logoutToken({ ...named, iat: now() - 3600 })],
			["with no date", () => provider.logoutToken({ ...named, iat: undefined })],
			["with no expiry", () => provider.logoutToken({ ...named, exp: undefined })],
			[
				"that is really an ID token",
				() =>
					provider.sign({
						iss: OIDC.issuer,
						aud: OIDC.clientId,
						iat: now(),
						exp: now() + 60,
						nonce: "a-nonce",
						...named,
					}),
			],
			[
				"not signed at all",
				async () => {
					const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
					return `${part({ alg: "none", typ: "logout+jwt" })}.${part({
						iss: OIDC.issuer,
						aud: OIDC.clientId,
						iat: now(),
						exp: now() + 60,
						events: { [LOGOUT_EVENT]: {} },
						...named,
					})}.`;
				},
			],
			["that is no token", async () => "not-a-token"],
		];

		it.each(cases)("refuses one %s", async (_name, make) => {
			const response = await deliver(await make());

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "invalid_request" });
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(await isSignedIn(guard, victimCookie)).toBe(true);
		});

		it("refuses a request with no token", async () => {
			expect((await deliver(undefined)).status).toBe(400);
		});

		it("refuses another provider's address", async () => {
			const token = await provider.logoutToken(named);
			expect((await deliver(token, { id: "github" })).status).toBe(404);
			expect(await isSignedIn(guard, victimCookie)).toBe(true);
		});

		it("takes only the form a provider sends", async () => {
			const response = await guard.fetch(`${origin}/api/auth/backchannel-logout/oidc`, {
				method: "POST",
				headers: { "content-type": "application/json", "cf-connecting-ip": newClient() },
				body: JSON.stringify({ logout_token: await provider.logoutToken(named) }),
			});
			expect(response.status).toBe(415);
			expect(await isSignedIn(guard, victimCookie)).toBe(true);
		});
	});
});

describe("the sign-in page", () => {
	let guard: Guard;
	let provider: Provider;

	const { OIDC_PROVIDER_NAME: _name, ...unnamed } = OIDC_VARS;
	const { OIDC_CLIENT_SECRET: _secret, ...incomplete } = OIDC_VARS;

	beforeAll(async () => {
		provider = await standInProvider();
		guard = await startGuard(origin, {
			isolates: 4,
			isolateSettings: [{}, OIDC_VARS, unnamed, incomplete],
			hosts: providerHost(provider),
		});
	});

	afterAll(async () => {
		await guard?.dispose();
	});

	async function page(isolate: number, query = "") {
		const response = await guard.fetchIn(isolate, `${origin}/login${query}`);
		expect(response.status).toBe(200);
		return response.text();
	}

	it("has no button without a provider", async () => {
		expect(await page(0)).not.toContain("Continue with");
	});

	it("calls the button what the settings say", async () => {
		expect(await page(1)).toContain("Continue with Gateweave");
	});

	it("has a name for a provider that was not given one", async () => {
		expect(await page(2)).toContain("Continue with single sign-on");
	});

	it("has no button with part of the settings", async () => {
		expect(await page(3)).not.toContain("Continue with");
	});

	it("does not offer the provider's way in without a provider", async () => {
		const response = await guard.fetchIn(0, `${origin}/api/auth/sign-in/social`, {
			method: "POST",
			headers: { origin, "content-type": "application/json", "cf-connecting-ip": newClient() },
			body: JSON.stringify({ provider: "oidc", callbackURL: "/" }),
		});
		expect(response.status).toBe(404);
		const logout = await guard.fetchIn(0, `${origin}/api/auth/backchannel-logout/oidc`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "logout_token=x",
		});
		expect(logout.status).toBe(404);
		expect(provider.requests).toEqual([]);
	});

	it("explains a refusal in its own words", async () => {
		expect(await page(1, "?error=account_not_linked")).toContain("already has an account");
		const made = await page(1, `?error=${encodeURIComponent("Call this number")}`);
		// What the page says, since the router also carries its query along in a script.
		const said = /role="alert"[^>]*>([^<]*)</.exec(made)?.[1];
		expect(said).toContain("did not work");
		expect(said).not.toContain("Call this number");
	});
});
