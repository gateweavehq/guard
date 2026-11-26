# MCP

Guard has an MCP server, so an AI assistant can ask what is wrong in your Cloudflare account and
repositories. It is a Model Context Protocol server over Streamable HTTP at `/mcp`. The assistant
signs in as the person who allowed it, in every workspace that person belongs to. For how it is
built, see "MCP" in [architecture.md](architecture.md).

## How to connect

### The address

- Gateweave Cloud: `https://guard.gateweave.com/mcp`
- A self-hosted copy: `https://<your-guard>/mcp`. It needs `BETTER_AUTH_URL` set to your public
  address, because the sign-in an assistant does is bound to it: without that, `/mcp` answers 404.
  Apply the migrations too (`pnpm run deploy` does), since they add the tables for the sign-in.
  See [self-hosting.md](self-hosting.md).

### Sign-in

There is no key to copy. Guard signs people in with OAuth: the client registers itself, sends the
person to Guard to sign in, and asks them to allow it on a page that names the app. The scope the
server needs is `guard`. Settings, AI assistant, lists the assistants a person allowed, each with a
Take back button that ends its access at once.

### Client setup

In Claude Code:

```sh
claude mcp add --transport http guard https://guard.gateweave.com/mcp
```

In Claude.ai or another client, add the address as a remote MCP server. For a client that reads a
JSON config:

```json
{
	"mcpServers": {
		"guard": {
			"type": "http",
			"url": "https://guard.gateweave.com/mcp"
		}
	}
}
```

For a self-hosted copy, use its own address in place of `https://guard.gateweave.com/mcp`.

## Tools

Every tool but `list_workspaces` takes the workspace's slug as `workspace`; `list_workspaces` gives it. A `?`
marks an input that is optional. Output is the top-level fields of the tool's `outputSchema`, and
the outputs are loose objects, so a field may be added later. Errors come with a stable code:
`not_found`, `forbidden`, `invalid`, `rate_limited` or `upstream`.

The table is written from the server's own `tools/list`, not by hand. A test
(`apps/web/src/server/mcp/docs.test.ts`) fails when it differs. To rewrite it after changing a
tool, run:

```sh
UPDATE_MCP_DOCS=1 pnpm --filter @gateweave/guard-web exec vitest run --project unit src/server/mcp/docs.test.ts
```

<!-- mcp-tools:start -->
| Tool              | What it does                                                                                                                                                                                                                                                                                                                                                    | Input                                                                                                    | Output                                                | Needs                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
| `dismiss_finding` | Dismisses a finding, with the reason, so it leaves the open list and stays dismissed whatever later scans see.                                                                                                                                                                                                                                                  | `workspace`, `id`, `reason`                                                                              | `id`, `status`                                        | `guard` scope; owner or admin (members get `forbidden`) |
| `get_finding`     | Everything Guard knows about one finding: what it is, where, how serious, when it was first and last seen, where to read more, for a package the installed and fixed versions and the lockfile, who dismissed it and why, and the Track issue it was filed as.                                                                                                  | `workspace`, `id`                                                                                        | `finding`                                             | `guard` scope; any member                               |
| `list_findings`   | Lists the security findings of a workspace: problems Guard's scans found in its Cloudflare accounts (Security Center insights) and in the dependencies of its GitHub repositories (known vulnerabilities in lockfiles).                                                                                                                                         | `workspace`, `status?`, `severity?`, `source?`, `kind?`, `connection?`, `new_only?`, `limit?`, `cursor?` | `total`, `findings`, `nextCursor`                     | `guard` scope; any member                               |
| `list_workspaces` | Lists the Guard workspaces you belong to, with your role in each.                                                                                                                                                                                                                                                                                               | none                                                                                                     | `workspaces`                                          | `guard` scope; any member                               |
| `start_scan`      | Scans one connection (a Cloudflare account or a GitHub repository) now instead of at its next turn, and waits for the scan to finish, which can take a little while.                                                                                                                                                                                            | `workspace`, `connection`                                                                                | `connection`, `outcome`, `found`, `added`, `resolved` | `guard` scope; owner or admin (members get `forbidden`) |
| `traffic_summary` | What Cloudflare's WAF and bot features did to the requests of the workspace's connected Cloudflare zones, as the Traffic page shows it: per zone, the requests stopped or challenged each of the last 14 days and this week against the one before, what Cloudflare did over the last 7 days by action, yesterday's top rules, and the top countries and hosts. | `workspace`, `zone?`                                                                                     | `yesterday`, `connections`, `zones`                   | `guard` scope; any member                               |
<!-- mcp-tools:end -->
