import { afterAll, beforeAll, expect, it } from "vitest";
import { startGuard } from "./guard-worker";

// workerd forbids I/O in global scope. Better Auth starts resolving its context as soon as it is
// created, so building it at module load can log an error on every cold start that hides real
// ones. The app builds it on first use instead.

const origin = "https://guard.test";

let guard: Awaited<ReturnType<typeof startGuard>>;

beforeAll(async () => {
	guard = await startGuard(origin);
});

afterAll(async () => {
	await guard?.dispose();
});

it("starts and serves requests without logging an error", async () => {
	await guard.fetch(`${origin}/login`);
	const session = await guard.fetch(`${origin}/api/auth/get-session`, { headers: { origin } });
	expect(session.status).toBe(200);

	expect(guard.logs.filter((log) => log.level === "error")).toEqual([]);
});
