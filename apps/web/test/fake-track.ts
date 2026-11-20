/** One call to a tool of the stand-in Track, as it arrived. */
export interface TrackCall {
	tool: string;
	args: Record<string, unknown>;
}

export interface FakeTrackIssue {
	key: string;
	workspace: string;
	team: string;
	title: string;
	description: string;
	priority: string | undefined;
	labels: string[];
}

interface FakeTrackWorkspace {
	teams: { key: string; name: string }[];
	labels: string[];
}

/**
 * Stands in for Gateweave Track's MCP server (`apps/web/src/server/mcp` there): Streamable HTTP,
 * stateless as Track's `createMcpHandler` is, answering `initialize`, `get_workspace`,
 * `create_issue` and `update_issue` as Track does, including the refusals a test needs. A key is
 * valid for one workspace, as an agent member's is. `startUpstreams` serves it at `track.test`.
 */
export function startFakeTrack() {
	/** An agent key to the slug of the one workspace it works in. */
	const keys = new Map<string, string>();
	const workspaces = new Map<string, FakeTrackWorkspace>();
	const issues: FakeTrackIssue[] = [];
	const calls: TrackCall[] = [];
	/** Everything that reached the endpoint: its headers and body, as text. */
	const requests: { headers: Record<string, string>; body: string }[] = [];
	const events: { key: string; state: string; severity: string; sentAt: string; url: string }[] =
		[];
	const signals = new Map<string, string>();
	const behaviour = {
		eventStatus: 200,
		loseReply: false,
		noIssue: false,
		/** Answer `create_issue` with an HTTP error this many times first. */
		failCreates: 0,
		/** An admin set the agent to propose: what it asks for waits for a person. */
		propose: false,
		/** Answer in a JSON body instead of an event stream. */
		json: false,
		/** While set, `create_issue` answers only once it is done, as a slow Track does. */
		holdCreate: null as Promise<void> | null,
	};
	const counters = new Map<string, number>();

	const reply = (id: unknown, result: unknown) => {
		const message = JSON.stringify({ jsonrpc: "2.0", id, result });
		return behaviour.json
			? new Response(message, { headers: { "content-type": "application/json" } })
			: new Response(`event: message\ndata: ${message}\n\n`, {
					headers: { "content-type": "text/event-stream" },
				});
	};
	const toolError = (id: unknown, text: string) =>
		reply(id, { isError: true, content: [{ type: "text", text }] });
	const toolResult = (id: unknown, value: Record<string, unknown>) =>
		reply(id, {
			content: [{ type: "text", text: JSON.stringify(value) }],
			structuredContent: value,
		});

	function issueView(issue: FakeTrackIssue, proposed: boolean) {
		return {
			key: issue.key,
			title: issue.title,
			status: "todo",
			statusName: "Todo",
			priority: issue.priority ?? "none",
			labels: issue.labels,
			url: `https://track.test/${issue.workspace}/issue/${issue.key}`,
			...(proposed && { proposed: [{ change: "add_label", to: issue.labels.at(-1) ?? null }] }),
		};
	}

	async function tool(
		id: unknown,
		keyWorkspace: string,
		name: string,
		args: Record<string, unknown>,
	): Promise<Response> {
		const slug = String(args.workspace);
		const workspace = workspaces.get(slug);
		// The same answer for a workspace that is missing and one the key cannot see.
		if (!workspace || slug !== keyWorkspace) {
			return toolError(id, `Workspace "${slug}" not found. See list_workspaces.`);
		}
		const missingLabel = (labels: unknown) =>
			(Array.isArray(labels) ? labels.map(String) : []).find(
				(label) => !workspace.labels.includes(label),
			);
		switch (name) {
			case "get_workspace":
				return toolResult(id, {
					teams: workspace.teams.map((team) => ({ ...team, cycles: null, statuses: [] })),
					cycles: [],
					labels: workspace.labels.map((label) => ({ name: label, color: "#e5484d" })),
					projects: [],
					members: [],
					you: { id: "agent-1", name: "Guard", role: "agent" },
				});
			case "create_issue": {
				if (behaviour.failCreates > 0) {
					behaviour.failCreates--;
					return new Response("Internal error", { status: 500 });
				}
				await behaviour.holdCreate;
				const team = workspace.teams.find((candidate) => candidate.key === args.team);
				if (!team) return toolError(id, `Team ${String(args.team)} not found.`);
				const unknown = missingLabel(args.labels);
				if (unknown) return toolError(id, `Label "${unknown}" not found.`);
				const number = (counters.get(team.key) ?? 0) + 1;
				counters.set(team.key, number);
				const issue: FakeTrackIssue = {
					key: `${team.key}-${number}`,
					workspace: slug,
					team: team.key,
					title: String(args.title),
					description: String(args.description ?? ""),
					priority: typeof args.priority === "string" ? args.priority : undefined,
					labels: Array.isArray(args.labels) ? args.labels.map(String) : [],
				};
				issues.push(issue);
				return toolResult(id, issueView(issue, behaviour.propose));
			}
			case "update_issue": {
				const issue = issues.find((candidate) => candidate.key === args.key);
				if (!issue) return toolError(id, `Issue ${String(args.key)} not found.`);
				const unknown = missingLabel(args.add_labels);
				if (unknown) return toolError(id, `Label "${unknown}" not found.`);
				if (!behaviour.propose) {
					for (const label of (args.add_labels as string[] | undefined) ?? []) {
						if (!issue.labels.includes(label)) issue.labels.push(label);
					}
				}
				return toolResult(id, issueView(issue, behaviour.propose));
			}
			default:
				return toolError(id, `Unknown tool ${name}`);
		}
	}

	async function handler(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const body = await request.text();
		requests.push({ headers: Object.fromEntries(request.headers), body });
		if (url.pathname === "/api/events" && request.method === "POST") {
			const event = JSON.parse(body) as (typeof events)[number];
			events.push(event);
			if (behaviour.eventStatus !== 200)
				return new Response(null, {
					status: behaviour.eventStatus,
					headers: { "retry-after": "180" },
				});
			signals.set(event.key, event.state);
			if (behaviour.loseReply) return new Response(null, { status: 503 });
			return Response.json({
				state: event.state,
				filed: !behaviour.noIssue,
				issue: behaviour.noIssue
					? null
					: { key: "SRC-1", url: "https://track.test/team/issue/SRC-1" },
			});
		}
		if (url.pathname !== "/mcp" || request.method !== "POST") {
			return new Response("Not found", { status: 404 });
		}
		const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
		const keyWorkspace = bearer ? keys.get(bearer) : undefined;
		if (keyWorkspace === undefined) {
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32000, message: "Invalid agent key" }, id: null },
				{ status: 401 },
			);
		}
		const message = JSON.parse(body) as {
			id?: unknown;
			method: string;
			params?: { name?: string; arguments?: Record<string, unknown> };
		};
		if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
		if (message.method === "initialize") {
			return reply(message.id, {
				protocolVersion: "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "gateweave-track", version: "1.0.0" },
			});
		}
		if (message.method === "tools/call" && message.params?.name) {
			const args = message.params.arguments ?? {};
			calls.push({ tool: message.params.name, args });
			return tool(message.id, keyWorkspace, message.params.name, args);
		}
		return Response.json({
			jsonrpc: "2.0",
			id: message.id ?? null,
			error: { code: -32601, message: "Method not found" },
		});
	}

	return {
		host: "track.test",
		events,
		signals,
		handler,
		behaviour,
		issues,
		calls,
		requests,
		/** A workspace of Track, and the agent key that works in it. */
		addWorkspace(
			slug: string,
			key: string,
			teams: { key: string; name: string }[] = [{ key: "GRD", name: "Guard" }],
			labels: string[] = [],
		) {
			const workspace: FakeTrackWorkspace = { teams, labels };
			workspaces.set(slug, workspace);
			keys.set(key, slug);
			return workspace;
		},
		/** Forgets the issues, the calls and the behaviour, and starts numbering issues again. */
		reset() {
			issues.length = 0;
			calls.length = 0;
			requests.length = 0;
			counters.clear();
			Object.assign(behaviour, { failCreates: 0, propose: false, json: false, holdCreate: null });
		},
		/** Revokes a key, as deleting its agent does. */
		revoke(key: string) {
			keys.delete(key);
		},
	};
}

export type FakeTrack = ReturnType<typeof startFakeTrack>;
