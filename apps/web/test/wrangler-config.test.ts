import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

describe("what a deploy does to settings", () => {
	it("leaves alone what someone set in the dashboard", () => {
		// Wrangler otherwise removes a plain-text variable it does not find in this file, so the next
		// push would quietly take away a spending limit, or turn off email or a server's legal pages.
		const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
		expect(unstable_readConfig({ config }).keep_vars).toBe(true);
	});
});

describe("what a branch's Preview gets", () => {
	it("builds, with none of production's resources", () => {
		// Wrangler refuses to build a Preview without this block, which fails every push to a branch,
		// Dependabot's included.
		const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
		const { previews } = unstable_readConfig({ config });
		expect(previews).toBeDefined();
		expect(previews?.d1_databases ?? []).toEqual([]);
	});
});

describe("where Gateweave Cloud keeps its data", () => {
	const config = resolve(import.meta.dirname, "../../../wrangler.jsonc");
	const read = (env: string) => unstable_readConfig({ config, env }, { hideWarnings: true });

	it.each(["staging", "cloud"])("keeps %s's Durable Objects in the EU", (env) => {
		// The rate limits count by address, so the objects stay where the databases are.
		expect(read(env).vars.DURABLE_OBJECT_JURISDICTION).toBe("eu");
	});

	it.each(["staging", "cloud"])(
		"gives %s the bindings the Worker needs, as none are inherited",
		(env) => {
			const { d1_databases, durable_objects, send_email } = read(env);
			expect(d1_databases.map(({ binding }: { binding: string }) => binding)).toEqual(["DB"]);
			expect(durable_objects.bindings.map(({ name }: { name: string }) => name)).toEqual([
				"RATE_LIMITER",
			]);
			expect(send_email.map(({ name }: { name: string }) => name)).toEqual(["EMAIL"]);
		},
	);

	it("gives each environment a database of its own", () => {
		const database = (env: string) =>
			read(env).d1_databases.find(({ binding }: { binding: string }) => binding === "DB");
		expect(database("staging")?.database_id).not.toBe(database("cloud")?.database_id);
	});
});
