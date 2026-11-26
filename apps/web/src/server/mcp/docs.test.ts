import { readFileSync, writeFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { createGuardServer, type GuardAccess } from "./tools";

// docs/mcp.md is synced to docs.gateweave.com, so its tools table is written from the server's own
// tools/list and this test fails when the file has drifted from it.
const PAGE = new URL("../../../../../docs/mcp.md", import.meta.url);
const START = "<!-- mcp-tools:start -->";
const END = "<!-- mcp-tools:end -->";
const REWRITE =
	"UPDATE_MCP_DOCS=1 pnpm --filter @gateweave/guard-web exec vitest run --project unit src/server/mcp/docs.test.ts";

/**
 * What each tool needs, by name. tools/list does not say, because the roles are decided in the
 * functions the tools call ("A token acts as the person who approved it" in architecture.md). A new
 * tool fails the test until it is listed here.
 */
const SCOPE = "`guard` scope";
const NEEDS: Record<string, string> = {
	list_workspaces: `${SCOPE}; any member`,
	list_findings: `${SCOPE}; any member`,
	get_finding: `${SCOPE}; any member`,
	dismiss_finding: `${SCOPE}; owner or admin (members get \`forbidden\`)`,
	start_scan: `${SCOPE}; owner or admin (members get \`forbidden\`)`,
	traffic_summary: `${SCOPE}; any member`,
};

type Listed = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type Schema = { properties?: Record<string, unknown>; required?: string[] };

async function listTools() {
	// tools/list never calls the access object, so nothing behind it is needed.
	const access: GuardAccess = {
		workspaces: async () => [],
		workspace: async () => null,
	};
	const handler = createMcpHandler(() => createGuardServer(access));
	const client = new Client({ name: "docs", version: "1.0.0" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL("https://guard.example.com/mcp"), {
			fetch: (url, init) => handler.fetch(new Request(url, init)),
		}),
	);
	const { tools } = await client.listTools();
	return tools;
}

const cell = (text: string) => text.replaceAll("|", String.raw`\|`).replace(/\s+/g, " ").trim();
const names = (schema: Schema | undefined, optionalMark: boolean) => {
	const required = new Set(schema?.required);
	const fields = Object.keys(schema?.properties ?? {}).map(
		(name) => `\`${name}${optionalMark && !required.has(name) ? "?" : ""}\``,
	);
	return fields.length > 0 ? fields.join(", ") : "none";
};
const firstSentence = (description: string) => {
	const text = description.replace(/\s+/g, " ").trim();
	return /^.+?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
};

function renderTable(tools: Listed[]): string {
	const rows = [...tools]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((tool) => {
			const needs = NEEDS[tool.name];
			if (needs === undefined) {
				throw new Error(
					`Tool "${tool.name}" has no entry in NEEDS (apps/web/src/server/mcp/docs.test.ts). Add what it needs: the scope and the role.`,
				);
			}
			return [
				`\`${tool.name}\``,
				cell(firstSentence(tool.description ?? "")),
				names(tool.inputSchema as Schema | undefined, true),
				names(tool.outputSchema as Schema | undefined, false),
				cell(needs),
			];
		});
	return aligned([["Tool", "What it does", "Input", "Output", "Needs"], ...rows]);
}

/** Pads every column to its widest cell, as Biome formats a Markdown table. */
function aligned(rows: string[][]): string {
	const [head = [], ...body] = rows;
	const widths = head.map((_, col) => Math.max(...rows.map((row) => [...(row[col] ?? "")].length)));
	const line = (cells: string[]) =>
		`| ${cells.map((text, col) => text.padEnd(widths[col] ?? 0)).join(" | ")} |`;
	return [line(head), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

it("keeps the tools table of docs/mcp.md equal to what the server lists", async () => {
	const tools = await listTools();
	const table = renderTable(tools);
	const page = readFileSync(PAGE, "utf8");
	const start = page.indexOf(START);
	const end = page.indexOf(END);
	expect(start, `${START} is missing from docs/mcp.md`).toBeGreaterThanOrEqual(0);
	expect(end, `${END} is missing from docs/mcp.md`).toBeGreaterThan(start);

	const block = `${START}\n${table}\n${END}`;
	const current = page.slice(start, end + END.length);
	if (process.env.UPDATE_MCP_DOCS === "1") {
		writeFileSync(
			PAGE,
			page.replace(current, () => block),
		);
		return;
	}
	expect(
		current.replaceAll("\r\n", "\n"),
		`The tools table in docs/mcp.md is out of date. Rewrite it with: ${REWRITE}`,
	).toBe(block);
});

it("lists a tool in NEEDS only when the server registers it", async () => {
	const registered = (await listTools()).map((tool) => tool.name).sort();
	expect(Object.keys(NEEDS).sort()).toEqual(registered);
});

it("fails for a tool with no entry in NEEDS", () => {
	const unknown = { name: "new_tool", description: "Does a thing.", inputSchema: {} } as Listed;
	expect(() => renderTable([unknown])).toThrow(/"new_tool" has no entry in NEEDS/);
});
