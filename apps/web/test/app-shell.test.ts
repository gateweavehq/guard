import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startGuard } from "./guard-worker";

// What a workspace shows once someone has signed in and made one: a page each for findings and
// connections, an honest empty state where nothing is built yet, and the server's page for whoever
// runs the deployment alone.

const origin = "https://guard.test";

let guard: Awaited<ReturnType<typeof startGuard>>;
let owner: Record<string, string>;
let member: Record<string, string>;

async function page(path: string, headers: Record<string, string>) {
	const response = await guard.fetch(`${origin}${path}`, {
		headers: { cookie: headers.cookie ?? "" },
	});
	return { response, html: await response.text() };
}

beforeAll(async () => {
	guard = await startGuard(origin);
	// The first account of a deployment runs it.
	owner = (await signUp(guard, origin, "shell-owner")).headers;
	await createWorkspace(guard, origin, owner, "shell");
	member = (await signUp(guard, origin, "shell-member")).headers;
	await createWorkspace(guard, origin, member, "elsewhere");
});

afterAll(async () => {
	await guard?.dispose();
});

describe("a workspace", () => {
	it("opens on its findings", async () => {
		const response = await guard.fetch(`${origin}/shell`, {
			headers: { cookie: owner.cookie ?? "" },
		});
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe("/shell/findings");
	});

	it("says there are no findings, rather than showing an example", async () => {
		const { response, html } = await page("/shell/findings", owner);
		expect(response.status).toBe(200);
		expect(html).toContain("No findings yet.");
		expect(html).toContain("Connect a Cloudflare account or a GitHub repository to start.");
	});

	it("says nothing is connected", async () => {
		const { response, html } = await page("/shell/connections", owner);
		expect(response.status).toBe(200);
		expect(html).toContain("Nothing connected yet.");
	});

	it("names its places in the navigation", async () => {
		const { html } = await page("/shell/findings", owner);
		for (const place of ["Findings", "Connections", "Settings"]) expect(html).toContain(place);
	});

	it("is not shown to someone who is not in it, in the words for a workspace that is not there", async () => {
		const { html: theirs } = await page("/shell/findings", member);
		const { html: missing } = await page("/nowhere/findings", member);
		expect(theirs).toContain("Workspace not found");
		expect(missing).toContain("Workspace not found");
		expect(theirs).not.toContain("No findings yet.");
	});
});

describe("the server's page", () => {
	it("is in the navigation of whoever runs the deployment", async () => {
		const { html } = await page("/shell/findings", owner);
		expect(html).toContain("/shell/server");
	});

	it("is not in anyone else's navigation, and is not found for them", async () => {
		const { html } = await page("/elsewhere/findings", member);
		expect(html).not.toContain("/elsewhere/server");
		const { html: asked } = await page("/elsewhere/server", member);
		expect(asked).toContain("Page not found");
		expect(asked).not.toContain("Sign-up");
	});
});
