import { describe, expect, it, vi } from "vitest";
import { eventBody, postEvent } from "./source-event";

const facts = {
	fingerprint: "demo",
	severity: "moderate" as const,
	kind: "advisory",
	subject: "package",
	fixedVersion: "2",
	title: "Update dependency",
};
const url = "https://guard.example/team/findings#finding-1";

describe("Track source events", () => {
	it.each([
		["critical", "critical"],
		["high", "high"],
		["moderate", "medium"],
		["low", "low"],
		["unknown", "unknown"],
	] as const)("maps %s to %s", (severity, expected) => {
		expect(JSON.parse(eventBody({ ...facts, severity }, "open", 1, url) ?? "null")).toEqual({
			key: "demo",
			severity: expected,
			state: "open",
			sentAt: "1970-01-01T00:00:00.001Z",
			title: facts.title,
			subject: facts.subject,
			type: facts.kind,
			body: "package\nadvisory\nFixed in 2",
			url,
		});
	});
	it("fits the serialized UTF-8 budget and preserves the signal key", () => {
		for (const length of [1, 13000, 14500, 15200]) {
			const fingerprint = "k".repeat(length);
			const result = eventBody(
				{
					...facts,
					fingerprint,
					kind: "界".repeat(16384),
					subject: "\u0001".repeat(4010),
					title: `${"A".repeat(511)}🙂`,
				},
				"dismissed",
				0,
				url,
			);
			expect(result).not.toBeNull();
			expect(new TextEncoder().encode(result ?? "").length).toBeLessThanOrEqual(16384);
			const event = JSON.parse(result ?? "{}");
			expect(event.key).toBe(fingerprint);
			expect(event.title.length).toBeLessThanOrEqual(512);
			expect(event.type?.length ?? 0).toBeLessThanOrEqual(200);
			expect(event.subject?.length ?? 0).toBeLessThanOrEqual(200);
			expect(event.body.length).toBeLessThanOrEqual(4000);
			if (length === 1) expect(event.type).toHaveLength(200);
			if (!event.type) expect(event.body).toBe("");
			if (!event.subject) expect(event.type).toBeUndefined();
		}
		expect(eventBody({ ...facts, fingerprint: "界".repeat(16384) }, "open", 0, url)).toBeNull();
	});
	it("sends only to the configured origin and rejects unsafe issue links and incomplete answers", async () => {
		for (const reply of [
			{ state: "open", filed: true, issue: { key: "X", url: "https://elsewhere.test/issue/X" } },
			{},
		]) {
			const fetcher = vi.fn(async () => Response.json(reply));
			expect(await postEvent("https://track.test", "secret", "{}", fetcher)).toMatchObject({
				status: "invalid_response",
			});
			expect(fetcher).toHaveBeenCalledWith(
				"https://track.test/api/events",
				expect.objectContaining({
					method: "POST",
					redirect: "manual",
					headers: { authorization: "Bearer secret", "content-type": "application/json" },
					body: "{}",
				}),
			);
		}
		const failure = await postEvent("https://track.test", "secret", "{}", async () => {
			throw Error("secret");
		});
		expect(failure).toEqual({ status: "unreachable" });
	});
});
