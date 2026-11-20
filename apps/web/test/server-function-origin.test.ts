import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { origin, startWorld, type World } from "./connections-world";
import { serverFnUrl } from "./server-fn-url";

// A server function has an address of its own, and a browser sends the person's session cookie to
// it wherever the request is from. The framework refuses one that is not from the app's own origin,
// until an app exports a start instance: then only the request middleware the instance lists runs,
// and `src/start.ts` listed none. So another site could ask a server function as the person who
// was signed in. These ask one in the Worker as it deploys, the way a browser would from each
// place.

const ELSEWHERE = "https://elsewhere.example";

let world: World;

beforeAll(async () => {
	world = await startWorld();
});

afterAll(async () => {
	await world?.dispose();
});

/**
 * Asks `getWorkspace` for the owner's workspace with the owner's cookie, and with these headers
 * saying where the request is from. The answer to the app holds who the owner is.
 */
async function askWorkspace(from: Record<string, string>) {
	// Seroval's JSON for `{ data: slug }`.
	const payload = JSON.stringify({
		t: { t: 10, i: 0, p: { k: ["data"], v: [{ t: 1, s: world.slug }] }, o: 0 },
		f: 0,
		m: [],
	});
	const response = await world.guard.fetch(
		`${serverFnUrl("getWorkspace")}?payload=${encodeURIComponent(payload)}`,
		{
			headers: {
				"x-tsr-serverFn": "true",
				accept: "application/json",
				cookie: world.owner.headers.cookie,
				...from,
			},
		},
	);
	return { status: response.status, text: await response.text() };
}

/** How many queries of D1 the Worker has logged as failed. */
const failedQueries = () =>
	world.guard.logs.filter((log) => log.message.includes("d1: a query failed")).length;

/** Runs `work` with the table of members out of reach, so that a handler that runs is seen to. */
async function withoutMembers<Result>(work: () => Promise<Result>): Promise<Result> {
	await world.guard.db.exec("ALTER TABLE member RENAME TO member_gone");
	try {
		return await work();
	} finally {
		await world.guard.db.exec("ALTER TABLE member_gone RENAME TO member");
	}
}

describe("a server function asked from somewhere else, with the person's cookie", () => {
	const places: [string, Record<string, string>][] = [
		// A link or a form on another site that opens the address: no Origin on a GET.
		["a page of another site", { "sec-fetch-site": "cross-site" }],
		["a script of another site", { "sec-fetch-site": "cross-site", origin: ELSEWHERE }],
		// What the browser says of the request counts before what the Origin header says.
		["another site that names the app's origin", { "sec-fetch-site": "cross-site", origin }],
		["another host of the same site", { "sec-fetch-site": "same-site" }],
		// A browser too old to say Sec-Fetch-Site.
		["another origin, by Origin alone", { origin: ELSEWHERE }],
		["another origin, by Referer alone", { referer: `${ELSEWHERE}/a-page` }],
		// The origin as the start of another host's name.
		["a host that begins as the app's does", { referer: `${origin}.elsewhere.example/` }],
		// Nothing says where it is from, so nothing says it is from here.
		["nowhere it says", {}],
	];

	it.each(places)("is refused from %s, and tells nothing", async (_place, from) => {
		const answer = await askWorkspace(from);

		expect(answer.status).toBe(403);
		expect(answer.text).toBe("Forbidden");
		expect(answer.text).not.toContain(world.owner.userId);
	});

	it.each(places)("does not run its handler from %s", async (_place, from) => {
		// The handler looks the membership up. With the table gone, one that ran is in the log.
		const before = failedQueries();
		const answer = await withoutMembers(() => askWorkspace(from));

		expect(answer.status).toBe(403);
		expect(failedQueries()).toBe(before);
	});
});

describe("a server function asked from the app", () => {
	const places: [string, Record<string, string>][] = [
		["a browser that says same-origin", { "sec-fetch-site": "same-origin", origin }],
		["a browser that says same-origin and sends no Origin", { "sec-fetch-site": "same-origin" }],
		["its own origin, by Origin alone", { origin }],
		["its own origin, by Referer alone", { referer: `${origin}/settings/account` }],
	];

	it.each(places)("answers %s as before", async (_place, from) => {
		const answer = await askWorkspace(from);

		expect(answer.status).toBe(200);
		expect(answer.text).toContain(world.owner.userId);
		expect(answer.text).toContain("owner@example.com");
	});

	it("runs its handler, which the log shows when its read fails", async () => {
		const before = failedQueries();
		await withoutMembers(() => askWorkspace({ "sec-fetch-site": "same-origin", origin }));

		expect(failedQueries()).toBe(before + 1);
	});
});

// The guard is for server functions alone. A link from another site still opens a page, and the
// routes under `/api/` keep their own answers.
describe("what is not a server function", () => {
	it("opens a page that another site linked to", async () => {
		const response = await world.guard.fetch(`${origin}/login`, {
			headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
		});

		expect(response.status).toBe(200);
	});

	it("answers a read under /api/ that says nothing of where it is from", async () => {
		const response = await world.guard.fetch(`${origin}/api/connections/${world.slug}`, {
			headers: { cookie: world.owner.headers.cookie },
		});

		expect(response.status).toBe(200);
	});
});
