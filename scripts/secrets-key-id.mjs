import { readFileSync } from "node:fs";
import { secretsKeys } from "../apps/web/src/server/secrets-key.ts";

const { current } = await secretsKeys({ SECRETS_KEY: readFileSync(0, "utf8") });
if (current) {
	console.log(current.id);
} else {
	console.error("Expected a base64 key of at least 32 bytes on stdin.");
	process.exitCode = 1;
}
