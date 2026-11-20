import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { isSealer, sealerFor } from "../src/server/secrets";

const script = fileURLToPath(new URL("../../../scripts/secrets-key-id.mjs", import.meta.url));
it("prints the same id that the Worker includes in a seal", async () => {
	const key = randomBytes(32).toString("base64");
	const sealer = await sealerFor({ SECRETS_KEY: key }, "test");
	if (!isSealer(sealer)) throw Error("Missing test key");
	const id = (await sealer.seal("sample", "sample")).split(".")[1];
	const result = spawnSync(process.execPath, [script], { input: `${key}\n`, encoding: "utf8" });
	expect(result.status).toBe(0);
	expect(result.stdout).toBe(`${id}\n`);
	expect(result.stderr).toBe("");
});
it("refuses a short key without printing it", () => {
	const key = randomBytes(31).toString("base64");
	const result = spawnSync(process.execPath, [script], { input: key, encoding: "utf8" });
	expect(result.status).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr.includes(key)).toBe(false);
});
