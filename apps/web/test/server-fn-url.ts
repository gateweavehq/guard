import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { origin } from "./connections-world";

const assets = join(resolve(import.meta.dirname, ".."), "dist/server/assets");
export function serverFnUrl(name: string) {
	for (const file of readdirSync(assets).filter((each) => each.endsWith(".js"))) {
		const id = new RegExp(
			`"([0-9a-f]{64})": \\{\\s*functionName: "${name}_createServerFn_handler"`,
		).exec(readFileSync(join(assets, file), "utf8"))?.[1];
		if (id) return `${origin}/_serverFn/${id}`;
	}
	throw new Error(`No server function ${name} in the build`);
}
