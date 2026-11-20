import { z } from "zod";
import type { FindingSeverity } from "../db/connections-schema";

export type SignalState = "open" | "cleared" | "dismissed";
interface Facts {
	fingerprint: string;
	title: string;
	subject: string;
	kind: string;
	fixedVersion: string | null;
	severity: FindingSeverity;
}

function cut(text: string, length: number) {
	// Track counts UTF-16 code units. Keep both halves of a character together.
	return text.slice(0, length).replace(/[\uD800-\uDBFF]$/u, "");
}

const encoder = new TextEncoder();
export function eventBody(facts: Facts, state: SignalState, sentAt: number, url: string) {
	const event = {
		key: facts.fingerprint,
		state,
		sentAt: new Date(sentAt).toISOString(),
		severity: facts.severity === "moderate" ? "medium" : facts.severity,
		title: cut(facts.title, 512),
		type: cut(facts.kind, 200) || undefined,
		subject: cut(facts.subject, 200) || undefined,
		body: cut(
			[facts.subject, facts.kind, facts.fixedVersion && `Fixed in ${facts.fixedVersion}`]
				.filter(Boolean)
				.join("\n"),
			4000,
		),
		url,
	};
	const fits = () => encoder.encode(JSON.stringify(event)).length <= 16384;
	if (!fits()) {
		const original = event.body;
		let low = 0;
		let high = original.length;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			event.body = cut(original, mid);
			if (fits()) low = mid;
			else high = mid - 1;
		}
		event.body = cut(original, low);
		if (!fits()) event.type = undefined;
		if (!fits()) event.subject = undefined;
	}
	return fits() ? JSON.stringify(event) : null;
}

const answerSchema = z.object({
	state: z.enum(["open", "cleared", "dismissed"]),
	filed: z.boolean(),
	issue: z.object({ key: z.string().min(1), url: z.url() }).nullable(),
});

type Reply =
	| { status: "200"; issue: { key: string; url: string } | null }
	| { status: "429"; delay: number }
	| { status: string; issue?: undefined; delay?: undefined };

export async function postEvent(
	address: string,
	key: string,
	body: string,
	fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<Reply> {
	try {
		const response = await fetcher(`${address}/api/events`, {
			method: "POST",
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body,
		});
		if (response.status === 429) {
			const seconds = Number(response.headers.get("Retry-After"));
			return {
				status: "429",
				delay:
					Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 8e12) * 1000 : 60_000,
			};
		}
		if (response.status !== 200) return { status: String(response.status) };
		const answer = answerSchema.safeParse(await response.json());
		if (!answer.success) return { status: "invalid_response" };
		if (answer.data.issue) {
			const url = new URL(answer.data.issue.url);
			if (url.origin !== address || url.username || url.password)
				return { status: "invalid_response" };
		}
		return { status: "200", issue: answer.data.issue };
	} catch {
		return { status: "unreachable" };
	}
}
