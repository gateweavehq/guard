/**
 * A fetch that answers from a handler and records every request, so the clients are tested
 * against the exact requests they send without reaching Cloudflare, GitHub or OSV.
 */
export function fakeFetch(handler: (request: Request) => Response | Promise<Response>) {
	const requests: Request[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push(request.clone());
		return handler(request);
	}) as typeof globalThis.fetch;
	return { fetch, requests };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "Content-Type": "application/json", ...init.headers },
	});
}
